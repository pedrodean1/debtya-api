const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerCronRoutes } = require("../../routes/cron-routes");
const { jsonError } = require("../../lib/json-error");

function requireCronSecretLikeServer(req, res, next) {
  const provided = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET) return jsonError(res, 500, "CRON_SECRET no configurado");
  if (!provided || provided !== process.env.CRON_SECRET) return jsonError(res, 401, "Unauthorized");
  next();
}

function makeApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  registerCronRoutes(app, {
    requireCronSecret: requireCronSecretLikeServer,
    supabaseAdmin: overrides.supabaseAdmin || {
      from() {
        return {
          select() {
            return { eq() { return Promise.resolve({ data: [], error: null }); } };
          }
        };
      }
    },
    jsonError,
    callRpc: async () => null,
    approveIntentDirect: async () => null,
    executeIntentDirect: async () => null,
    getIntentAmount: () => 0,
    isUuid: () => true,
    safeNumber: Number,
    getCurrentPaymentPlan: async () => null,
    stampRecentIntentsFundingFromPlan: async () => null,
    applyExecutedIntentToDebt: overrides.applyExecutedIntentToDebt || (async () => ({ ok: true, skipped: false })),
    reconcileManualFirstPriorityIntent: async () => null,
    appDebug: () => {},
    SERVER_VERSION: "test-version",
    SUPABASE_URL: "x",
    SUPABASE_ANON_KEY: "x",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    CRON_SECRET: process.env.CRON_SECRET,
    ...overrides
  });
  return app;
}

describe("routes/cron minimum payment auto tracking", () => {
  it("protege /cron/cleanup-payment-intents con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-cleanup-test";
    try {
      const app = makeApp();
      const res = await request(app).post("/cron/cleanup-payment-intents").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("limpia intents abiertos de deudas pagadas con resumen seguro", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-cleanup-test";
    try {
      const userId = "550e8400-e29b-41d4-a716-446655440000";
      const debtId = "660e8400-e29b-41d4-a716-446655440000";
      const intentId = "770e8400-e29b-41d4-a716-446655440000";
      const updates = [];
      const supabaseAdmin = {
        from(table) {
          if (table === "payment_intents") {
            return {
              select() {
                return {
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return Promise.resolve({
                              data: [
                                {
                                  id: intentId,
                                  user_id: userId,
                                  debt_id: debtId,
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
                  }
                };
              },
              update(payload) {
                updates.push(payload);
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          in() {
                            return Promise.resolve({ error: null });
                          }
                        };
                      }
                    };
                  }
                };
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
                          data: [{ id: debtId, user_id: userId, status: "paid", balance: 0, is_active: true }],
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
      const app = makeApp({ supabaseAdmin });
      const res = await request(app)
        .post("/cron/cleanup-payment-intents")
        .set("x-cron-secret", "cron-cleanup-test")
        .send({ limit: 50 });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.server_version, "test-version");
      assert.equal(res.body.limit, 50);
      assert.equal(res.body.users_scanned, 1);
      assert.equal(res.body.intents_scanned, 1);
      assert.equal(res.body.retired_count, 1);
      assert.deepEqual(res.body.reason_counts, { debt_paid: 1 });
      assert.equal(updates.length, 1);
      assert.equal(updates[0].status, "cancelled");
      assert.equal(updates[0].metadata.stale_intent_retired_reason, "debt_paid");
      assert.equal(JSON.stringify(res.body).includes(userId), false);
      assert.equal(JSON.stringify(res.body).includes(intentId), false);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("protege /cron/track-minimum-payments con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-minimum-test";
    try {
      const app = makeApp();
      const res = await request(app).post("/cron/track-minimum-payments").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("ejecuta sin usuarios elegibles y no falla", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-minimum-test";
    try {
      const app = makeApp();
      const res = await request(app)
        .post("/cron/track-minimum-payments")
        .set("x-cron-secret", "cron-minimum-test")
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.tracked, 0);
      assert.equal(res.body.users_checked, 0);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });
});
