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

function makeSupabase({ prefs = [], debts = [], existingIntents = [] } = {}) {
  const intents = existingIntents.slice();
  const executions = [];
  const deletes = [];
  const api = {
    intents,
    executions,
    deletes,
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
    auto_track_minimum_payments: true,
    timezone: "UTC",
    preferred_language: "en",
    ...over
  };
}

describe("lib/minimum-payment-tracking", () => {
  it("no corre si la preferencia esta apagada", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref({ auto_track_minimum_payments: false })], debts: [dueDebt()] });
    let applyCalls = 0;
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        return { ok: true };
      }
    });
    assert.equal(out.tracked, 0);
    assert.equal(applyCalls, 0);
    assert.equal(supabaseAdmin.intents.length, 0);
  });

  it("corre si la preferencia esta activada y llego due_day", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt()] });
    let reconcileCalls = 0;
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async (_uid, intent, opts) => {
        assert.equal(intent.source, AUTO_TRACK_SOURCE);
        assert.equal(opts.amountOverride, 35);
        return { ok: true, skipped: false, previous_balance: 100, next_balance: 65 };
      },
      reconcileManualFirstPriorityIntent: async () => {
        reconcileCalls += 1;
      }
    });
    assert.equal(out.tracked, 1);
    assert.equal(supabaseAdmin.intents.length, 1);
    assert.equal(supabaseAdmin.executions.length, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(supabaseAdmin.intents[0].metadata.auto_tracked_minimum_payment, true);
    assert.equal(supabaseAdmin.intents[0].metadata.source, AUTO_TRACK_SOURCE);
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
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => {
        applyCalls += 1;
        return { ok: true };
      }
    });
    assert.equal(out.tracked, 0);
    assert.equal(out.reason_counts.already_tracked_for_date, 1);
    assert.equal(applyCalls, 0);
    assert.equal(supabaseAdmin.intents.length, 1);
  });

  it("escribe historial/traza clara sin decir que DebtYa hizo el pago", async () => {
    const supabaseAdmin = makeSupabase({ prefs: [pref()], debts: [dueDebt({ balance: 20, minimum_payment: 25 })] });
    const out = await runMinimumPaymentAutoTracking({
      supabaseAdmin,
      now: new Date("2030-05-19T12:00:00.000Z"),
      applyExecutedIntentToDebt: async () => ({ ok: true, skipped: false, previous_balance: 20, next_balance: 0 })
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
    assert.equal(result.reason, "not_due_today");
  });
});