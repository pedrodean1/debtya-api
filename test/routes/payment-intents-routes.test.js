const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerPaymentIntentRoutes } = require("../../routes/payment-intents-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const intentId = "660e8400-e29b-41d4-a716-446655440000";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeDeps(overrides = {}) {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    supabaseAdmin: overrides.supabaseAdmin,
    safeNumber,
    approveIntentDirect: overrides.approveIntentDirect || (async () => ({})),
    executeIntentDirect: overrides.executeIntentDirect || (async () => ({})),
    confirmManualPaymentIntentDirect:
      overrides.confirmManualPaymentIntentDirect ||
      (async () => ({
        ok: true,
        intent_id: intentId,
        debt_id: "770e8400-e29b-41d4-a716-446655440000",
        amount_confirmed: 25,
        new_balance: 100,
        data: { id: intentId, status: "executed" },
        debt_apply: { ok: true, next_balance: 100 }
      })),
    reconcileRecentExecutedIntents: overrides.reconcileRecentExecutedIntents || (async () => ({})),
    isoDaysAgo: () => new Date().toISOString(),
    jsonError,
    ...overrides
  };
}

function mount(deps) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerPaymentIntentRoutes(app, deps);
  return app;
}

describe("routes/payment-intents-routes", () => {
  it("GET retira intents abiertos que apuntan a deuda pagada antes de devolverlos", async () => {
    const staleId = "661e8400-e29b-41d4-a716-446655440001";
    const activeId = "661e8400-e29b-41d4-a716-446655440002";
    const staleDebtId = "771e8400-e29b-41d4-a716-446655440001";
    const activeDebtId = "771e8400-e29b-41d4-a716-446655440002";
    const updates = [];
    const supabaseAdmin = {
      from(table) {
        if (table === "payment_intents") {
          return {
            select() {
              return {
                eq() {
                  return {
                    order() {
                      return Promise.resolve({
                        data: [
                          {
                            id: staleId,
                            user_id: userId,
                            debt_id: staleDebtId,
                            status: "pending_review",
                            metadata: {}
                          },
                          {
                            id: activeId,
                            user_id: userId,
                            debt_id: activeDebtId,
                            status: "pending_review",
                            metadata: {}
                          }
                        ],
                        error: null
                      });
                    }
                  };
                }
              };
            },
            update(payload) {
              const call = { payload, eqs: [], inArgs: null };
              updates.push(call);
              const builder = {
                eq(col, value) {
                  call.eqs.push({ col, value });
                  return builder;
                },
                in(col, values) {
                  call.inArgs = { col, values };
                  return Promise.resolve({ error: null });
                }
              };
              return builder;
            }
          };
        }
        if (table === "debts") {
          return {
            select() {
              return {
                eq() {
                  return {
                    in() {
                      return Promise.resolve({
                        data: [
                          {
                            id: staleDebtId,
                            user_id: userId,
                            status: "paid",
                            balance: 0,
                            current_balance: 0,
                            is_active: true
                          },
                          {
                            id: activeDebtId,
                            user_id: userId,
                            status: "active",
                            balance: 150,
                            current_balance: 150,
                            is_active: true
                          }
                        ],
                        error: null
                      });
                    }
                  };
                }
              };
            }
          };
        }
        throw new Error(`tabla inesperada ${table}`);
      }
    };
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).get("/payment-intents");

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stale_payment_intents.retired_count, 1);
    assert.deepEqual(res.body.stale_payment_intents.reason_counts, { debt_paid: 1 });
    assert.equal(res.body.data.find((x) => x.id === staleId).status, "canceled");
    assert.equal(res.body.data.find((x) => x.id === activeId).status, "pending_review");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].payload.metadata.stale_intent_retired_reason, "debt_paid");
  });

  it("POST rechaza amount negativo con request_id y http_status", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: {}
      })
    );
    const res = await request(app)
      .post("/payment-intents")
      .set("X-Request-Id", "pi-req-1")
      .send({ amount: -1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "amount inválido");
    assert.equal(res.body.request_id, "pi-req-1");
    assert.equal(res.body.http_status, 400);
  });

  it("POST approve id no uuid => 400", async () => {
    const app = mount(makeDeps({ supabaseAdmin: {} }));
    const res = await request(app).post("/payment-intents/not-a-uuid/approve").send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.http_status, 400);
    assert.match(res.body.error, /inválido/);
  });

  it("POST confirm-manual id no uuid => 400", async () => {
    const app = mount(makeDeps({ supabaseAdmin: {} }));
    const res = await request(app).post("/payment-intents/not-a-uuid/confirm-manual").send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.http_status, 400);
  });

  it("POST confirm-manual ok cuando el handler resuelve", async () => {
    const app = mount(makeDeps({}));
    const res = await request(app).post(`/payment-intents/${intentId}/confirm-manual`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.intent_id, intentId);
    assert.equal(res.body.amount_confirmed, 25);
  });

  it("POST confirm-manual devuelve resumen seguro del email transaccional", async () => {
    const app = mount(
      makeDeps({
        confirmManualPaymentIntentDirect: async () => ({
          ok: true,
          intent_id: intentId,
          debt_id: "770e8400-e29b-41d4-a716-446655440000",
          amount_confirmed: 25,
          new_balance: 100,
          data: { id: intentId, status: "executed" },
          debt_apply: { ok: true, next_balance: 100 },
          transactional_email: {
            ok: true,
            payment_email_sent: false,
            celebration_email_sent: false,
            skipped: true,
            reason: "email_provider_not_configured"
          }
        })
      })
    );
    const res = await request(app).post(`/payment-intents/${intentId}/confirm-manual`).send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.transactional_email, {
      ok: true,
      payment_email_sent: false,
      celebration_email_sent: false,
      skipped: true,
      reason: "email_provider_not_configured"
    });
  });

  it("POST confirm-manual propaga already_confirmed del handler", async () => {
    const app = mount(
      makeDeps({
        confirmManualPaymentIntentDirect: async () => ({
          ok: true,
          already_confirmed: true,
          intent_id: intentId,
          debt_id: "770e8400-e29b-41d4-a716-446655440000",
          amount_confirmed: 25,
          old_balance: 10,
          new_balance: 10,
          data: { id: intentId, status: "executed" },
          debt_apply: { ok: true, skipped: true, reason: "ya_confirmado" },
          debt_marked_paid: false
        })
      })
    );
    const res = await request(app).post(`/payment-intents/${intentId}/confirm-manual`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.already_confirmed, true);
  });

  it("POST confirm-manual propaga confirmation_in_progress; debt_apply omitido en rebaja (skipped); sin email en JSON", async () => {
    let handlerCalls = 0;
    const app = mount(
      makeDeps({
        confirmManualPaymentIntentDirect: async () => {
          handlerCalls += 1;
          return {
            ok: true,
            already_confirmed: true,
            confirmation_in_progress: true,
            intent_id: intentId,
            debt_id: "770e8400-e29b-41d4-a716-446655440000",
            amount_confirmed: 25,
            old_balance: null,
            new_balance: null,
            data: { id: intentId, status: "executed" },
            debt_apply: { ok: true, skipped: true, reason: "confirmacion_en_progreso" },
            debt_marked_paid: false
          };
        }
      })
    );
    const res = await request(app).post(`/payment-intents/${intentId}/confirm-manual`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.already_confirmed, true);
    assert.equal(res.body.confirmation_in_progress, true);
    assert.equal(res.body.debt_apply && res.body.debt_apply.reason, "confirmacion_en_progreso");
    assert.equal(res.body.debt_apply && res.body.debt_apply.skipped, true);
    assert.equal(res.body.new_balance, null);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, "email_sent"), false);
    assert.equal(handlerCalls, 1);
  });

  it("POST confirm-manual pasa preferred_language al handler", async () => {
    let captured;
    const app = mount(
      makeDeps({
        confirmManualPaymentIntentDirect: async (uid, id, opts) => {
          captured = { uid, id, opts };
          return {
            ok: true,
            intent_id: id,
            debt_id: "770e8400-e29b-41d4-a716-446655440000",
            amount_confirmed: 25,
            new_balance: 100,
            data: { id, status: "executed" },
            debt_apply: { ok: true, next_balance: 100 }
          };
        }
      })
    );
    const res = await request(app)
      .post(`/payment-intents/${intentId}/confirm-manual`)
      .send({ preferred_language: "es" });
    assert.equal(res.status, 200);
    assert.equal(captured.opts.preferredLanguageHint, "es");
  });

  it("POST confirm-manual lee x-debtya-language si no hay body", async () => {
    let captured;
    const app = mount(
      makeDeps({
        confirmManualPaymentIntentDirect: async (_uid, id, opts) => {
          captured = opts;
          return {
            ok: true,
            intent_id: id,
            debt_id: "770e8400-e29b-41d4-a716-446655440000",
            amount_confirmed: 1,
            new_balance: 0,
            data: { id, status: "executed" },
            debt_apply: { ok: true }
          };
        }
      })
    );
    await request(app)
      .post(`/payment-intents/${intentId}/confirm-manual`)
      .set("x-debtya-language", "en")
      .send({});
    assert.equal(captured.preferredLanguageHint, "en");
  });

  it("POST crea intent cuando insert ok", async () => {
    const supabaseAdmin = {
      from() {
        return {
          insert(payload) {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: { id: intentId, ...payload },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
    };
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).post("/payment-intents").send({ amount: 42 });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.amount, 42);
    assert.equal(res.body.data.user_id, userId);
  });
});
