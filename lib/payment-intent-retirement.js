const RETIRED_PAYMENT_INTENT_STATUS_CANDIDATES = ["cancelled", "canceled"];
const VIRTUAL_RETIRED_PAYMENT_INTENT_STATUS = "cancelled";

function isPaymentIntentStatusCheckError(error) {
  if (!error) return false;
  const text = [
    error.code,
    error.message,
    error.details,
    error.hint,
    error.constraint
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("payment_intents_status_check") ||
    (text.includes("violates check constraint") && text.includes("payment_intents")) ||
    (String(error.code || "") === "23514" && text.includes("status"))
  );
}

function applyPaymentIntentRetireFilters(query, { userId, intentId, openStatuses } = {}) {
  let q = query.eq("id", intentId);
  if (userId != null) q = q.eq("user_id", userId);
  if (Array.isArray(openStatuses) && openStatuses.length) q = q.in("status", openStatuses);
  return q;
}

async function updatePaymentIntentAsRetired({
  supabaseAdmin,
  userId,
  intentId,
  openStatuses,
  payload,
  statusCandidates = RETIRED_PAYMENT_INTENT_STATUS_CANDIDATES
}) {
  if (!supabaseAdmin) throw new Error("Supabase no configurado");
  const basePayload = { ...(payload || {}) };
  delete basePayload.status;

  let lastStatusError = null;
  for (const status of statusCandidates) {
    const { error } = await applyPaymentIntentRetireFilters(
      supabaseAdmin.from("payment_intents").update({
        ...basePayload,
        status
      }),
      { userId, intentId, openStatuses }
    );
    if (!error) return { ok: true, status, metadata_only: false };
    if (!isPaymentIntentStatusCheckError(error)) throw error;
    lastStatusError = error;
  }

  const metadataOnlyPayload = {
    ...basePayload,
    metadata:
      basePayload.metadata && typeof basePayload.metadata === "object" && !Array.isArray(basePayload.metadata)
        ? {
            ...basePayload.metadata,
            payment_intent_retired_status_fallback: "metadata_only"
          }
        : basePayload.metadata
  };

  const { error } = await applyPaymentIntentRetireFilters(
    supabaseAdmin.from("payment_intents").update(metadataOnlyPayload),
    { userId, intentId, openStatuses }
  );
  if (error) throw error;

  return {
    ok: true,
    status: null,
    metadata_only: true,
    status_error_code: lastStatusError?.code || null
  };
}

module.exports = {
  RETIRED_PAYMENT_INTENT_STATUS_CANDIDATES,
  VIRTUAL_RETIRED_PAYMENT_INTENT_STATUS,
  isPaymentIntentStatusCheckError,
  updatePaymentIntentAsRetired
};
