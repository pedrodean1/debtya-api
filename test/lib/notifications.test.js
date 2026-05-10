const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildNextPaymentReminderPreview,
  normalizePhoneNumber,
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
