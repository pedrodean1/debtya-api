/**
 * Preparación y validación de pagos Spinwheel (sandbox).
 *
 * Documentación de referencia (Embedded Payments / bill pay):
 * - Flujo general: https://docs.spinwheel.io/docs/payments-process
 *   (partner payer / funding, consentimiento del usuario, verificación de cuenta,
 *    comprobación de capacidad de pago de la liability, solicitud de pago).
 * - Crear solicitud de pago (forma típica DIMs): POST …/v1/payments/requests
 *   https://docs.spinwheel.io/reference/create-request-1
 *   Campos habituales: userId, extRequestId, amount, payerId, requestType (ONE_TIME | RECURRING), etc.
 * - Funding hacia plataforma: POST …/v1/payments/paymentToPlatform
 *   https://docs.spinwheel.io/reference/payment-to-platform-1
 *
 * Requisitos típicos antes de ejecutar: funding account verificado, consentimiento (EUA),
 * KBA / verificación según producto, y comprobar billPayment en la liability.
 *
 * `createSpinwheelPaymentIntent` solo construye un payload de trabajo (no llama a Spinwheel).
 *
 * `validateSpinwheelPaymentPayload` envía un cuerpo al **host sandbox** (por defecto
 * `https://sandbox-api.spinwheel.io`) usando el mismo contrato que “create payment request”.
 * Spinwheel no documenta un endpoint separado solo de “preview”; en sandbox no es dinero real
 * de producción, pero una respuesta 2xx puede crear una **solicitud** en sandbox. No hay paso
 * adicional de “execute” desde este módulo.
 */

const crypto = require("crypto");
const { spinwheelErrorMessageFromJson } = require("./spinwheel-client");
const { readSpinwheelApiSecret } = require("./spinwheel-env");

const SPINWHEEL_LIABILITY_ID_FIELDS = new Set([
  "creditCardId",
  "studentLoanId",
  "homeLoanId",
  "autoLoanId",
  "personalLoanId",
  "bankAccountId"
]);

function stripEnv(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function readPaymentValidateBaseUrl() {
  const o = stripEnv(process.env.SPINWHEEL_PAYMENT_VALIDATE_BASE_URL || "");
  if (o) return o.replace(/\/+$/, "");
  return "https://sandbox-api.spinwheel.io";
}

function readPaymentValidatePath() {
  const p = stripEnv(process.env.SPINWHEEL_PAYMENT_VALIDATE_PATH || "/v1/payments/requests");
  return p.startsWith("/") ? p : `/${p}`;
}

function readSandboxPayerId() {
  return stripEnv(process.env.SPINWHEEL_SANDBOX_PAYER_ID || process.env.DEBTYA_SPINWHEEL_SANDBOX_PAYER_ID || "");
}

function readLiabilityFieldForPayment() {
  const f = stripEnv(process.env.SPINWHEEL_PAYMENT_LIABILITY_FIELD || "creditCardId");
  return SPINWHEEL_LIABILITY_ID_FIELDS.has(f) ? f : "creditCardId";
}

function looksLikeUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || "").trim());
}

/**
 * @param {object} intent Fila `payment_intents` de DebtYa
 * @param {{ debtyaUserId: string, spinwheelUserId: string, safeNumber: (v: unknown, fb?: number) => number }} ctx
 * @returns {{ payload: object, payload_preview: object }}
 */
function createSpinwheelPaymentIntent(intent, ctx) {
  const debtyaUserId = String(ctx.debtyaUserId || "").trim();
  const spinwheelUserId = String(ctx.spinwheelUserId || "").trim();
  const safeNumber = ctx.safeNumber;

  const amount = safeNumber(intent?.total_amount ?? intent?.amount, 0);
  const liabilityExternalId = String(intent?.external_id || "").trim();
  const debtId = intent?.debt_id != null ? String(intent.debt_id).trim() : "";

  const payload = {
    _debtya_prep: true,
    _note: "NOT_SENT — Spinwheel API not called (DebtYa prep only)",
    debtya_intent_id: intent?.id != null ? String(intent.id) : null,
    debtya_user_id: debtyaUserId,
    spinwheel_user_id: spinwheelUserId,
    amount,
    liability_external_id: liabilityExternalId,
    debt_id: debtId || null,
    /** Forma orientativa al contrato real; payerId / useOfFundsId / funding se rellenan al integrar */
    suggested_spinwheel_request: {
      userId: spinwheelUserId,
      extRequestId: intent?.id != null ? String(intent.id) : null,
      amount: amount > 0 ? Number(amount.toFixed(2)) : 0,
      requestType: "ONE_TIME"
    }
  };

  const payload_preview = {
    debtya_intent_id: payload.debtya_intent_id,
    debtya_user_id: debtyaUserId,
    spinwheel_user_id: spinwheelUserId,
    amount: payload.amount,
    liability_external_id: liabilityExternalId || null,
    debt_id: payload.debt_id,
    suggested_spinwheel_request: payload.suggested_spinwheel_request
  };

  console.log("[Spinwheel]", "Spinwheel payment payload ready", JSON.stringify(payload_preview));

  return { payload, payload_preview };
}

/**
 * Arma el JSON que enviaríamos a POST /v1/payments/requests a partir del payload de prep.
 * `payerId` sale de SPINWHEEL_SANDBOX_PAYER_ID (requerido en la mayoría de entornos reales).
 *
 * @param {object} payload Salida de `createSpinwheelPaymentIntent` (campo `payload`)
 * @returns {object}
 */
function buildSpinwheelPaymentRequestFromPrepPayload(payload) {
  const sug = payload && typeof payload === "object" ? payload.suggested_spinwheel_request || {} : {};
  const liabilityExternalId = String(payload.liability_external_id || "").trim();
  const field = readLiabilityFieldForPayment();
  const alloc = { percentage: 100 };
  if (looksLikeUuid(liabilityExternalId)) {
    alloc[field] = liabilityExternalId;
  } else {
    alloc[field] = liabilityExternalId;
  }

  const payerId = readSandboxPayerId();
  const amount = Number(sug.amount);
  const body = {
    extRequestId: crypto.randomUUID(),
    amount: Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0,
    userId: String(sug.userId || "").trim(),
    tag: "DebtyaValidate",
    requestType: String(sug.requestType || "ONE_TIME").toUpperCase() === "RECURRING" ? "RECURRING" : "ONE_TIME",
    useOfFunds: { allocation: [alloc] },
    settlementSpeed: "SAME_DAY",
    scheduleTs: Date.now() + 120_000
  };
  if (payerId) body.payerId = payerId;
  return body;
}

/**
 * POST al sandbox de Spinwheel con el cuerpo derivado del payload de prep (mismo contrato
 * que crear solicitud de pago). Interpreta 2xx como aceptación sintáctica/negocio según API;
 * 400 / 401 / 422 y otros como error estructurado (sin lanzar).
 *
 * @param {object} payload Objeto `payload` devuelto por `createSpinwheelPaymentIntent`
 * @returns {Promise<{ valid: true, response: object } | { valid: false, error: string, details: object }>}
 */
async function validateSpinwheelPaymentPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "payload inválido", details: { code: "invalid_payload" } };
  }
  const apiSecret = readSpinwheelApiSecret();
  if (!apiSecret) {
    return {
      valid: false,
      error: "Spinwheel API secret no configurada",
      details: { code: "spinwheel_not_configured" }
    };
  }
  const payerId = readSandboxPayerId();
  if (!payerId) {
    return {
      valid: false,
      error: "Missing SPINWHEEL_SANDBOX_PAYER_ID",
      details: { code: "spinwheel_missing_sandbox_payer_id" }
    };
  }

  const base = readPaymentValidateBaseUrl();
  const path = readPaymentValidatePath();
  const url = `${base}${path}`;
  const spinwheelBody = buildSpinwheelPaymentRequestFromPrepPayload(payload);

  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiSecret}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "DebtyaSpinwheelValidate/1"
    },
    body: JSON.stringify(spinwheelBody)
  };

  let res;
  let text = "";
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return {
      valid: false,
      error: `Fallo de red hacia Spinwheel: ${msg}`,
      details: { code: "spinwheel_network_error", url, request_preview: spinwheelBody }
    };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }

  if (res.ok) {
    return { valid: true, response: json != null ? json : { _raw: text } };
  }

  const extracted = spinwheelErrorMessageFromJson(json);
  const errMsg = extracted || `Spinwheel HTTP ${res.status}`;
  return {
    valid: false,
    error: errMsg,
    details: {
      http_status: res.status,
      body: json,
      request_sent: spinwheelBody,
      url
    }
  };
}

module.exports = {
  createSpinwheelPaymentIntent,
  validateSpinwheelPaymentPayload
};
