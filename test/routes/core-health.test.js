const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerCoreRoutes } = require("../../routes/core-routes");
const { jsonError } = require("../../lib/json-error");

function mount() {
  const app = express();
  registerCoreRoutes(app, {
    SERVER_VERSION: "test-health-ver",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    CRON_SECRET: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_PRICE_ID_BETA_MONTHLY: "",
    STRIPE_WEBHOOK_SECRET: "",
    requireUser: (_req, _res, next) => next(),
    supabaseAdmin: {},
    sortTraceRows: (rows) => rows,
    getIntentAmount: () => 0,
    appDebug: () => {},
    jsonError
  });
  return app;
}

describe("routes/core-routes GET /health", () => {
  const prevNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete process.env.DEBTYA_HEALTH_TECHNICAL;
    delete process.env.HEALTH_EXPOSE_DEBUG;
  });

  it("en production no expone method_configured ni spinwheel_key_source", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DEBTYA_HEALTH_TECHNICAL;
    const app = mount();
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.ok, true);
    assert.equal(typeof body.server_version, "string");
    assert.equal(typeof body.now, "string");
    assert.equal(body.method_configured, undefined);
    assert.equal(body.spinwheel_configured, undefined);
    assert.equal(body.method_key_source, undefined);
    assert.equal(body.spinwheel_key_source, undefined);
    assert.equal(body.env_debug, undefined);
  });

  it("con DEBTYA_HEALTH_TECHNICAL=1 en production incluye campos tecnicos", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEBTYA_HEALTH_TECHNICAL = "1";
    const app = mount();
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.method_configured === true || res.body.method_configured === false, true);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, "spinwheel_configured"));
  });

  it("fuera de production expone detalles de integracion", async () => {
    process.env.NODE_ENV = "development";
    const app = mount();
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, "method_configured"));
  });
});
