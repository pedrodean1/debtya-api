const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildNextPaymentReminderPreview,
  defaultNotificationPreferences,
  normalizePreferredLanguage,
  parsePreferredLanguageHintFromHttp,
  minGapMsForCadence,
  minUserWideGapMs,
  isTuesdayFridayReminderDay,
  normalizePhoneNumber,
  normalizeReminderFrequency,
  NOTIFICATION_EVENT_MESSAGE_FALLBACK,
  resolveDebtYaReminderFromAddress,
  resolveNotificationEventMessage,
  runDuePaymentReminders,
  validateNotificationPreferencesInput
} = require("../../lib/notifications");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const intentId = "660e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

function makeSupabaseMock({ intents = [], debt = null, plan = null } = {}) {
  return {
    from(table) {
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
}

describe("lib/notifications", () => {
  it("normaliza telefono SMS simple", () => {
    assert.equal(normalizePhoneNumber("+1 (555) 123-4567"), "+15551234567");
    assert.equal(normalizePhoneNumber("abc"), null);
  });

  it("no permite SMS sin phone_number", () => {
    const out = validateNotificationPreferencesInput({ sms_enabled: true, sms_consent: true });
    assert.match(out.error, /phone_number/i);
  });

  it("no permite SMS sin consentimiento", () => {
    const out = validateNotificationPreferencesInput({
      sms_enabled: true,
      phone_number: "+15551234567"
    });
    assert.match(out.error, /consent/i);
  });

  it("no permite email sin consentimiento en primer alta", () => {
    const out = validateNotificationPreferencesInput({ email_enabled: true });
    assert.match(out.error, /email consent/i);
  });

  it("permite email con consentimiento", () => {
    const out = validateNotificationPreferencesInput({
      email_enabled: true,
      email_consent: true
    });
    assert.ok(out.payload);
    assert.equal(out.payload.email_enabled, true);
    assert.ok(out.payload.consent_email_at);
  });

  it("acepta reminder_frequency weekly", () => {
    const out = validateNotificationPreferencesInput(
      { email_enabled: true, email_consent: true, reminder_frequency: "weekly" },
      null
    );
    assert.ok(out.payload);
    assert.equal(out.payload.reminder_frequency, "weekly");
  });

  it("sin reminder_frequency en body usa twice_weekly por defecto", () => {
    const out = validateNotificationPreferencesInput({ email_enabled: true, email_consent: true }, null);
    assert.ok(out.payload);
    assert.equal(out.payload.reminder_frequency, "twice_weekly");
  });

  it("normaliza reminder_frequency desconocido a twice_weekly", () => {
    assert.equal(normalizeReminderFrequency("bogus"), "twice_weekly");
  });

  it("defaultNotificationPreferences usa twice_weekly", () => {
    const d = defaultNotificationPreferences(userId);
    assert.equal(d.reminder_frequency, "twice_weekly");
    assert.equal(d.preferred_language, "en");
  });

  it("normalizePreferredLanguage solo acepta en o es", () => {
    assert.equal(normalizePreferredLanguage("es"), "es");
    assert.equal(normalizePreferredLanguage("EN"), "en");
    assert.equal(normalizePreferredLanguage("fr"), "en");
    assert.equal(normalizePreferredLanguage(""), "en");
  });

  it("parsePreferredLanguageHintFromHttp lee body y header", () => {
    assert.equal(parsePreferredLanguageHintFromHttp({ body: { preferred_language: "es" } }), "es");
    assert.equal(
      parsePreferredLanguageHintFromHttp({ body: {}, headers: { "x-debtya-language": "en" } }),
      "en"
    );
    assert.equal(parsePreferredLanguageHintFromHttp({ body: {}, headers: {} }), null);
  });

  it("validateNotificationPreferencesInput normaliza preferred_language invalido a en", () => {
    const out = validateNotificationPreferencesInput({
      email_enabled: false,
      sms_enabled: false,
      preferred_channel: "none",
      preferred_language: "xx"
    });
    assert.ok(out.payload);
    assert.equal(out.payload.preferred_language, "en");
  });

  it("partial preferred_language no apaga email_enabled ni borra consent_email_at", () => {
    const existing = {
      user_id: userId,
      email_enabled: true,
      sms_enabled: false,
      preferred_channel: "email",
      preferred_language: "en",
      consent_email_at: "2026-01-01T00:00:00.000Z",
      consent_sms_at: null,
      phone_number: null
    };
    const out = validateNotificationPreferencesInput({ preferred_language: "es" }, existing);
    assert.ok(out.payload);
    assert.equal(out.payload.email_enabled, true);
    assert.equal(out.payload.consent_email_at, "2026-01-01T00:00:00.000Z");
    assert.equal(out.payload.preferred_language, "es");
  });

  it("partial preferred_language invalido conserva resto y normaliza idioma a en", () => {
    const existing = {
      user_id: userId,
      email_enabled: true,
      sms_enabled: false,
      preferred_channel: "email",
      preferred_language: "es",
      consent_email_at: "2026-01-02T00:00:00.000Z",
      consent_sms_at: null,
      phone_number: null
    };
    const out = validateNotificationPreferencesInput({ preferred_language: "fr" }, existing);
    assert.ok(out.payload);
    assert.equal(out.payload.email_enabled, true);
    assert.equal(out.payload.consent_email_at, "2026-01-02T00:00:00.000Z");
    assert.equal(out.payload.preferred_language, "en");
  });

  it("resolveDebtYaReminderFromAddress prioriza EMAIL_FROM y luego RESEND_FROM_EMAIL", () => {
    assert.equal(
      resolveDebtYaReminderFromAddress({
        EMAIL_FROM: "  DebtYa <notifications@debtya.com>  ",
        RESEND_FROM_EMAIL: "Onboarding <onboarding@resend.dev>"
      }),
      "DebtYa <notifications@debtya.com>"
    );
    assert.equal(
      resolveDebtYaReminderFromAddress({
        RESEND_FROM_EMAIL: "Onboarding <verified@example.com>"
      }),
      "Onboarding <verified@example.com>"
    );
    assert.match(resolveDebtYaReminderFromAddress({}), /onboarding@resend\.dev/);
  });

  it("minGapMsForCadence: todos los modos normales usan proteccion martes/viernes", () => {
    const gap = minGapMsForCadence("twice_weekly");
    assert.equal(minGapMsForCadence("daily"), gap);
    assert.equal(minGapMsForCadence("smart"), gap);
    assert.equal(minGapMsForCadence("weekly"), gap);
    assert.equal(gap, 36 * 60 * 60 * 1000);
    assert.equal(minGapMsForCadence("off"), Number.POSITIVE_INFINITY);
  });

  it("minUserWideGapMs evita duplicados del dia pero permite martes/viernes", () => {
    assert.equal(minUserWideGapMs("twice_weekly"), 36 * 60 * 60 * 1000);
    assert.equal(minUserWideGapMs("weekly"), minUserWideGapMs("twice_weekly"));
  });

  it("isTuesdayFridayReminderDay solo permite martes y viernes", () => {
    assert.equal(isTuesdayFridayReminderDay(new Date("2030-06-11T12:00:00.000Z"), "UTC"), true);
    assert.equal(isTuesdayFridayReminderDay(new Date("2030-06-14T12:00:00.000Z"), "UTC"), true);
    assert.equal(isTuesdayFridayReminderDay(new Date("2030-06-10T12:00:00.000Z"), "UTC"), false);
    assert.equal(isTuesdayFridayReminderDay(new Date("2030-06-15T12:00:00.000Z"), "UTC"), false);
  });

  it("runDuePaymentReminders sin supabase devuelve error", async () => {
    const r = await runDuePaymentReminders({});
    assert.equal(r.ok, false);
    assert.match(String(r.error || ""), /Supabase/i);
  });

  it("runDuePaymentReminders omite todo si falta tabla de preferencias", async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return Promise.resolve({
              data: null,
              error: { code: "42P01", message: "relation notification_preferences does not exist" }
            });
          }
        };
      }
    };
    const r = await runDuePaymentReminders({ supabaseAdmin });
    assert.equal(r.ok, true);
    assert.equal(r.skipped_all, true);
  });

  it("permite email sin marcar consent si ya existia consent_email_at", () => {
    const out = validateNotificationPreferencesInput(
      { email_enabled: true },
      { consent_email_at: "2020-01-01T00:00:00.000Z" }
    );
    assert.ok(out.payload);
  });

  it("construye preview de recordatorio con intent manual-first existente", async () => {
    const supabaseAdmin = makeSupabaseMock({
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
    });

    const preview = await buildNextPaymentReminderPreview({
      supabaseAdmin,
      userId,
      channel: "sms"
    });

    assert.equal(preview.intent_id, intentId);
    assert.equal(preview.debt_name, "CBUSASEARS");
    assert.equal(preview.amount, 82);
    assert.match(preview.message, /\$82\.00/);
    assert.match(preview.message, /CBUSASEARS/);
    assert.match(preview.message, /I paid it/i);
  });

  it("preview email EN (V101) incluye Yo lo pagué EN, disclaimer y nombre de deuda", async () => {
    const supabaseAdmin = makeSupabaseMock({
      intents: [
        {
          id: intentId,
          user_id: userId,
          debt_id: debtId,
          amount: 100,
          status: "pending_review",
          strategy: "avalanche",
          metadata: { manual_first_priority: true },
          created_at: "2026-05-10T00:00:00Z"
        }
      ],
      debt: { id: debtId, user_id: userId, name: "Card A", balance: 1200, apr: 18 },
      plan: { strategy: "avalanche" }
    });
    const preview = await buildNextPaymentReminderPreview({
      supabaseAdmin,
      userId,
      channel: "email",
      lang: "en"
    });
    const body = preview.email_body || preview.message;
    assert.match(body, /I paid it/i);
    assert.match(body, /DebtYa does not move money or make payments for you/i);
    assert.match(body, /Recommended debt:\s*Card A/i);
  });

  it("preview email usa fallback cuando no hay nombre de deuda (V101)", async () => {
    const supabaseAdmin = makeSupabaseMock({
      intents: [
        {
          id: intentId,
          user_id: userId,
          debt_id: debtId,
          amount: 25,
          status: "pending_review",
          strategy: "avalanche",
          metadata: { manual_first_priority: true },
          debt_name: null,
          creditor_name: null,
          created_at: "2026-05-10T00:00:00Z"
        }
      ],
      debt: null,
      plan: { strategy: "avalanche" }
    });
    const preview = await buildNextPaymentReminderPreview({
      supabaseAdmin,
      userId,
      channel: "email",
      lang: "en"
    });
    const body = preview.email_body || preview.message;
    assert.match(body, /I paid it/i);
    assert.match(body, /DebtYa does not move money or make payments for you/i);
    assert.match(body, /Recommended debt:\s*your priority debt/i);
  });

  it("preview en espanol menciona Ya lo pague", async () => {
    const supabaseAdmin = makeSupabaseMock({
      intents: [
        {
          id: intentId,
          user_id: userId,
          debt_id: debtId,
          amount: 50,
          status: "approved",
          strategy: "snowball",
          metadata: { manual_first_rebuild: true },
          created_at: "2026-05-10T00:00:00Z"
        }
      ],
      debt: { id: debtId, user_id: userId, name: "Tarjeta A" },
      plan: { strategy: "snowball" }
    });
    const preview = await buildNextPaymentReminderPreview({
      supabaseAdmin,
      userId,
      channel: "email",
      lang: "es"
    });
    assert.match(preview.email_body || preview.message, /Ya lo pagué/i);
    assert.match(preview.email_body || preview.message, /DebtYa no mueve dinero/i);
    assert.match(preview.email_body || preview.message, /Deuda recomendada:\s*Tarjeta A/i);
  });


});

describe("resolveNotificationEventMessage (V100.1)", () => {
  it("nunca devuelve string vacio", () => {
    assert.equal(resolveNotificationEventMessage(null, "email"), NOTIFICATION_EVENT_MESSAGE_FALLBACK);
    assert.equal(resolveNotificationEventMessage({}, "email"), NOTIFICATION_EVENT_MESSAGE_FALLBACK);
  });

  it("email usa subject y cuerpo cuando existen", () => {
    const m = resolveNotificationEventMessage(
      { subject: "Pay $10", email_body: "Line one\nLine two" },
      "email"
    );
    assert.match(m, /Pay \$10/);
    assert.match(m, /Line one/);
  });

  it("sms usa sms_message o message", () => {
    assert.match(resolveNotificationEventMessage({ sms_message: "SMS body here" }, "sms"), /SMS body/);
    assert.equal(resolveNotificationEventMessage({ message: "" }, "sms"), NOTIFICATION_EVENT_MESSAGE_FALLBACK);
  });

  it("forceTest metadata no afecta resolve (solo insert); preview vacio cae en fallback", () => {
    assert.equal(resolveNotificationEventMessage({ subject: "", message: "" }, "email"), NOTIFICATION_EVENT_MESSAGE_FALLBACK);
  });
});

describe("runDuePaymentReminders cron (V100)", () => {
  const fixedNow = new Date("2030-06-14T12:00:00.000Z");

  const intentRow = {
    id: intentId,
    user_id: userId,
    debt_id: debtId,
    amount: 82,
    status: "pending_review",
    strategy: "avalanche",
    metadata: { manual_first_priority: true },
    created_at: "2030-06-01T00:00:00.000Z"
  };
  const debtRow = { id: debtId, user_id: userId, name: "CBUSASEARS", balance: 1000 };
  const planRow = { strategy: "avalanche" };

  function makeCronSupabase({
    prefRows,
    lastUserReminderIso = null,
    lastUserReminderMetadata = null,
    intentRows = [intentRow]
  }) {
    const inserts = [];
    const eventRows = lastUserReminderIso
      ? [{ created_at: lastUserReminderIso, metadata: lastUserReminderMetadata || {} }]
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
    const supabaseAdmin = {
      inserts,
      auth: {
        admin: {
          async getUserById() {
            return { data: { user: { email: "u@debtya-test.example" } }, error: null };
          }
        }
      },
      from(table) {
        if (table === "notification_preferences") {
          return {
            select() {
              return Promise.resolve({ data: prefRows, error: null });
            }
          };
        }
        if (table === "notification_events") {
          return {
            insert(payload) {
              inserts.push(payload);
              return Promise.resolve({ data: null, error: null });
            },
            select() {
              return eventSelectChain();
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
                              return Promise.resolve({ data: intentRows, error: null });
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
                          return Promise.resolve({ data: debtRow, error: null });
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
                              return Promise.resolve({ data: planRow, error: null });
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
    return supabaseAdmin;
  }

  const prefEligible = (over = {}) => ({
    user_id: userId,
    email_enabled: true,
    sms_enabled: true,
    phone_number: "+15551239999",
    preferred_channel: "both",
    consent_email_at: "2030-01-01T00:00:00.000Z",
    consent_sms_at: "2030-01-01T00:00:00.000Z",
    reminder_frequency: "twice_weekly",
    reminder_time: null,
    timezone: null,
    preferred_language: "en",
    ...over
  });

  it("cron normal respeta cooldown (envio reciente) y no envia", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    let calls = 0;
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible()],
        lastUserReminderIso: "2030-06-14T12:00:00.000Z"
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        sendReminderFn: async () => {
          calls += 1;
          return { channel: "email", sent: true, provider: "x" };
        }
      });
      assert.equal(out.ok, true);
      assert.equal(out.sent, 0);
      assert.equal(out.eligible, 0);
      assert.equal(out.reason_counts.cooldown_active, 1);
      assert.equal(calls, 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron forceTest usa preferred_language es en el preview enviado", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      let capturedPreview = null;
      const sb = makeCronSupabase({
        prefRows: [prefEligible({ preferred_language: "es" })],
        lastUserReminderIso: null
      });
      await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: new Date("2030-06-15T12:00:00.000Z"),
        env: process.env,
        forceTest: true,
        sendReminderFn: async ({ preview }) => {
          capturedPreview = preview;
          return { channel: "email", sent: true, provider: "resend" };
        }
      });
      assert.ok(capturedPreview);
      assert.match(String(capturedPreview.email_body || ""), /Ya lo pagué/i);
      assert.match(String(capturedPreview.email_body || ""), /DebtYa no mueve dinero/i);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron forceTest omite cooldown, dia de semana y registra metadata.force_test en evento", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible()],
        lastUserReminderIso: "2030-06-14T12:00:00.000Z"
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: new Date("2030-06-15T12:00:00.000Z"),
        env: process.env,
        forceTest: true,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.force_test, true);
      assert.equal(out.sent, 1);
      assert.equal(sb.inserts.length, 1);
      assert.equal(sb.inserts[0].metadata.force_test, true);
      assert.equal(typeof sb.inserts[0].message, "string");
      assert.ok(sb.inserts[0].message.length > 0);
      assert.notEqual(sb.inserts[0].message, null);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron forceTest no invoca sms aunque este habilitado", async () => {
    const prev = process.env.RESEND_API_KEY;
    /** @type {string[]} */
    const channelsSeen = [];
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible()],
        lastUserReminderIso: null
      });
      await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: new Date("2030-06-15T12:00:00.000Z"),
        env: process.env,
        forceTest: true,
        sendReminderFn: async ({ channel }) => {
          channelsSeen.push(channel);
          return { channel, sent: true, provider: "resend" };
        }
      });
      assert.deepEqual(channelsSeen, ["email"]);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron forceTest omite usuarios sin consentimiento email", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const p = prefEligible();
      p.consent_email_at = null;
      const sb = makeCronSupabase({ prefRows: [p], lastUserReminderIso: null });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: new Date("2030-06-15T12:00:00.000Z"),
        env: process.env,
        forceTest: true,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 0);
      assert.equal(out.reason_counts.force_email_not_consented, 1);
      assert.equal(sb.inserts.length, 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron normal sin evento previo permite envío (sin forceTest)", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible()],
        lastUserReminderIso: null
      });
      let calls = 0;
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        forceTest: false,
        sendReminderFn: async ({ channel }) => {
          calls += 1;
          return { channel, sent: channel === "email", provider: "resend" };
        }
      });
      assert.ok(!Object.prototype.hasOwnProperty.call(out, "force_test"));
      assert.equal(out.sent, 1);
      assert.equal(calls >= 1, true);
      assert.equal(sb.inserts.length, 1);
      assert.ok(!sb.inserts[0].metadata);
      assert.equal(typeof sb.inserts[0].message, "string");
      assert.ok(sb.inserts[0].message.length > 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron normal no envia lunes, miercoles, jueves, sabado ni domingo", async () => {
    const blockedDays = [
      "2030-06-10T12:00:00.000Z",
      "2030-06-12T12:00:00.000Z",
      "2030-06-13T12:00:00.000Z",
      "2030-06-15T12:00:00.000Z",
      "2030-06-16T12:00:00.000Z"
    ];
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      for (const day of blockedDays) {
        const sb = makeCronSupabase({
          prefRows: [prefEligible({ sms_enabled: false, preferred_channel: "email" })],
          lastUserReminderIso: null
        });
        let calls = 0;
        const out = await runDuePaymentReminders({
          supabaseAdmin: sb,
          getIntentAmount: (intent) => Number(intent.amount || 0),
          now: new Date(day),
          env: process.env,
          sendReminderFn: async () => {
            calls += 1;
            return { channel: "email", sent: true, provider: "resend" };
          }
        });
        assert.equal(out.sent, 0, day);
        assert.equal(out.eligible, 0, day);
        assert.equal(out.reason_counts.outside_tuesday_friday_schedule, 1, day);
        assert.equal(calls, 0, day);
        assert.equal(sb.inserts.length, 0, day);
      }
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron normal permite martes sin evento previo", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible({ sms_enabled: false, preferred_channel: "email" })],
        lastUserReminderIso: null
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: new Date("2030-06-11T12:00:00.000Z"),
        env: process.env,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 1);
      assert.equal(out.eligible, 1);
      assert.equal(sb.inserts.length, 1);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });
  it("cron normal usuario sin consentimiento no es elegible", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible({ consent_email_at: null, sms_enabled: false, preferred_channel: "email" })],
        lastUserReminderIso: null
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 0);
      assert.equal(out.eligible, 0);
      assert.equal(out.reason_counts.email_consent_missing, 1);
      assert.equal(sb.inserts.length, 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron normal usuario con consentimiento pero sin intent no es elegible", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible({ sms_enabled: false, preferred_channel: "email" })],
        intentRows: []
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 0);
      assert.equal(out.eligible, 0);
      assert.equal(out.reason_counts.no_next_manual_first_intent, 1);
      assert.equal(sb.inserts.length, 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron normal ignora eventos force_test para cooldown", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({
        prefRows: [prefEligible({ sms_enabled: false, preferred_channel: "email" })],
        lastUserReminderIso: "2030-06-14T12:00:00.000Z",
        lastUserReminderMetadata: { force_test: true }
      });
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 1);
      assert.equal(out.eligible, 1);
      assert.equal(out.reason_counts.cooldown_active, undefined);
      assert.equal(sb.inserts.length, 1);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron response sanitiza error crudo del provider", async () => {
    const prev = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test";
    try {
      const sb = makeCronSupabase({ prefRows: [prefEligible()], lastUserReminderIso: null });
      const err = new Error("provider raw body with sk_live_secret and Authorization header");
      err.code = "E_PROVIDER_RAW";
      const out = await runDuePaymentReminders({
        supabaseAdmin: sb,
        getIntentAmount: (intent) => Number(intent.amount || 0),
        now: fixedNow,
        env: process.env,
        sendReminderFn: async () => {
          throw err;
        }
      });
      assert.equal(out.ok, true);
      assert.equal(out.sent, 0);
      assert.equal(out.errors.length, 1);
      assert.equal(out.errors[0].message, "provider_send_failed");
      assert.equal(out.errors[0].code, "E_PROVIDER_RAW");
      const serialized = JSON.stringify(out);
      assert.doesNotMatch(serialized, /sk_live_secret/i);
      assert.doesNotMatch(serialized, /Authorization header/i);
      assert.doesNotMatch(serialized, /provider raw body/i);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

});


describe("notifications UI frequency safety", () => {
  it("no expone daily en el selector de recordatorios", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "index.html"), "utf8");
    assert.doesNotMatch(html, /<option\s+value="daily"/i);
  });
});
