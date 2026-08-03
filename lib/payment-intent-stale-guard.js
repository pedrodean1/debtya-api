const { PAID_BALANCE_THRESHOLD, debtRowEligibleForPlan } = require("./debt-paid-helpers");
const {
  VIRTUAL_RETIRED_PAYMENT_INTENT_STATUS,
  updatePaymentIntentAsRetired
} = require("./payment-intent-retirement");

const STALE_PAYMENT_INTENT_OPEN_STATUSES = [
  "pending_review",
  "approved",
  "built",
  "ready",
  "draft",
  "pending",
  "queued",
  "proposed"
];

function normalizeStatus(value) {
  return String(value || "").toLowerCase().trim();
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function paymentIntentOpenForDebtGuard(intent) {
  return STALE_PAYMENT_INTENT_OPEN_STATUSES.includes(normalizeStatus(intent?.status));
}

function paymentIntentDebtId(intent) {
  const raw = intent?.debt_id ?? intent?.target_debt_id ?? null;
  const s = raw != null ? String(raw).trim() : "";
  return s || null;
}

function paymentIntentAlreadyRetiredByGuard(intent) {
  const metadata = normalizeMetadata(intent?.metadata);
  return Boolean(metadata.stale_intent_retired_at && metadata.stale_intent_retired_reason);
}

function stalePaymentIntentDebtReason(debt, safeNumber) {
  if (!debt) return "debt_missing";
  if (debt.is_active === false) return "debt_inactive";
  const status = normalizeStatus(debt.status || "active");
  if (status === "paid" || status === "paid_off") return "debt_paid";
  if (status === "archived") return "debt_archived";
  const balance = safeNumber(debt.balance ?? debt.current_balance, 0);
  if (balance <= PAID_BALANCE_THRESHOLD) return "debt_zero_balance";
  if (!debtRowEligibleForPlan(debt, safeNumber)) return "debt_not_eligible";
  return null;
}

function buildRetiredIntentRow(intent, debt, reason, nowIso, safeNumber, status = VIRTUAL_RETIRED_PAYMENT_INTENT_STATUS) {
  const metadata = {
    ...normalizeMetadata(intent.metadata),
    stale_intent_retired_at: nowIso,
    stale_intent_retired_reason: reason
  };
  if (debt) {
    metadata.stale_intent_debt_status = debt.status || null;
    metadata.stale_intent_debt_balance = safeNumber(debt.balance ?? debt.current_balance, 0);
  }
  return {
    ...intent,
    status,
    updated_at: nowIso,
    notes: "Retirado por DebtYa: la deuda ya no esta activa para pago.",
    metadata
  };
}

async function retireStaleOpenPaymentIntentsForInactiveDebts({
  userId,
  intents,
  supabaseAdmin,
  safeNumber,
  nowIso = new Date().toISOString()
}) {
  const rows = Array.isArray(intents) ? intents : [];
  const openDebtRows = rows
    .filter((intent) => paymentIntentOpenForDebtGuard(intent))
    .map((intent) => ({ intent, debtId: paymentIntentDebtId(intent) }))
    .filter((x) => x.debtId);

  if (!openDebtRows.length) {
    return { intents: rows, retired_count: 0, reason_counts: {} };
  }

  const debtIds = [...new Set(openDebtRows.map((x) => x.debtId))];
  const { data: debtRows, error: debtErr } = await supabaseAdmin
    .from("debts")
    .select("id,status,balance,is_active")
    .eq("user_id", userId)
    .in("id", debtIds);

  if (debtErr) throw debtErr;

  const debtById = new Map((debtRows || []).map((debt) => [String(debt.id), debt]));
  const retiredById = new Map();
  const reasonCounts = {};
  let retiredCount = 0;
  let statusFallbackCount = 0;

  for (const { intent, debtId } of openDebtRows) {
    const debt = debtById.get(String(debtId)) || null;
    const reason = stalePaymentIntentDebtReason(debt, safeNumber);
    if (!reason) continue;

    if (paymentIntentAlreadyRetiredByGuard(intent)) {
      const existingReason = normalizeMetadata(intent.metadata).stale_intent_retired_reason || reason;
      retiredById.set(
        String(intent.id),
        buildRetiredIntentRow(
          intent,
          debt,
          existingReason,
          normalizeMetadata(intent.metadata).stale_intent_retired_at || nowIso,
          safeNumber
        )
      );
      continue;
    }

    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    const retired = buildRetiredIntentRow(intent, debt, reason, nowIso, safeNumber);
    const retireResult = await updatePaymentIntentAsRetired({
      supabaseAdmin,
      userId,
      intentId: intent.id,
      openStatuses: STALE_PAYMENT_INTENT_OPEN_STATUSES,
      payload: {
        updated_at: retired.updated_at,
        notes: retired.notes,
        metadata: retired.metadata
      }
    });

    const responseStatus = retireResult.status || VIRTUAL_RETIRED_PAYMENT_INTENT_STATUS;
    if (retireResult.metadata_only) statusFallbackCount += 1;
    retiredCount += 1;
    retiredById.set(String(intent.id), { ...retired, status: responseStatus });
  }

  const nextRows = rows.map((intent) => {
    const id = intent?.id != null ? String(intent.id) : "";
    return retiredById.get(id) || intent;
  });

  return {
    intents: nextRows,
    retired_count: retiredCount,
    reason_counts: reasonCounts,
    ...(statusFallbackCount > 0 ? { status_fallback_count: statusFallbackCount } : {})
  };
}

module.exports = {
  STALE_PAYMENT_INTENT_OPEN_STATUSES,
  paymentIntentDebtId,
  paymentIntentOpenForDebtGuard,
  paymentIntentAlreadyRetiredByGuard,
  stalePaymentIntentDebtReason,
  retireStaleOpenPaymentIntentsForInactiveDebts
};
