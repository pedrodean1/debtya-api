const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildMinimumPaymentDueEmailPreview,
  buildPaymentRecordedTransactionalCopy,
  buildDebtPaidOffTransactionalCopy,
  sendTransactionalPaymentCelebrationEmails
} = require("../../lib/notifications");

function metaSupabase(metadataByRead) {
  const arr = Array.isArray(metadataByRead) ? metadataByRead : [metadataByRead];
  let i = 0;
  return {
    from(table) {
      if (table === "notification_preferences") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { preferred_language: "en" }, error: null });
                  }
                };
              }
            };
          }
        };
      }
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

function transactionalSupabase({ prefRow = { preferred_language: "en" }, intentMetas = [{}] } = {}) {
  const metaArr = Array.isArray(intentMetas) ? intentMetas : [intentMetas];
  let metaIdx = 0;
  return {
    from(table) {
      if (table === "notification_preferences") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: { user_id: "550e8400-e29b-41d4-a716-446655440000", ...prefRow },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      const meta = metaArr[Math.min(metaIdx, metaArr.length - 1)] ?? {};
                      metaIdx += 1;
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
  it("EN minimum payment due email usa copy manual-first y solo email", () => {
    const c = buildMinimumPaymentDueEmailPreview({
      preferredLanguage: "en",
      amount: 35,
      debtName: "Visa"
    });
    assert.equal(c.channel, "email");
    assert.match(c.body || c.email_body, /Today is your scheduled minimum payment day for Visa\./);
    assert.match(c.email_body, /DebtYa does not make the payment for you\./);
    assert.match(c.email_body, /DebtYa will record the minimum payment amount you set and update your progress\./);
    assert.doesNotMatch(c.email_body, /automatic payment made/i);
    assert.doesNotMatch(c.email_body, /will send money/i);
  });

  it("ES minimum payment due email respeta preferred_language", () => {
    const c = buildMinimumPaymentDueEmailPreview({
      preferredLanguage: "es",
      amount: 12,
      debtName: "Tarjeta"
    });
    assert.equal(c.channel, "email");
    assert.match(c.email_body, /Hoy es el día del pago mínimo programado para Tarjeta\./);
    assert.match(c.email_body, /DebtYa no hace el pago por ti\./);
    assert.match(c.email_body, /Si tienes activado el registro automático de pagos mínimos/);
  });

  it("ES pago registrado contiene frase clave", () => {
    const c = buildPaymentRecordedTransactionalCopy("es", 50, "Visa");
    assert.match(c.subject, /Pago registrado: Visa/i);
    assert.match(c.body, /DebtYa no mueve dinero/i);
    assert.match(c.body, /Registramos tu pago.*Visa/);
    assert.match(c.body, /Pago aplicado a: Visa/);
  });

  it("EN pago registrado contiene reminder", () => {
    const c = buildPaymentRecordedTransactionalCopy("en", 25.5, "Card");
    assert.match(c.subject, /Payment recorded: Card/i);
    assert.match(c.body, /DebtYa does not move money/i);
    assert.match(c.body, /We recorded your.*payment toward Card/);
    assert.match(c.body, /Payment applied to: Card/);
  });

  it("ES celebración usa ¡Felicidades!", () => {
    const c = buildDebtPaidOffTransactionalCopy("es", "Loan A");
    assert.match(c.subject, /¡Felicidades!/);
    assert.match(c.subject, /Loan A/);
    assert.match(c.body, /Loan A/);
    assert.match(c.body, /La movimos a Deudas pagadas/);
  });

  it("EN celebración usa Congrats", () => {
    const c = buildDebtPaidOffTransactionalCopy("en", "Loan B");
    assert.match(c.subject, /Congrats/);
    assert.match(c.subject, /Loan B/);
    assert.match(c.body, /Loan B/);
    assert.match(c.body, /We moved it to Paid debts/);
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
    assert.equal(out.ok, false);
    assert.equal(out.reason, "provider_send_failed");
    assert.equal(out.payment_email, false);
    assert.ok(out.payment_email_error);
    assert.equal(merges, 0);
  });

  it("sin provider configurado devuelve motivo seguro y no envía", async () => {
    let sends = 0;
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
      env: {},
      mergeIntentMetadata: async () => {
        throw new Error("should not merge");
      },
      appError: () => {},
      sendEmailFn: async () => {
        sends += 1;
      }
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "email_provider_not_configured");
    assert.equal(out.payment_email, false);
    assert.equal(sends, 0);
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

  it("hint es fuerza español aunque notification_preferences sea en", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "en" },
        intentMetas: {}
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 50,
      previousDebtStatus: "active",
      preferredLanguageHint: "es",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Pago registrado/i);
  });

  it("hint en fuerza inglés aunque notification_preferences sea es", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "es" },
        intentMetas: {}
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 50,
      previousDebtStatus: "active",
      preferredLanguageHint: "en",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Payment recorded/i);
  });

  it("hint inválido normaliza a en aunque preferences sean es", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "es" },
        intentMetas: {}
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 50,
      previousDebtStatus: "active",
      preferredLanguageHint: "fr",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Payment recorded/i);
  });

  it("payment recorded email usa español cuando preferred_language es es", async () => {
    const subjects = [];
    const out = await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "es" },
        intentMetas: {}
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 10,
      debtNameDisplay: "X",
      previousBalance: 100,
      nextBalance: 50,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.equal(out.payment_email, true);
    assert.match(subjects[0], /Pago registrado/i);
  });

  it("hint es y deuda liquidada envía celebración en español", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "en" },
        intentMetas: [{}, {}]
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 100,
      debtNameDisplay: "Card",
      previousBalance: 80,
      nextBalance: 0,
      previousDebtStatus: "active",
      preferredLanguageHint: "es",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Pago registrado/i);
    assert.match(subjects[1], /Felicidades/i);
  });

  it("debt paid celebration email usa español cuando preferred_language es es", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "es" },
        intentMetas: [{}, {}]
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 100,
      debtNameDisplay: "Card",
      previousBalance: 80,
      nextBalance: 0,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Pago registrado/i);
    assert.match(subjects[1], /Felicidades/i);
  });

  it("payment recorded y celebración en inglés cuando preferred_language es en", async () => {
    const subjects = [];
    await sendTransactionalPaymentCelebrationEmails({
      supabaseAdmin: transactionalSupabase({
        prefRow: { preferred_language: "en" },
        intentMetas: [{}, {}]
      }),
      userId: "550e8400-e29b-41d4-a716-446655440000",
      userEmail: "a@b.com",
      intentId: "660e8400-e29b-41d4-a716-446655440000",
      amount: 100,
      debtNameDisplay: "Card",
      previousBalance: 80,
      nextBalance: 0,
      previousDebtStatus: "active",
      env: { RESEND_API_KEY: "re_test_xxx" },
      mergeIntentMetadata: async () => {},
      appError: () => {},
      sendEmailFn: async (opts) => {
        subjects.push(opts.preview?.subject || "");
      }
    });
    assert.match(subjects[0], /Payment recorded/i);
    assert.match(subjects[1], /Congrats/);
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
