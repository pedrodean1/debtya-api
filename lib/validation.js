const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MONEY = 1e14;

function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}

/**
 * @param {object} payload — ya con números normalizados (p. ej. safeNumber)
 * @returns {string|null} mensaje de error o null si OK
 */
function validateDebtCreatePayload(payload) {
  if (!Number.isFinite(payload.balance) || payload.balance < 0 || payload.balance > MAX_MONEY) {
    return "balance inválido";
  }
  if (
    !Number.isFinite(payload.minimum_payment) ||
    payload.minimum_payment < 0 ||
    payload.minimum_payment > MAX_MONEY
  ) {
    return "minimum_payment inválido";
  }
  if (!Number.isFinite(payload.apr) || payload.apr < 0 || payload.apr > 2000) {
    return "apr inválido";
  }
  return null;
}

/**
 * @param {object} body — req.body crudo
 * @param {(v: unknown, fb?: number) => number} safeNumber
 * @returns {string|null}
 */
function validatePaymentIntentCreate(body, safeNumber) {
  const amount = safeNumber(body?.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_MONEY) {
    return "amount inválido";
  }
  const debtId = body?.debt_id;
  if (debtId !== null && debtId !== undefined && String(debtId).trim() !== "" && !isUuid(debtId)) {
    return "debt_id inválido";
  }
  const src = body?.source_account_id;
  if (src !== null && src !== undefined && String(src).trim() !== "" && !isUuid(src)) {
    return "source_account_id inválido";
  }
  return null;
}

/**
 * @returns {string|null}
 */
function validateIntentRouteParamId(intentId) {
  if (!intentId || !isUuid(String(intentId))) {
    return "intent id inválido";
  }
  return null;
}

module.exports = {
  isUuid,
  validateDebtCreatePayload,
  validatePaymentIntentCreate,
  validateIntentRouteParamId
};
