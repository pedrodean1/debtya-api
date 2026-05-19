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