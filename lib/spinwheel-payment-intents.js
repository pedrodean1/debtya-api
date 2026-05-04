/**
 * Tras build_intents_v2 (Supabase), agrega payment_intents en borrador para deudas Spinwheel,
 * ordenadas como el plan del usuario (avalanche / snowball) usando balance, minimum_payment y apr.
 *
 * `skipped_details[].reason` (debug, sin cambiar criterios de append):
 * existing_intent | missing_external_id | missing_balance | zero_balance | invalid_amount | other
 * Con other: error_message, error_code, error_details (PostgREST; truncados).
 * Reservados por si amplías filtros más adelante: inactive_debt | payment_not_capable | no_plan
 */

const OPEN_SPINWHEEL_BLOCK = ["draft", "pending", "built", "proposed", "ready", "pending_review", "approved", "queued"];

/**
 * @param {object[]} debts
 * @param {string} strategy avalanche | snowball
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function sortSpinwheelDebtsLikePlan(debts, strategy, safeNumber) {
  const out = [...debts];
  const s = String(strategy || "avalanche").toLowerCase();
  if (s === "snowball") {
    out.sort((a, b) => safeNumber(a.balance) - safeNumber(b.balance));
    return out;
  }
  out.sort((a, b) => {
    const aprDiff = safeNumber(b.apr) - safeNumber(a.apr);
    if (aprDiff !== 0) return aprDiff;
    return safeNumber(b.balance) - safeNumber(a.balance);
  });
  return out;
}

const SPINWHEEL_SKIP_ERR_MAX = 480;

/**
 * Campos del error PostgREST/Supabase para debug (truncados; sin payload de fila).
 * @param {unknown} err
 * @returns {{ error_message: string|null, error_code: string|null, error_details: string|null }}
 */
function spinwheelIntentInsertErrorDebug(err) {
  if (!err || typeof err !== "object") {
    return { error_message: null, error_code: null, error_details: null };
  }
  const o = /** @type {Record<string, unknown>} */ (err);
  const code = o.code != null && String(o.code).trim() ? String(o.code).trim().slice(0, 64) : null;
  const msg = o.message != null ? String(o.message).trim().slice(0, SPINWHEEL_SKIP_ERR_MAX) : null;
  const details = o.details != null ? String(o.details).trim().slice(0, SPINWHEEL_SKIP_ERR_MAX) : null;
  const hint = o.hint != null ? String(o.hint).trim().slice(0, SPINWHEEL_SKIP_ERR_MAX) : null;
  const parts = [details, hint].filter((x) => x && String(x).length > 0);
  const merged = parts.length ? parts.join(" | ").slice(0, SPINWHEEL_SKIP_ERR_MAX) : null;
  return {
    error_message: msg && msg.length ? msg : null,
    error_code: code,
    error_details: merged
  };
}

/**
 * @param {object} d
 * @param {string} reason
 * @param {{ skipped: number, skipped_details: object[] }} acc
 * @param {unknown} [insertErr] solo cuando reason === "other"
 */
function recordSpinwheelIntentSkip(d, reason, acc, insertErr) {
  acc.skipped += 1;
  const row = {
    debt_id: d && d.id != null ? d.id : null,
    name: d && d.name != null ? String(d.name) : "",
    spinwheel_external_id:
      d && d.spinwheel_external_id != null && String(d.spinwheel_external_id).trim()
        ? String(d.spinwheel_external_id).trim()
        : null,
    reason
  };
  if (reason === "other" && insertErr) {
    const dbg = spinwheelIntentInsertErrorDebug(insertErr);
    if (dbg.error_message) row.error_message = dbg.error_message;
    if (dbg.error_code) row.error_code = dbg.error_code;
    if (dbg.error_details) row.error_details = dbg.error_details;
  }
  acc.skipped_details.push(row);
}

/**
 * @param {unknown} rawBal
 * @param {number} bal
 * @param {number} rounded
 */
function spinwheelIntentAmountSkipReason(rawBal, bal, rounded) {
  if (!Number.isFinite(rounded) || rounded <= 0) {
    if (rawBal == null || (typeof rawBal === "string" && !String(rawBal).trim())) {
      return "missing_balance";
    }
    if (bal <= 0) return "zero_balance";
    return "invalid_amount";
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabaseAdmin
 * @param {string} userId
 * @param {{
 *   safeNumber: (v: unknown, fb?: number) => number,
 *   getCurrentPaymentPlan: (uid: string) => Promise<object|null>
 * }} opts
 */
async function appendSpinwheelPaymentIntents(supabaseAdmin, userId, opts) {
  const { safeNumber, getCurrentPaymentPlan } = opts;
  const now = new Date().toISOString();
  const scheduledFor = now.slice(0, 10);

  const skipAcc = { skipped: 0, skipped_details: [] };

  const { data: debtRows, error: debtErr } = await supabaseAdmin
    .from("debts")
    .select("id,name,balance,minimum_payment,apr,spinwheel_external_id,payment_capable,is_active,source")
    .eq("user_id", userId)
    .eq("source", "spinwheel")
    .eq("is_active", true)
    .gt("balance", 0);

  if (debtErr) throw debtErr;

  const allRows = debtRows || [];
  for (const d of allRows) {
    if (!d) continue;
    if (d.spinwheel_external_id == null || !String(d.spinwheel_external_id).trim()) {
      recordSpinwheelIntentSkip(d, "missing_external_id", skipAcc);
    }
  }

  const debts = allRows.filter(
    (d) => d && d.spinwheel_external_id != null && String(d.spinwheel_external_id).trim()
  );

  if (!debts.length) {
    return {
      appended: 0,
      skipped: skipAcc.skipped,
      skipped_details: skipAcc.skipped_details,
      intents: [],
      strategy: "avalanche"
    };
  }

  let plan = null;
  try {
    plan = await getCurrentPaymentPlan(userId);
  } catch {
    plan = null;
  }
  const strategy = String(plan?.strategy || "avalanche").toLowerCase();
  const sorted = sortSpinwheelDebtsLikePlan(debts, strategy, safeNumber);

  const { data: openSw, error: openErr } = await supabaseAdmin
    .from("payment_intents")
    .select("external_id,status")
    .eq("user_id", userId)
    .eq("source", "spinwheel")
    .in("status", OPEN_SPINWHEEL_BLOCK);

  if (openErr) throw openErr;

  const extBusy = new Set(
    (openSw || [])
      .map((r) => (r.external_id != null ? String(r.external_id).trim() : ""))
      .filter(Boolean)
  );

  const created = [];

  for (const d of sorted) {
    const ext = String(d.spinwheel_external_id).trim();
    if (extBusy.has(ext)) {
      recordSpinwheelIntentSkip(d, "existing_intent", skipAcc);
      continue;
    }

    const rawBal = d.balance;
    const bal = safeNumber(rawBal);
    const minPay = Math.max(0, safeNumber(d.minimum_payment));
    const amount =
      minPay > 0 ? Math.min(minPay, bal) : Math.min(bal, Math.max(1, Number((bal * 0.01).toFixed(2))));
    const rounded = Number(amount.toFixed(2));
    const amtReason = spinwheelIntentAmountSkipReason(rawBal, bal, rounded);
    if (amtReason) {
      recordSpinwheelIntentSkip(d, amtReason, skipAcc);
      continue;
    }

    const interestRate = safeNumber(d.apr);
    const row = {
      user_id: userId,
      debt_id: d.id,
      strategy: strategy === "snowball" ? "snowball" : "avalanche",
      amount: rounded,
      total_amount: rounded,
      status: "pending",
      execution_mode: "safe",
      /* Mismo literal que buildPaymentIntentsInternal → payment_intents en backup_estable_2026-03-23_23-25/server.js (único insert explícito con execution_frequency en el repo). */
      execution_frequency: "daily",
      scheduled_for: scheduledFor,
      notes: "Spinwheel — intent de planificación (sin pago automático)",
      source: "spinwheel",
      external_id: ext,
      metadata: {
        spinwheel: true,
        spinwheel_payment_capable: d.payment_capable === true,
        interest_rate: interestRate,
        balance_snapshot: bal,
        minimum_payment_snapshot: minPay
      },
      updated_at: now
    };

    const { data: ins, error: insErr } = await supabaseAdmin.from("payment_intents").insert(row).select("id").single();

    if (insErr) {
      const msg = String(insErr.message || insErr.details || "");
      const dup =
        insErr.code === "23505" || /duplicate key|unique constraint/i.test(msg);
      recordSpinwheelIntentSkip(d, dup ? "existing_intent" : "other", skipAcc, dup ? undefined : insErr);
      continue;
    }

    extBusy.add(ext);
    created.push(ins);
  }

  return {
    appended: created.length,
    skipped: skipAcc.skipped,
    skipped_details: skipAcc.skipped_details,
    intents: created,
    strategy
  };
}

function isSpinwheelPlanningIntent(intent) {
  return String(intent?.source || "").toLowerCase() === "spinwheel";
}

module.exports = {
  appendSpinwheelPaymentIntents,
  sortSpinwheelDebtsLikePlan,
  isSpinwheelPlanningIntent,
  OPEN_SPINWHEEL_BLOCK
};
