const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MONEY = 1e14;

const DEBT_SOURCES = new Set(["manual", "plaid", "method"]);

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
  const src = payload.source != null ? String(payload.source) : "manual";
  if (!DEBT_SOURCES.has(src)) {
    return "source inválido";
  }
  if (src === "method") {
    const mid = payload.method_account_id != null ? String(payload.method_account_id).trim() : "";
    if (!mid) {
      return "method_account_id requerido cuando source es method";
    }
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
  if (patch.source !== undefined && patch.source !== null) {
    if (!DEBT_SOURCES.has(String(patch.source))) {
      return "source inválido";
    }
  }
  if (patch.method_account_id !== undefined && patch.method_account_id !== null) {
    const mid = String(patch.method_account_id).trim();
    if (!mid) {
      return "method_account_id inválido";
    }
  }
  if (patch.method_entity_id !== undefined && patch.method_entity_id !== null) {
    const eid = String(patch.method_entity_id).trim();
    if (!eid) {
      return "method_entity_id inválido";
    }
  }
  if (patch.payment_capable !== undefined && typeof patch.payment_capable !== "boolean") {
    return "payment_capable inválido";
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
/**
 * Valida IDs de deuda en el body antes de `buildMicroRulePayload` (evita UUID inválido -> null silencioso).
 * @param {object} body
 * @returns {string|null}
 */
function validateRuleCreateBody(body) {
  const b = body || {};
  const config = b.config_json || b.config || {};
  const targetDebtId =
    b.target_debt_id !== undefined
      ? b.target_debt_id || null
      : config.target_debt_id !== undefined
      ? config.target_debt_id || null
      : b.debt_id !== undefined
      ? b.debt_id || null
      : null;

  if (
    targetDebtId !== null &&
    targetDebtId !== undefined &&
    String(targetDebtId).trim() !== "" &&
    !isUuid(targetDebtId)
  ) {
    return "target_debt_id inválido";
  }
  return null;
}

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
  if (patch.target_debt_id !== undefined && patch.target_debt_id !== null && !isUuid(patch.target_debt_id)) {
    return "target_debt_id inválido";
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
  DEBT_SOURCES,
  validateDebtCreatePayload,
  validateDebtPatch,
  validateRuleCreateBody,
  validateRulePatch,
  validatePaymentIntentCreate,
  validateIntentRouteParamId
};
