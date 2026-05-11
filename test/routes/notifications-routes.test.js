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

function requireCronSecretLikeServer(req, res, next) {
  const provided = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET) {
    return jsonError(res, 500, "CRON_SECRET no configurado");
  }
  if (!provided || provided !== process.env.CRON_SECRET) {
    return jsonError(res, 401, "Unauthorized");
  }
  next();
}

function makeDeps(overrides = {}) {
  return {
    requireUser: (req, _res, next) => {
      req.user = { id: userId, email: "user@example.com" };
      next();
    },
    requireCronSecret: overrides.requireCronSecret ?? requireCronSecretLikeServer,
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

function makeSupabaseMock({
  pref = null,
  intents = [],
  debt = null,
  plan = null,
  prefScanRows = null,
  cronLastUserReminderCreatedAtIso = null,
  cronEventInsertCaptures = null
} = {}) {
  let savedPreference = null;
  const rowsForCronScan = prefScanRows == null ? [] : prefScanRows;
  const inserts = cronEventInsertCaptures;
  const api = {
    get savedPreference() {
      return savedPreference;
    },
    from(table) {
      if (table === "notification_preferences") {
        return {
          select() {
            const chain = {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: savedPreference || pref, error: null });
                  }
                };
              }
            };
            return Object.assign(chain, {
              then(onFulfilled, onRejected) {
                return Promise.resolve({ data: rowsForCronScan, error: null }).then(onFulfilled, onRejected);
              }
            });
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
      if (table === "notification_events") {
        return {
          insert(payload) {
            if (inserts) inserts.push(payload);
            return Promise.resolve({ data: {}, error: null });
          },
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      order() {
                        return {
                          limit() {
                            return {
                              maybeSingle() {
                                return Promise.resolve({
                                  data: cronLastUserReminderCreatedAtIso
                                    ? { created_at: cronLastUserReminderCreatedAtIso }
                                    : null,
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
    assert.equal(res.body.data.preferred_language, "en");
    assert.ok(res.body.data.consent_email_at);
  });

  it("POST preferences guarda preferred_language es", async () => {
    const supabaseAdmin = makeSupabaseMock();
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).post("/notifications/preferences").send({
      email_enabled: true,
      email_consent: true,
      sms_enabled: false,
      preferred_channel: "email",
      preferred_language: "es"
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.preferred_language, "es");
    assert.equal(supabaseAdmin.savedPreference.preferred_language, "es");
  });

  it("POST preferences preferred_language invalido normaliza a en", async () => {
    const supabaseAdmin = makeSupabaseMock();
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).post("/notifications/preferences").send({
      email_enabled: false,
      sms_enabled: false,
      preferred_channel: "none",
      preferred_language: "fr"
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.preferred_language, "en");
    assert.equal(supabaseAdmin.savedPreference.preferred_language, "en");
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
    assert.match(res.body.preview.message, /\$82\.00/);
  });

  it("preview-next-reminder en español cuando preferred_language es es", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: {
            user_id: userId,
            email_enabled: true,
            sms_enabled: false,
            preferred_channel: "email",
            preferred_language: "es",
            consent_email_at: "2026-01-01T00:00:00Z"
          },
          ...reminderRows()
        })
      })
    );
    const res = await request(app).post("/notifications/preview-next-reminder").send({ channel: "email" });
    assert.equal(res.status, 200);
    const body = res.body.preview.email_body || res.body.preview.message;
    assert.match(body, /Ya lo pagué/i);
    assert.match(body, /DebtYa no mueve dinero/i);
  });

  it("preview-next-reminder en inglés cuando preferred_language es en", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: {
            user_id: userId,
            email_enabled: true,
            sms_enabled: false,
            preferred_channel: "email",
            preferred_language: "en",
            consent_email_at: "2026-01-01T00:00:00Z"
          },
          ...reminderRows()
        })
      })
    );
    const res = await request(app).post("/notifications/preview-next-reminder").send({ channel: "email" });
    assert.equal(res.status, 200);
    const body = res.body.preview.email_body || res.body.preview.message;
    assert.match(body, /I paid it/i);
    assert.match(body, /DebtYa does not move money or make payments for you/i);
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

  it("run-due-reminders responde 401 sin x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-v97";
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app).post("/notifications/run-due-reminders").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("run-due-reminders responde 401 con secreto incorrecto", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-v97";
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app)
        .post("/notifications/run-due-reminders")
        .set("x-cron-secret", "wrong")
        .send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("run-due-reminders responde 500 si falta CRON_SECRET", async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app)
        .post("/notifications/run-due-reminders")
        .set("x-cron-secret", "any")
        .send({});
      assert.equal(res.status, 500);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("run-due-reminders responde 200 con escaneo vacio", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-v97";
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app)
        .post("/notifications/run-due-reminders")
        .set("x-cron-secret", "cron-test-v97")
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.scanned, 0);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("run-due-reminders con ?forceTest=1 incluye force_test en JSON de respuesta", async () => {
    const prevCron = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-force";
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app)
        .post("/notifications/run-due-reminders?forceTest=1")
        .set("x-cron-secret", "cron-test-force")
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.force_test, true);
    } finally {
      if (prevCron == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevCron;
    }
  });

  it("run-due-reminders con forceTest sigue rechazando x-cron-secret invalido", async () => {
    const prevCron = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-test-force";
    try {
      const app = mount(makeDeps({ supabaseAdmin: makeSupabaseMock() }));
      const res = await request(app)
        .post("/notifications/run-due-reminders?forceTest=1")
        .set("x-cron-secret", "wrong")
        .send({});
      assert.equal(res.status, 401);
    } finally {
      if (prevCron == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevCron;
    }
  });

  it("run-due-reminders normal respeta cooldown y no envía", async () => {
    await withProviderEnvCleared(async () => {
      const prevCron = process.env.CRON_SECRET;
      process.env.CRON_SECRET = "cron-test-cd";
      try {
        const prefRow = {
          user_id: userId,
          email_enabled: true,
          sms_enabled: false,
          preferred_channel: "email",
          reminder_frequency: "weekly",
          consent_email_at: "2026-05-01T00:00:00.000Z",
          reminder_time: null,
          timezone: null,
          phone_number: null,
          consent_sms_at: null
        };
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const app = mount(
          makeDeps({
            supabaseAdmin: makeSupabaseMock({
              prefScanRows: [prefRow],
              ...reminderRows(),
              cronLastUserReminderCreatedAtIso: hourAgo
            })
          })
        );
        const res = await request(app)
          .post("/notifications/run-due-reminders")
          .set("x-cron-secret", "cron-test-cd")
          .send({});
        assert.equal(res.status, 200);
        assert.equal(res.body.ok, true);
        assert.equal(res.body.sent, 0);
        assert.ok(!Object.prototype.hasOwnProperty.call(res.body, "force_test"));
      } finally {
        if (prevCron == null) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = prevCron;
      }
    });
  });
});
