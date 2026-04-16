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
 * Solo valida claves presentes en patch (p. ej. antes de UPDATE).
 * @param {Record<string, unknown>} patch
 * @returns {string|null}
 */
function validateDebtPatch(patch) {
  if (patch.balance !== undefined) {
    if (!Number.isFinite(patch.balance) || patch.balance < 0 || patch.balance > MAX_MONEY) {
      return "balance inválido";
    }
  }
  if (patch.minimum_payment !== undefined) {
    if (
      !Number.isFinite(patch.minimum_payment) ||
      patch.minimum_payment < 0 ||
      patch.minimum_payment > MAX_MONEY
    ) {
      return "minimum_payment inválido";
    }
  }
  if (patch.apr !== undefined) {
    if (!Number.isFinite(patch.apr) || patch.apr < 0 || patch.apr > 2000) {
      return "apr inválido";
    }
  }
  if (patch.due_day !== undefined && patch.due_day !== null) {
    const d = Number(patch.due_day);
    if (!Number.isInteger(d) || d < 0 || d > 31) {
      return "due_day inválido";
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} patch — campos a persistir en micro_rules
 * @returns {string|null}
 */
function validateRulePatch(patch) {
  if (patch.fixed_amount !== undefined) {
    const n = patch.fixed_amount;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return "fixed_amount inválido";
  }
  if (patch.percent !== undefined) {
    const n = patch.percent;
    if (!Number.isFinite(n) || n < 0 || n > 1000) return "percent inválido";
  }
  if (patch.roundup_to !== undefined) {
    const n = patch.roundup_to;
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) return "roundup_to inválido";
  }
  if (patch.min_purchase_amount !== undefined) {
    const n = patch.min_purchase_amount;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return "min_purchase_amount inválido";
  }
  if (patch.cap_daily !== undefined && patch.cap_daily !== null) {
    const n = patch.cap_daily;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return "cap_daily inválido";
  }
  if (patch.cap_weekly !== undefined && patch.cap_weekly !== null) {
    const n = patch.cap_weekly;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return "cap_weekly inválido";
  }
  if (patch.payout_min_threshold !== undefined) {
    const n = patch.payout_min_threshold;
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return "payout_min_threshold inválido";
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
  validateDebtPatch,
  validateRulePatch,
  validatePaymentIntentCreate,
  validateIntentRouteParamId
};
