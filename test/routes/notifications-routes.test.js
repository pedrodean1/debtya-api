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
    notificationNow: () => new Date("2030-06-14T12:00:00.000Z"),
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
  cronLastUserReminderMetadata = null,
  cronEventInsertCaptures = null
} = {}) {
  let savedPreference = null;
  const rowsForCronScan = prefScanRows == null ? [] : prefScanRows;
  const inserts = cronEventInsertCaptures;
  const eventRows = cronLastUserReminderCreatedAtIso
    ? [{ created_at: cronLastUserReminderCreatedAtIso, metadata: cronLastUserReminderMetadata || {} }]
    : [];
  function eventSelectChain() {
    const chain = {
      eq() {
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return Promise.resolve({ data: eventRows, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: eventRows[0] || null, error: null });
      }
    };
    return chain;
  }
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
            return eventSelectChain();
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

  it("POST solo preferred_language preserva email opt-in y consentimientos", async () => {
    const prefExisting = {
      user_id: userId,
      email_enabled: true,
      sms_enabled: false,
      preferred_channel: "email",
      preferred_language: "en",
      consent_email_at: "2026-03-01T00:00:00.000Z",
      consent_sms_at: null,
      reminder_time: "09:00",
      timezone: "America/Mexico_City",
      reminder_frequency: "daily",
      phone_number: null
    };
    const supabaseAdmin = makeSupabaseMock({ pref: prefExisting });
    const app = mount(makeDeps({ supabaseAdmin }));
    const res = await request(app).post("/notifications/preferences").send({ preferred_language: "es" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.email_enabled, true);
    assert.equal(res.body.data.preferred_channel, "email");
    assert.equal(res.body.data.consent_email_at, "2026-03-01T00:00:00.000Z");
    assert.equal(res.body.data.reminder_frequency, "daily");
    assert.equal(res.body.data.preferred_language, "es");
    assert.equal(supabaseAdmin.savedPreference.email_enabled, true);
    assert.equal(supabaseAdmin.savedPreference.consent_email_at, "2026-03-01T00:00:00.000Z");
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

  it("reminder-debug devuelve email_consent_missing sin exponer datos sensibles", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: {
            user_id: userId,
            email_enabled: true,
            sms_enabled: false,
            preferred_channel: "email",
            consent_email_at: null,
            reminder_frequency: "weekly",
            preferred_language: "en"
          },
          ...reminderRows()
        })
      })
    );
    const res = await request(app).get("/notifications/reminder-debug");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.has_preferences, true);
    assert.equal(res.body.email_enabled, true);
    assert.equal(res.body.has_email_consent, false);
    assert.equal(res.body.has_next_intent, true);
    assert.equal(res.body.reason_if_not_eligible, "email_consent_missing");
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, "phone_number"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, "email"), false);
  });

  it("reminder-debug devuelve no_next_manual_first_intent cuando no hay intent", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: {
            user_id: userId,
            email_enabled: true,
            sms_enabled: false,
            preferred_channel: "email",
            consent_email_at: "2026-05-01T00:00:00.000Z",
            reminder_frequency: "weekly",
            preferred_language: "en"
          },
          intents: [],
          debt: null,
          plan: null
        })
      })
    );
    const res = await request(app).get("/notifications/reminder-debug");
    assert.equal(res.status, 200);
    assert.equal(res.body.reason_if_not_eligible, "no_next_manual_first_intent");
    assert.equal(res.body.has_next_intent, false);
    assert.equal(res.body.next_intent_status, null);
    assert.equal(res.body.next_intent_amount, null);
  });

  it("reminder-debug muestra cooldown activo y proximo permitido", async () => {
    const app = mount(
      makeDeps({
        supabaseAdmin: makeSupabaseMock({
          pref: {
            user_id: userId,
            email_enabled: true,
            sms_enabled: false,
            preferred_channel: "email",
            consent_email_at: "2026-05-01T00:00:00.000Z",
            reminder_frequency: "weekly",
            preferred_language: "en"
          },
          ...reminderRows(),
          cronLastUserReminderCreatedAtIso: "2030-06-14T11:00:00.000Z"
        })
      })
    );
    const res = await request(app).get("/notifications/reminder-debug");
    assert.equal(res.status, 200);
    assert.equal(res.body.cooldown_active, true);
    assert.equal(res.body.reason_if_not_eligible, "cooldown_active");
    assert.ok(res.body.last_email_event_at);
    assert.ok(res.body.next_allowed_at);
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
        const hourAgo = "2030-06-14T11:00:00.000Z";
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
