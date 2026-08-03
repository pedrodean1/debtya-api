const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  retireStaleOpenPaymentIntentsForInactiveDebts,
  stalePaymentIntentDebtReason
} = require("../../lib/payment-intent-stale-guard");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeSupabaseMock({ debts, updates, debtSelects = [], rejectedStatuses = [] }) {
  const rejectedStatusSet = new Set(rejectedStatuses);
  return {
    from(table) {
      if (table === "debts") {
        return {
          select(columns) {
            debtSelects.push(columns);
            return {
              eq() {
                return {
                  in(_col, ids) {
                    const wanted = new Set((ids || []).map(String));
                    return Promise.resolve({
                      data: debts.filter((debt) => wanted.has(String(debt.id))),
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
      if (table === "payment_intents") {
        return {
          update(payload) {
            const call = { payload, eqs: [], inArgs: null };
            updates.push(call);
            const builder = {
              eq(col, value) {
                call.eqs.push({ col, value });
                return builder;
              },
              in(col, values) {
                call.inArgs = { col, values };
                if (payload.status && rejectedStatusSet.has(payload.status)) {
                  return Promise.resolve({
                    error: {
                      code: "23514",
                      message:
                        'new row for relation "payment_intents" violates check constraint "payment_intents_status_check"'
                    }
                  });
                }
                return Promise.resolve({ error: null });
              }
            };
            return builder;
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
}

describe("lib/payment-intent-stale-guard", () => {
  it("clasifica deudas no pagables para intents abiertos", () => {
    assert.equal(stalePaymentIntentDebtReason(null, safeNumber), "debt_missing");
    assert.equal(stalePaymentIntentDebtReason({ is_active: false, balance: 100 }, safeNumber), "debt_inactive");
    assert.equal(stalePaymentIntentDebtReason({ is_active: true, status: "paid", balance: 100 }, safeNumber), "debt_paid");
    assert.equal(stalePaymentIntentDebtReason({ is_active: true, status: "paid_off", balance: 100 }, safeNumber), "debt_paid");
    assert.equal(stalePaymentIntentDebtReason({ is_active: true, status: "active", current_balance: 0 }, safeNumber), "debt_zero_balance");
    assert.equal(stalePaymentIntentDebtReason({ is_active: true, status: "active", balance: 100 }, safeNumber), null);
  });

  it("retira intents abiertos stale y no toca executed ni deuda activa", async () => {
    const debts = [
      { id: "debt-active", is_active: true, status: "active", balance: 200 },
      { id: "debt-paid", is_active: true, status: "paid", balance: 0 },
      { id: "debt-paid-off", is_active: true, status: "paid_off", balance: 500 },
      { id: "debt-zero-current", is_active: true, status: "active", current_balance: 0 }
    ];
    const intents = [
      { id: "intent-active", user_id: userId, debt_id: "debt-active", status: "pending_review", metadata: {} },
      { id: "intent-paid", user_id: userId, debt_id: "debt-paid", status: "pending_review", metadata: {} },
      { id: "intent-paid-off", user_id: userId, debt_id: "debt-paid-off", status: "approved", metadata: {} },
      { id: "intent-zero-current", user_id: userId, debt_id: "debt-zero-current", status: "draft", metadata: {} },
      { id: "intent-executed", user_id: userId, debt_id: "debt-paid", status: "executed", metadata: {} }
    ];
    const updates = [];
    const debtSelects = [];

    const out = await retireStaleOpenPaymentIntentsForInactiveDebts({
      userId,
      intents,
      supabaseAdmin: makeSupabaseMock({ debts, updates, debtSelects }),
      safeNumber,
      nowIso: "2026-07-31T00:00:00.000Z"
    });

    assert.equal(debtSelects[0], "id,status,balance,is_active");
    assert.equal(String(debtSelects[0]).includes("current_balance"), false);
    assert.equal(out.retired_count, 3);
    assert.deepEqual(out.reason_counts, { debt_paid: 2, debt_zero_balance: 1 });
    assert.equal(out.intents.find((x) => x.id === "intent-active").status, "pending_review");
    assert.equal(out.intents.find((x) => x.id === "intent-paid").status, "cancelled");
    assert.equal(out.intents.find((x) => x.id === "intent-paid-off").status, "cancelled");
    assert.equal(out.intents.find((x) => x.id === "intent-zero-current").status, "cancelled");
    assert.equal(out.intents.find((x) => x.id === "intent-executed").status, "executed");
    assert.equal(updates.length, 3);
    assert.equal(updates[0].payload.status, "cancelled");
    assert.equal(updates[0].payload.metadata.stale_intent_retired_at, "2026-07-31T00:00:00.000Z");
  });

  it("no falla si la base rechaza estados terminales al retirar stale intents", async () => {
    const debts = [{ id: "debt-paid", is_active: true, status: "paid", balance: 0 }];
    const intents = [
      { id: "intent-paid", user_id: userId, debt_id: "debt-paid", status: "pending_review", metadata: {} }
    ];
    const updates = [];

    const out = await retireStaleOpenPaymentIntentsForInactiveDebts({
      userId,
      intents,
      supabaseAdmin: makeSupabaseMock({
        debts,
        updates,
        rejectedStatuses: ["cancelled", "canceled"]
      }),
      safeNumber,
      nowIso: "2026-07-31T00:00:00.000Z"
    });

    assert.equal(out.retired_count, 1);
    assert.equal(out.status_fallback_count, 1);
    assert.deepEqual(out.reason_counts, { debt_paid: 1 });
    assert.equal(out.intents[0].status, "cancelled");
    assert.equal(updates.length, 3);
    assert.equal(updates[0].payload.status, "cancelled");
    assert.equal(updates[1].payload.status, "canceled");
    assert.equal(updates[2].payload.status, undefined);
    assert.equal(updates[2].payload.metadata.payment_intent_retired_status_fallback, "metadata_only");
  });
});
