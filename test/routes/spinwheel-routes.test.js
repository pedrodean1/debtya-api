const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerSpinwheelRoutes } = require("../../routes/spinwheel-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");
const { isUuid } = require("../../lib/validation");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const swUserId = "660e8400-e29b-41d4-a716-446655440000";

function makeDeps(overrides = {}) {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    jsonError,
    isUuid,
    appError: () => {},
    supabaseAdmin: overrides.supabaseAdmin,
    ...overrides
  };
}

function mount(deps) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerSpinwheelRoutes(app, deps);
  return app;
}

describe("routes/spinwheel-routes", () => {
  const saved = {};

  beforeEach(() => {
    for (const k of ["SPINWHEEL_API_SECRET", "SPINWHEEL_ENV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("GET /spinwheel/me 404 sin mapping", async () => {
    const supabaseAdmin = {
      from(t) {
        assert.equal(t, "spinwheel_users");
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle() {
                        return Promise.resolve({ data: null, error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).get("/spinwheel/me").set("Authorization", "Bearer x");
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "spinwheel_mapping_not_found");
  });

  it("GET /spinwheel/me 200 con mapping", async () => {
    const row = {
      id: "770e8400-e29b-41d4-a716-446655440000",
      user_id: userId,
      spinwheel_user_id: swUserId,
      environment: "sandbox",
      status: "active",
      raw_response: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle() {
                        return Promise.resolve({ data: row, error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).get("/spinwheel/me");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.mapping.spinwheel_user_id, swUserId);
  });

  it("POST verify rechaza UUID distinto al mapping", async () => {
    process.env.SPINWHEEL_API_SECRET = "test-secret-for-client";
    const row = {
      spinwheel_user_id: swUserId,
      user_id: userId,
      environment: "sandbox"
    };
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle() {
                        return Promise.resolve({ data: row, error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
    };
    const otherId = "880e8400-e29b-41d4-a716-446655440000";
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app)
      .post(`/spinwheel/users/${otherId}/connect/sms/verify`)
      .send({ code: "123456" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "spinwheel_user_id_forbidden");
  });
});
