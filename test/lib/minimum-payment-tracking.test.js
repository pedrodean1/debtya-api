const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  AUTO_TRACK_SOURCE,
  computeAutoTrackedMinimumPayment,
  debtIsEligibleForAutoTrack,
  runMinimumPaymentAutoTracking
} = require("../../lib/minimum-payment-tracking");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

function makeSelectChain(rows) {
  const filters = [];
  let limitCount = null;
  const chain = {
    eq(key, value) {
      filters.push({ key, value });
      return chain;
    },
    order() {
      return chain;
    },
    limit(n) {
      limitCount = Number(n);
      return Promise.resolve({ data: materialize(), error: null });
    },
    then(resolve, reject) {
      return Promise.resolve({ data: materialize(), error: null }).then(resolve, reject);
    }
  };
  function materialize() {
    let out = rows.slice();
    for (const f of filters) out = out.filter((row) => row && row[f.key] === f.value);
    if (Number.isFinite(limitCount)) out = out.slice(0, limitCount);
    return out;
  }
  return chain;
}

function makeSupabase({ prefs = [], debts = [], existingIntents = [], existingEvents = [] } = {}) {
  const intents = existingIntents.slice();
  const events = existingEvents.slice();
  const executions = [];
  const deletes = [];
  const eventUpdates = [];
  const api = {
    intents,
    events,
    executions,
    deletes,
    eventUpdates,
    from(table) {
      if (table === "notification_preferences") {
        return {
          select() {
            return makeSelectChain(prefs);
          }
        };
      }
      if (table === "debts") {
        return {
          select() {
            return makeSelectChain(debts);
          }
        };
      }
      if (table === "payment_intents") {
        return {
          select() {
            return makeSelectChain(intents);
          },
          insert(payload) {
            const row = { id: `intent-${intents.length + 1}`, ...payload };
            intents.push(row);
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: row, error: null });
                  }
                };
              }
            };
          },
          delete() {
            const chain = {
              eq(key, value) {
                deletes.push({ table, key, value });
                return chain;
              }
            };
            return chain;
          }
        };
      }
      if (table === "notification_events") {
        return {
          select() {
            return makeSelectChain(events);
          },
          insert(payload) {
            const row = { id: `event-${events.length + 1}`, created_at: "2030-05-19T12:00:00.000Z", ...payload };
            events.push(row);
            return {
              select() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { id: row.id }, error: null });
                  }
                };
              }
            };
          },
          update(payload) {
            const filters = [];
            const chain = {
              eq(key, value) {
                filters.push({ key, value });
                return chain;
              },
              then(resolve, reject) {
                eventUpdates.push({ filters, payload });
                for (const row of events) {
                  if (filters.every((f) => row && row[f.key] === f.value)) {
                    Object.assign(row, payload);
                  }
                }
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              }
            };
            return chain;
          }
        };
      }
      if (table === "payment_executions") {
        return {
          upsert(payload) {
            executions.push(payload);
            return Promise.resolve({ data: payload, error: null });
          },
          delete() {
            const chain = {
              eq(key, value) {
                deletes.push({ table, key, value });
                return chain;
              }
            };
            return chain;
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };
  return api;
}

function dueDebt(over = {}) {
  return {
    id: debtId,
    user_id: userId,
    is_active: true,
    status: "active",
    balance: 100,
    minimum_payment: 35,
    due_day: 19,
    ...over
  };
}

function pref(over = {}) {
  return {
    user_id: userId,
    email_enabled: true,
    consent_email_at: "2030-01-01T00:00:00.000Z",
    auto_track_minimum_payments: true,
    timezone: "UTC",
    preferred_language: "en",
    ...over
  };
}

function emailDeps(events = []) {
  return {
    fetchAuthUserEmailFn: async () => "user@example.com",
    sendMinimumPaymentDueEmailFn: async (args) => {
      events.push({ type: "due_email", args });
      return { ok: true, sent: true, user_email: "user@example.com" };
    },
    sendTransactionalPaymentCelebrationEmailsFn: async (args) => {
      events.push({ type: "payment_recorded_email", args });
      return { ok: true, payment_email: true };
    }
  };
}

describe("lib/minimum-payment-tracking", () => {
  it("no corre si la preferencia esta apagada", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref({ auto_track_minimum_payments: false })], debts: [dueDebt()] });
    let applyCalls = 0;
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        return { ok: true };
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 0);
    assert.equal(out.reason_counts.missing_auto_track_opt_in, 1);
    assert.equal(applyCalls, 0);
    assert.deepEqual(events, []);
    assert.equal(supabaseAdmin.intents.length, 0);
  });

  it("no envia ni rebaja si email no esta habilitado/consentido", async () => {
    const supabaseAdmin = makeSupabase({
      prefs: [pref({ email_enabled: false, consent_email_at: null })],
      debts: [dueDebt()]
    });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        events.push({ type: "apply" });
        return { ok: true };
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 0);
    assert.equal(out.reason_counts.missing_email_enabled, 1);
    assert.equal(supabaseAdmin.events.length, 0);
    assert.deepEqual(events, []);
  });

  it("envia email previo, rebaja y luego dispara email transaccional si llego due_day", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt()] });
    const events = [];
    let reconcileCalls = 0;
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async (_uid, intent, opts) => {
        events.push({ type: "apply", intent, opts });
        assert.equal(intent.source, AUTO_TRACK_SOURCE);
        assert.equal(opts.amountOverride, 35);
        return { ok: true, skipped: false, previous_balance: 100, next_balance: 65 };
      },
      reconcileManualFirstPriorityIntent: async () => {
        reconcileCalls += 1;
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    assert.equal(out.minimum_due_emails_sent, 1);
    assert.equal(out.payment_recorded_emails_sent, 1);
    assert.equal(out.reason_counts.due_email_sent, 1);
    assert.equal(out.reason_counts.tracked_success, 1);
    assert.equal(supabaseAdmin.intents.length, 1);
    assert.equal(supabaseAdmin.events.length, 1);
    assert.equal(supabaseAdmin.events[0].event_type, "minimum_payment_due");
    assert.equal(supabaseAdmin.events[0].metadata.debt_id, debtId);
    assert.equal(supabaseAdmin.events[0].metadata.date_key, "2030-05-19");
    assert.equal(supabaseAdmin.events[0].metadata.delivery_status, "sent");
    assert.equal(supabaseAdmin.executions.length, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(supabaseAdmin.intents[0].metadata.auto_tracked_minimum_payment, true);
    assert.equal(supabaseAdmin.intents[0].metadata.source, AUTO_TRACK_SOURCE);
    assert.deepEqual(events.map((e) => e.type), ["due_email", "apply", "payment_recorded_email"]);
    assert.equal(events[0].args.preferredLanguage, "en");
    assert.equal(events[2].args.preferredLanguageHint, "en");
  });

  it("no reenvia el email previo si ya fue auditado para la misma deuda y fecha", async () => {
    const supabaseAdmin = makeSupabase({
      prefs: [pref()],
      debts: [dueDebt()],
      existingEvents: [
        {
          id: "event-existing",
          user_id: userId,
          channel: "email",
          event_type: "minimum_payment_due",
          created_at: "2030-05-19T11:00:00.000Z",
          metadata: {
            audit_type: "minimum_payment_due",
            debt_id: debtId,
            date_key: "2030-05-19",
            delivery_status: "sent"
          }
        }
      ]
    });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async (_uid, intent, opts) => {
        events.push({ type: "apply", intent, opts });
        return { ok: true, skipped: false, previous_balance: 100, next_balance: 65 };
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    assert.equal(out.reason_counts.due_email_already_sent, 1);
    assert.equal(out.reason_counts.tracked_success, 1);
    assert.equal(supabaseAdmin.events.length, 1);
    assert.deepEqual(events.map((e) => e.type), ["apply", "payment_recorded_email"]);
  });

  it("no bloquea el email minimo por eventos auto_reminder recientes", async () => {
    const supabaseAdmin = makeSupabase({
      prefs: [pref()],
      debts: [dueDebt()],
      existingEvents: [
        {
          id: "general-reminder",
          user_id: userId,
          channel: "email",
          event_type: "auto_reminder",
          created_at: "2030-05-19T11:30:00.000Z",
          metadata: {}
        }
      ]
    });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => ({ ok: true, skipped: false, previous_balance: 100, next_balance: 65 }),
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    assert.equal(out.reason_counts.due_email_sent, 1);
    assert.equal(supabaseAdmin.events.length, 2);
    assert.equal(events.filter((e) => e.type === "due_email").length, 1);
  });

  it("audita fallo del email previo y no rebaja balance", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt()] });
    let applyCalls = 0;
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        return { ok: true };
      },
      fetchAuthUserEmailFn: async () => "user@example.com",
      sendMinimumPaymentDueEmailFn: async () => ({
        ok: true,
        sent: false,
        skipped: true,
        reason: "provider_returned_not_sent",
        preview: { subject: "Due", email_body: "Body" }
      }),
      sendTransactionalPaymentCelebrationEmailsFn: async () => ({ ok: true, payment_email: true })
    });
    assert.equal(out.tracked, 0);
    assert.equal(out.email_failures, 1);
    assert.equal(out.reason_counts.due_email_failed, 1);
    assert.equal(applyCalls, 0);
    assert.equal(supabaseAdmin.events.length, 1);
    assert.equal(supabaseAdmin.events[0].metadata.delivery_status, "failed");
    assert.equal(supabaseAdmin.intents.length, 0);
  });

  it("no baja balance debajo de cero: usa el balance restante si es menor que el minimo", () => {
    const computed = computeAutoTrackedMinimumPayment(dueDebt({ balance: 12, minimum_payment: 35 }));
    assert.equal(computed.amount, 12);
    assert.equal(computed.amount_clamped, true);
  });

  it("no duplica el mismo pago en la misma fecha", async () => {
    const supabaseAdmin = makeSupabase({
      prefs: [pref()],
      debts: [dueDebt()],
      existingIntents: [
        {
          id: "existing-intent",
          user_id: userId,
          debt_id: debtId,
          source: AUTO_TRACK_SOURCE,
          scheduled_for: "2030-05-19"
        }
      ]
    });
    let applyCalls = 0;
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        return { ok: true };
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 0);
    assert.equal(out.reason_counts.already_tracked_today, 1);
    assert.equal(applyCalls, 0);
    assert.deepEqual(events, []);
    assert.equal(supabaseAdmin.intents.length, 1);
  });

  it("no duplica emails ni rebaja si el cron corre dos veces el mismo dia", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt()] });
    const events = [];
    let applyCalls = 0;
    const deps = {
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        events.push({ type: "apply" });
        return { ok: true, skipped: false, previous_balance: 100, next_balance: 65 };
      },
      ...emailDeps(events)
    };
    const first = await runMinimumPaymentAutoTracking(deps);
    const second = await runMinimumPaymentAutoTracking(deps);
    assert.equal(first.tracked, 1);
    assert.equal(second.tracked, 0);
    assert.equal(second.reason_counts.already_tracked_today, 1);
    assert.equal(applyCalls, 1);
    assert.deepEqual(events.map((e) => e.type), ["due_email", "apply", "payment_recorded_email"]);
  });

  it("registra solo el balance restante cuando es menor que el minimo", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt({ balance: 12, minimum_payment: 35 })] });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async (_uid, _intent, opts) => {
        events.push({ type: "apply", amount: opts.amountOverride });
        return { ok: true, skipped: false, previous_balance: 12, next_balance: 0 };
      },
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    assert.equal(supabaseAdmin.intents[0].amount, 12);
    assert.equal(events.find((e) => e.type === "due_email").args.amount, 12);
    assert.equal(events.find((e) => e.type === "apply").amount, 12);
  });

  it("escribe historial/traza clara sin decir que DebtYa hizo el pago", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt({ balance: 20, minimum_payment: 25 })] });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => ({ ok: true, skipped: false, previous_balance: 20, next_balance: 0 }),
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    const intent = supabaseAdmin.intents[0];
    assert.equal(intent.notes, "Auto-tracked minimum payment");
    assert.equal(intent.metadata.date_applied, "2030-05-19");
    assert.equal(intent.metadata.due_day, 19);
    assert.equal(supabaseAdmin.executions[0].payment_intent_id, intent.id);
    const serialized = JSON.stringify(intent);
    assert.doesNotMatch(serialized, /DebtYa made/i);
    assert.doesNotMatch(serialized, /DebtYa paid/i);
    assert.doesNotMatch(serialized, /moved money/i);
    assert.match(intent.metadata.manual_first_note, /did not make the payment/i);
  });

  it("detecta deuda no elegible cuando no es su due_day", () => {
    const result = debtIsEligibleForAutoTrack(dueDebt({ due_day: 20 }), 19);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_due_today");
  });

  it("detecta minimo faltante y balance cero con razones separadas", () => {
    const noMin = debtIsEligibleForAutoTrack(dueDebt({ minimum_payment: 0, min_payment: 0 }), 19);
    assert.equal(noMin.ok, false);
    assert.equal(noMin.reason, "missing_min_payment");
    const zeroBalance = debtIsEligibleForAutoTrack(dueDebt({ balance: 0, minimum_payment: 35 }), 19);
    assert.equal(zeroBalance.ok, false);
    assert.equal(zeroBalance.reason, "zero_balance");
  });

  it("acepta payment_due_day como alias de due_day", () => {
    const result = debtIsEligibleForAutoTrack(dueDebt({ due_day: undefined, payment_due_day: 19 }), 19);
    assert.equal(result.ok, true);
  });

  it("acepta min_payment como alias positivo de minimum_payment", () => {
    const computed = computeAutoTrackedMinimumPayment(dueDebt({ minimum_payment: 0, min_payment: 18 }));
    assert.equal(computed.amount, 18);
  });

  it("pasa idioma espanol al email previo y al transaccional", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref({ preferred_language: "es" })], debts: [dueDebt()] });
    const events = [];
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => ({ ok: true, skipped: false, previous_balance: 100, next_balance: 65 }),
      ...emailDeps(events)
    });
    assert.equal(out.tracked, 1);
    assert.equal(events.find((e) => e.type === "due_email").args.preferredLanguage, "es");
    assert.equal(events.find((e) => e.type === "payment_recorded_email").args.preferredLanguageHint, "es");
  });
});
