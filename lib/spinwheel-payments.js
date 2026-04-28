/**
 * Preparación de pagos Spinwheel (sin llamadas HTTP reales aún).
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
 * Este módulo solo construye un payload de trabajo y deja trazas en log; no mueve dinero.
 */

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

module.exports = { createSpinwheelPaymentIntent };
