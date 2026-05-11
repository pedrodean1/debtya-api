const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNextPaymentReminderPreview,
  defaultNotificationPreferences,
  minGapMsForCadence,
  minUserWideGapMs,
  normalizePhoneNumber,
  normalizeReminderFrequency,
  resolveDebtYaReminderFromAddress,
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

  it("sin reminder_frequency en body usa weekly por defecto", () => {
    const out = validateNotificationPreferencesInput({ email_enabled: true, email_consent: true }, null);
    assert.ok(out.payload);
    assert.equal(out.payload.reminder_frequency, "weekly");
  });

  it("normaliza reminder_frequency desconocido a weekly", () => {
    assert.equal(normalizeReminderFrequency("bogus"), "weekly");
  });

  it("defaultNotificationPreferences usa weekly", () => {
    const d = defaultNotificationPreferences(userId);
    assert.equal(d.reminder_frequency, "weekly");
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

  it("minGapMsForCadence: moderacion semanal para smart y daily", () => {
    const w = minGapMsForCadence("weekly");
    assert.equal(minGapMsForCadence("daily"), w);
    assert.equal(minGapMsForCadence("smart"), w);
    assert.ok(minGapMsForCadence("twice_weekly") < w);
    assert.equal(minGapMsForCadence("off"), Number.POSITIVE_INFINITY);
  });

  it("minUserWideGapMs twice_weekly mas corto que weekly", () => {
    assert.ok(minUserWideGapMs("twice_weekly") < minUserWideGapMs("weekly"));
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
    assert.match(preview.message, /Pay \$82\.00 to CBUSASEARS/);
    assert.match(preview.message, /outside DebtYa/);
  });

  it("preview email EN con APR incluye ballpark de interes", async () => {
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
    assert.match(preview.email_body || preview.message, /Ballpark/i);
    assert.match(preview.email_body || preview.message, /APR/i);
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
    assert.match(preview.message, /Ya lo pague/i);
    assert.match(preview.message, /fuera de DebtYa/i);
  });
});

describe("runDuePaymentReminders cron (V100)", () => {
  const fixedNow = new Date("2030-06-15T12:00:00.000Z");

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

  function makeCronSupabase({ prefRows, lastUserReminderIso = null }) {
    const inserts = [];
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
                                    data: lastUserReminderIso ? { created_at: lastUserReminderIso } : null,
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
                              return Promise.resolve({ data: [intentRow], error: null });
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

  const prefEligible = () => ({
    user_id: userId,
    email_enabled: true,
    sms_enabled: true,
    phone_number: "+15551239999",
    preferred_channel: "both",
    consent_email_at: "2030-01-01T00:00:00.000Z",
    consent_sms_at: "2030-01-01T00:00:00.000Z",
    reminder_frequency: "weekly",
    reminder_time: null,
    timezone: null
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
      assert.equal(calls, 0);
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  it("cron forceTest omite cooldown y registra metadata.force_test en evento", async () => {
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
        now: fixedNow,
        env: process.env,
        forceTest: true,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.force_test, true);
      assert.equal(out.sent, 1);
      assert.equal(sb.inserts.length, 1);
      assert.equal(sb.inserts[0].metadata.force_test, true);
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
        now: fixedNow,
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
        now: fixedNow,
        env: process.env,
        forceTest: true,
        sendReminderFn: async () => ({ channel: "email", sent: true, provider: "resend" })
      });
      assert.equal(out.sent, 0);
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
    } finally {
      if (prev == null) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });
});
