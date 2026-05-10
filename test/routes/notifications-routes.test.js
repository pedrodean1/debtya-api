const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerNotificationRoutes } = require("../../routes/notifications-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const intentId = "660e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

function makeDeps(overrides = {}) {
  return {
    requireUser: (req, _res, next) => {
      req.user = { id: userId, email: "user@example.com" };
      next();
    },
    supabaseAdmin: overrides.supabaseAdmin,
    getIntentAmount: (intent) => Number(intent.amount || 0),
    jsonError,
    appError: () => {},
    ...overrides
  };
}

function mount(deps) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerNotificationRoutes(app, deps);
  return app;
}

function makeSupabaseMock({ pref = null, intents = [], debt = null, plan = null } = {}) {
  let savedPreference = null;
  const api = {
    get savedPreference() {
      return savedPreference;
    },
    from(table) {
      if (table === "notification_preferences") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: savedPreference || pref, error: null });
                  }
                };
              }
            };
          },
          upsert(payload) {
            savedPreference = { id: "pref-1", ...payload, created_at: "2026-05-10T00:00:00Z" };
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: savedPreference, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === "payment_intents") {
        return {
          select() {
            return {
              eq() {
                return {
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return Promise.resolve({ data: intents, error: null });
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
      }
      if (table === "debts") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle() {
                        return Promise.resolve({ data: debt, error: null });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      if (table === "payment_plans") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      limit() {
                        return {
                          maybeSingle() {
                            return Promise.resolve({ data: plan, error: null });
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
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };
  return api;
}

function reminderRows() {
  return {
    intents: [
      {
        id: intentId,
        user_id: userId,
        debt_id: debtId,
        amount: 82,
        status: "pending_review",
        strategy: "avalanche",
        metadata: { manual_first_priority: true },
        created_at: "2026-05-10T00:00:00Z"
      }
    ],
    debt: { id: debtId, user_id: userId, name: "CBUSASEARS" },
    plan: { strategy: "avalanche" }
  };
}

function withProviderEnvCleared(fn) {
  const keys = [
    "EMAIL_PROVIDER",
    "RESEND_API_KEY",
    "SENDGRID_API_KEY",
    "SMS_PROVIDER",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER"
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      keys.forEach((key) => {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      });
    });
}

describe("routes/notifications-routes", () => {
  it("guarda preferencias de email sin activar por defecto", async () => {
    const supabaseAdmin = makeSupabaseMock();
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).post("/notifications/preferences").send({
      email_enabled: true,
      email_consent: true,
      sms_enabled: false,
      preferred_channel: "email",
      reminder_time: "09:30",
      timezone: "America/New_York"
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.email_enabled, true);
    assert.equal(res.body.data.sms_enabled, false);
    assert.equal(res.body.data.preferred_channel, "email");
    assert.ok(res.body.data.consent_email_at);
  });

  it("rechaza SMS sin phone_number", async () => {
    const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
    const res = await request(app).post("/notifications/preferences").send({
      sms_enabled: true,
      sms_consent: true
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /phone_number/i);
  });

  it("rechaza SMS sin consentimiento explicito", async () => {
    const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
    const res = await request(app).post("/notifications/preferences").send({
      sms_enabled: true,
      phone_number: "+15551234567"
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /consent/i);
  });

  it("preview-next-reminder devuelve preview con intent existente", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: { user_id: userId, email_enabled: false, sms_enabled: false, preferred_channel: "none" },
          ...reminderRows()
        })
      })
    );
    const res = await request(app).post("/notifications/preview-next-reminder").send({ channel: "sms" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.preview.intent_id, intentId);
    assert.equal(res.body.preview.debt_name, "CBUSASEARS");
    assert.match(res.body.preview.message, /Pay \$82\.00/);
  });

  it("send-test devuelve preview si no hay provider keys", async () => {
    await withProviderEnvCleared(async () => {
      const app = mount(
        makeDeps({
          supabaseAdmin: makeSupabaseMock({
            pref: {
              user_id: userId,
              email_enabled: true,
              sms_enabled: false,
              preferred_channel: "email",
              consent_email_at: "2026-05-10T00:00:00Z"
            },
            ...reminderRows()
          })
        })
      );
      const res = await request(app).post("/notifications/send-test").send({ channel: "email" });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.sent, false);
      assert.match(res.body.warning, /provider/i);
      assert.equal(res.body.preview.intent_id, intentId);
    });
  });

  it("send-test no envia sin opt-in", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: { user_id: userId, email_enabled: false, sms_enabled: false, preferred_channel: "none" },
          ...reminderRows()
        })
      })
    );
    const res = await request(app).post("/notifications/send-test").send({ channel: "email" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Email reminders are not enabled/);
  });
});
