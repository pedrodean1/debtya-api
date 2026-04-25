/**
 * Tras build_intents_v2 (Supabase), agrega payment_intents en borrador para deudas Spinwheel,
 * ordenadas como el plan del usuario (avalanche / snowball) usando balance, minimum_payment y apr.
 */

const OPEN_SPINWHEEL_BLOCK = ["draft", "pending", "built", "proposed", "ready", "pending_review", "approved", "queued"];

function formatPostgrestError(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  const e = /** @type {any} */ (error);
  return [e.message, e.details, e.hint, e.code].filter(Boolean).join(" | ");
}

function extractMissingColumnFromError(error) {
  const msg = formatPostgrestError(error);
  const patterns = [
    /column ['"]?([a-zA-Z0-9_]+)['"]?/i,
    /['"]([a-zA-Z0-9_]+)['"]\s+column/i
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m && m[1]) return String(m[1]);
  }
  return "";
}

function maybePatchNotNullColumn(payload, error, nowIso) {
  const e = /** @type {any} */ (error || {});
  if (String(e.code || "") !== "23502") return false;
  const col = String(e.column || extractMissingColumnFromError(e) || "").trim();
  if (!col) return false;
  if (payload[col] !== undefined && payload[col] !== null) return false;
  if (col === "execution_mode") payload[col] = "safe";
  else if (col === "execution_frequency") payload[col] = "daily";
  else if (col === "approval_required") payload[col] = true;
  else if (col === "created_at") payload[col] = nowIso;
  else if (col === "updated_at") payload[col] = nowIso;
  else if (col === "status") payload[col] = "draft";
  else return false;
  return true;
}

async function insertSpinwheelIntentResilient(supabaseAdmin, row, nowIso) {
  const work = { ...row };
  let attempts = 0;
  while (attempts < 12) {
    attempts += 1;
    const r = await supabaseAdmin.from("payment_intents").insert(work).select("id").single();
    if (!r.error) return r;
    const col = extractMissingColumnFromError(r.error);
    const errCode = String((/** @type {any} */ (r.error)).code || "").toUpperCase();
    if (
      (errCode === "42703" || errCode === "PGRST204") &&
      col &&
      Object.prototype.hasOwnProperty.call(work, col)
    ) {
      delete work[col];
      continue;
    }
    if (maybePatchNotNullColumn(work, r.error, nowIso)) {
      continue;
    }
    return r;
  }
  return {
    data: null,
    error: { message: "No se pudo insertar intent Spinwheel tras varios reintentos de compatibilidad." }
  };
}

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

  const { data: debtRows, error: debtErr } = await supabaseAdmin
    .from("debts")
    .select("id,balance,minimum_payment,apr,spinwheel_external_id,payment_capable,is_active,source")
    .eq("user_id", userId)
    .eq("source", "spinwheel")
    .eq("is_active", true)
    .gt("balance", 0);

  if (debtErr) throw debtErr;

  const debts = (debtRows || []).filter(
    (d) => d && d.spinwheel_external_id != null && String(d.spinwheel_external_id).trim()
  );

  if (!debts.length) {
    return { appended: 0, skipped: 0, intents: [], strategy: "avalanche" };
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
  let skipped = 0;
  const errors = [];

  for (const d of sorted) {
    const ext = String(d.spinwheel_external_id).trim();
    if (extBusy.has(ext)) {
      skipped += 1;
      continue;
    }

    const bal = safeNumber(d.balance);
    const minPay = Math.max(0, safeNumber(d.minimum_payment));
    const amount =
      minPay > 0 ? Math.min(minPay, bal) : Math.min(bal, Math.max(1, Number((bal * 0.01).toFixed(2))));
    const rounded = Number(amount.toFixed(2));
    if (!Number.isFinite(rounded) || rounded <= 0) {
      skipped += 1;
      continue;
    }

    const interestRate = safeNumber(d.apr);
    const row = {
      user_id: userId,
      debt_id: d.id,
      strategy: strategy === "snowball" ? "snowball" : "avalanche",
      amount: rounded,
      total_amount: rounded,
      status: "draft",
      scheduled_for: scheduledFor,
      notes: "Spinwheel planning intent (execution disabled until payment rail is connected)",
      source: "spinwheel",
      external_id: ext,
      execution_mode: "safe",
      execution_frequency: "daily",
      approval_required: true,
      metadata: {
        spinwheel: true,
        spinwheel_payment_capable: d.payment_capable === true,
        interest_rate: interestRate,
        balance_snapshot: bal,
        minimum_payment_snapshot: minPay
      },
      created_at: now,
      updated_at: now
    };

    const { data: ins, error: insErr } = await insertSpinwheelIntentResilient(supabaseAdmin, row, now);

    if (insErr) {
      skipped += 1;
      errors.push({
        debt_id: d.id,
        external_id: ext,
        reason: formatPostgrestError(insErr) || "insert_failed"
      });
      continue;
    }

    extBusy.add(ext);
    created.push(ins);
  }

  return {
    appended: created.length,
    skipped,
    intents: created,
    strategy,
    errors: errors.slice(0, 5)
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
