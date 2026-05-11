const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { compareStrategiesFromDebtRows } = require("../../lib/strategy-compare-sim");

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

describe("lib/strategy-compare-sim", () => {
  it("Avalanche vs Snowball can target different first extra debts and diverge totals", () => {
    const debts = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Large balance high APR",
        balance: 5000,
        apr: 24,
        minimum_payment: 100
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Small balance low APR",
        balance: 800,
        apr: 6,
        minimum_payment: 40
      }
    ];

    const out = compareStrategiesFromDebtRows(debts, 250, 0, safeNumber);
    assert.equal(out.insufficient_data, false);
    const av = out.avalanche;
    const sn = out.snowball;
    assert.ok(av.first_recommended_debt);
    assert.ok(sn.first_recommended_debt);
    assert.notEqual(av.first_recommended_debt.id, sn.first_recommended_debt.id);
    assert.notEqual(av.total_interest, sn.total_interest);
  });

  it("Uses current_balance when balance missing", () => {
    const debts = [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "Only current_balance",
        current_balance: 400,
        apr: 12,
        minimum_payment: 40
      }
    ];
    const out = compareStrategiesFromDebtRows(debts, 0, 0, safeNumber);
    assert.equal(out.insufficient_data, false);
    assert.ok(out.avalanche.months_numeric > 0);
    assert.ok(out.snowball.months_numeric > 0);
  });

  it("Insufficient when no positive balances", () => {
    const out = compareStrategiesFromDebtRows([], 100, 0, safeNumber);
    assert.equal(out.insufficient_data, true);
    assert.equal(out.avalanche, null);
  });
});
