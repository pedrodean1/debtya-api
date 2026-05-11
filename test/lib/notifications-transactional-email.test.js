const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPaymentRecordedTransactionalCopy,
  buildDebtPaidOffTransactionalCopy,
  sendTransactionalPaymentCelebrationEmails
} = require("../../lib/notifications");

function metaSupabase(metadataByRead) {
  const arr = Array.isArray(metadataByRead) ? metadataByRead : [metadataByRead];
  let i = 0;
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      const meta = arr[Math.min(i, arr.length - 1)] ?? {};
                      i += 1;
                      return Promise.resolve({ data: { metadata: meta }, error: null });
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

describe("lib/notifications transactional copy", () => {
  it("ES pago registrado contiene frase clave", () => {
    const c = buildPaymentRecordedTransactionalCopy("es", 50, "Visa");
    assert.match(c.subject, /Pago registrado/i);
    assert.match(c.body, /DebtYa no mueve dinero/i);
    assert.match(c.body, /Visa/);
  });

  it("EN pago registrado contiene reminder", () => {
    const c = buildPaymentRecordedTransactionalCopy("en", 25.5, "Card");
    assert.match(c.subject, /Payment recorded/i);
    assert.match(c.body, /DebtYa does not move money/i);
  });

  it("ES celebración usa ¡Felicidades!", () => {
    const c = buildDebtPaidOffTransactionalCopy("es", "Loan A");
    assert.match(c.subject, /¡Felicidades!/);
    assert.match(c.body, /Loan A/);
  });

  it("EN celebración usa Congrats", () => {
    const c = buildDebtPaidOffTransactionalCopy("en", "Loan B");
    assert.match(c.subject, /Congrats/);
    assert.match(c.body, /Loan B/);
  });

  it("no duplica pago si metadata ya tiene payment_recorded_email_sent_at", async () => {
    const out = await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: metaSupabase({ payment_recorded_email_sent_at: "2020-01-01" }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 90,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {
        throw new Error("should not merge");
      },
      appError: () => {}
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "payment_email_already_sent");
  });

  it("si envío falla, no marca metadata de pago", async () => {
    let merges = 0;
    const out = await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: metaSupabase({}),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 90,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {
        merges += 1;
      },
      appError: () => {},
      sendEmailFn: async () => {
        throw new Error("Resend down");
      }
    });
    assert.equal(out.payment_email, false);
    assert.ok(out.payment_email_error);
    assert.equal(merges, 0);
  });

  it("deuda ya pagada y sin cambio: no envía emails", async () => {
    let sends = 0;
    const out = await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: metaSupabase({}),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 1,
      debtNameDisplay: "Z",
      previousBalance: 0,
      nextBalance: 0,
      previousDebtStatus: "paid",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {
        sends += 99;
      },
      appError: () => {},
      sendEmailFn: async () => {
        sends += 1;
      }
    });
    assert.equal(sends, 0);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "already_fully_paid_noop");
  });

  it("pago que liquida deuda: dos envíos y dos merges", async () => {
    let sends = 0;
    const merges = [];
    const out = await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: metaSupabase([{}, {}]),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 100,
      debtNameDisplay: "Card",
      previousBalance: 80,
      nextBalance: 0,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async (p) => {
        merges.push(Object.keys(p || {}));
      },
      appError: () => {},
      sendEmailFn: async () => {
        sends += 1;
      }
    });
    assert.equal(sends, 2);
    assert.equal(out.celebration, true);
    assert.equal(merges.length, 2);
  });
});
