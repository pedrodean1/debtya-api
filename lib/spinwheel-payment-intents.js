/**
 * Tras build_intents_v2 (Supabase), agrega payment_intents en borrador para deudas Spinwheel,
 * ordenadas como el plan del usuario (avalanche / snowball) usando balance, minimum_payment y apr.
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
      skipped += 1;
      continue;
    }

    extBusy.add(ext);
    created.push(ins);
  }

  return {
    appended: created.length,
    skipped,
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
