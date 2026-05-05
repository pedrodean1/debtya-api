const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  pickPriorityDebtForManualPlan,
  computeManualPriorityPaymentAmount
} = require("../../lib/manual-plan-next-payment");

function safeNumber(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function mk(id, bal, apr, min = 0) {
  return {
    id,
    is_active: true,
    balance: bal,
    apr,
    minimum_payment: min
  };
}

describe("lib/manual-plan-next-payment", () => {
  it("avalanche: prioriza APR mas alto (B sobre A)", () => {
    const a = mk("a", 1000, 10);
    const b = mk("b", 500, 25);
    const p = pickPriorityDebtForManualPlan("avalanche", [a, b], safeNumber);
    assert.equal(p.id, "b");
  });

  it("snowball: prioriza menor balance cuando A=1000 B=500", () => {
    const a = mk("a", 1000, 10);
    const b = mk("b", 500, 25);
    const p = pickPriorityDebtForManualPlan("snowball", [a, b], safeNumber);
    assert.equal(p.id, "b");
  });

  it("snowball: prioriza menor balance cuando A=100 B=500", () => {
    const a = mk("a", 100, 10);
    const b = mk("b", 500, 25);
    const p = pickPriorityDebtForManualPlan("snowball", [a, b], safeNumber);
    assert.equal(p.id, "a");
  });

  it("no elige deudas con balance <= 0", () => {
    const a = mk("a", 0, 10);
    const b = mk("b", -5, 25);
    assert.equal(pickPriorityDebtForManualPlan("snowball", [a, b], safeNumber), null);
    assert.equal(pickPriorityDebtForManualPlan("avalanche", [a, b], safeNumber), null);
  });

  it("computeManualPriorityPaymentAmount no supera el balance", () => {
    const debt = mk("x", 100, 15, 40);
    const plan = { monthly_budget: 900, extra_payment_default: 50 };
    const amt = computeManualPriorityPaymentAmount(debt, plan, safeNumber);
    assert.ok(amt <= 100);
    assert.ok(amt > 0);
  });

  it("avalanche sin APR positivo: fallback por balance descendente", () => {
    const a = mk("a", 1000, 0);
    const b = mk("b", 500, 0);
    const p = pickPriorityDebtForManualPlan("avalanche", [a, b], safeNumber);
    assert.equal(p.id, "a");
  });
});
