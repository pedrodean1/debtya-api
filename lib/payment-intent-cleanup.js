const {
  STALE_PAYMENT_INTENT_OPEN_STATUSES,
  retireStaleOpenPaymentIntentsForInactiveDebts
} = require("./payment-intent-stale-guard");

const DEFAULT_CLEANUP_LIMIT = 250;
const MAX_CLEANUP_LIMIT = 1000;

function clampCleanupLimit(value, safeNumber) {
  const raw = safeNumber(value, DEFAULT_CLEANUP_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CLEANUP_LIMIT;
  return Math.min(MAX_CLEANUP_LIMIT, Math.max(1, Math.floor(raw)));
}

function addReasonCounts(target, source) {
  for (const [reason, count] of Object.entries(source || {})) {
    target[reason] = (target[reason] || 0) + Number(count || 0);
  }
}

function groupIntentsByUser(intents) {
  const grouped = new Map();
  for (const intent of intents || []) {
    const userId = intent?.user_id ? String(intent.user_id) : "";
    if (!userId) continue;
    if (!grouped.has(userId)) grouped.set(userId, []);
    grouped.get(userId).push(intent);
  }
  return grouped;
}

async function runPaymentIntentCleanup({
  supabaseAdmin,
  safeNumber = Number,
  limit,
  nowIso = new Date().toISOString()
}) {
  if (!supabaseAdmin) throw new Error("Supabase no configurado");
  const scanLimit = clampCleanupLimit(limit, safeNumber);

  const { data: intentRows, error: intentErr } = await supabaseAdmin
    .from("payment_intents")
    .select("id,user_id,debt_id,status,metadata,updated_at,created_at")
    .in("status", STALE_PAYMENT_INTENT_OPEN_STATUSES)
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(scanLimit);

  if (intentErr) throw intentErr;

  const intents = intentRows || [];
  const grouped = groupIntentsByUser(intents);
  const summary = {
    ok: true,
    limit: scanLimit,
    users_scanned: grouped.size,
    intents_scanned: intents.length,
    retired_count: 0,
    status_fallback_count: 0,
    failures: 0,
    reason_counts: {}
  };

  for (const [userId, userIntents] of grouped.entries()) {
    try {
      const result = await retireStaleOpenPaymentIntentsForInactiveDebts({
        userId,
        intents: userIntents,
        supabaseAdmin,
        safeNumber,
        nowIso
      });
      summary.retired_count += result.retired_count || 0;
      summary.status_fallback_count += result.status_fallback_count || 0;
      addReasonCounts(summary.reason_counts, result.reason_counts);
    } catch (_) {
      summary.failures += 1;
    }
  }

  return summary;
}

module.exports = {
  DEFAULT_CLEANUP_LIMIT,
  MAX_CLEANUP_LIMIT,
  clampCleanupLimit,
  groupIntentsByUser,
  runPaymentIntentCleanup
};
