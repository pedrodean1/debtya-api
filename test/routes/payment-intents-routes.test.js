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
