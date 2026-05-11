const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerMethodRoutes } = require("../../routes/method-routes");
const { registerSpinwheelRoutes } = require("../../routes/spinwheel-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");
const { isUuid } = require("../../lib/validation");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function methodDeps() {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    supabaseAdmin: {},
    jsonError,
    appError: () => {},
    safeNumber: (v, fb = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fb;
    },
    isUuid,
    isMissingTableColumnError: () => false
  };
}

function spinwheelDeps() {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    jsonError,
    isUuid,
    appError: () => {},
    supabaseAdmin: {},
    safeNumber: (v, fb = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fb;
    }
  };
}

describe("routes legacy GET /method/status y /spinwheel/status", () => {
  const saved = {};

  beforeEach(() => {
    saved.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES = process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
    delete process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
    for (const k of ["METHOD_API_KEY", "SPINWHEEL_API_SECRET", "SPINWHEEL_ENV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (saved.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES === undefined) delete process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
    else process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES = saved.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
    for (const k of ["METHOD_API_KEY", "SPINWHEEL_API_SECRET", "SPINWHEEL_ENV"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("sin DEBTYA_ALLOW_LEGACY_STATUS_ROUTES GET /method/status => 404 not_found", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    registerMethodRoutes(app, methodDeps());
    const res = await request(app).get("/method/status");
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "not_found");
  });

  it("sin flag GET /spinwheel/status => 404 not_found", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    registerSpinwheelRoutes(app, spinwheelDeps());
    const res = await request(app).get("/spinwheel/status");
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
  });

  it("con DEBTYA_ALLOW_LEGACY_STATUS_ROUTES=1 GET /method/status => 200 ok", async () => {
    process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES = "1";
    const app = express();
    app.use(requestIdMiddleware);
    registerMethodRoutes(app, methodDeps());
    const res = await request(app).get("/method/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.method_configured, "boolean");
  });

  it("con flag GET /spinwheel/status => 200 ok", async () => {
    process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES = "1";
    const app = express();
    app.use(requestIdMiddleware);
    registerSpinwheelRoutes(app, spinwheelDeps());
    const res = await request(app).get("/spinwheel/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.spinwheel_configured, "boolean");
  });
});
