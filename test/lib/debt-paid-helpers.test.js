const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  PAID_BALANCE_THRESHOLD,
  debtRowEligibleForPlan,
  debtRowListedAsPaid,
  debtRowListedAsActiveCarrying,
  isDebtBalancePaidOff
} = require("../../lib/debt-paid-helpers");

describe("lib/debt-paid-helpers", () => {
  it("threshold constant", () => {
    assert.equal(PAID_BALANCE_THRESHOLD, 0.01);
  });

  it("isDebtBalancePaidOff", () => {
    assert.equal(isDebtBalancePaidOff(0), true);
    assert.equal(isDebtBalancePaidOff(0.01), true);
    assert.equal(isDebtBalancePaidOff(0.02), false);
  });

  it("debtRowEligibleForPlan excluye paid y balance bajo", () => {
    assert.equal(debtRowEligibleForPlan({ is_active: true, status: "paid", balance: 500 }, Number), false);
    assert.equal(debtRowEligibleForPlan({ is_active: true, status: "active", balance: 0.005 }, Number), false);
    assert.equal(debtRowEligibleForPlan({ is_active: true, status: "active", balance: 100 }, Number), true);
  });

  it("debtRowListedAsPaid", () => {
    assert.equal(debtRowListedAsPaid({ is_active: true, status: "paid", balance: 5 }, Number), true);
    assert.equal(debtRowListedAsPaid({ is_active: true, status: "active", balance: 0 }, Number), true);
    assert.equal(debtRowListedAsPaid({ is_active: false, status: "active", balance: 0 }, Number), false);
  });

  it("debtRowListedAsActiveCarrying", () => {
    assert.equal(debtRowListedAsActiveCarrying({ is_active: true, status: "active", balance: 50 }, Number), true);
    assert.equal(debtRowListedAsActiveCarrying({ is_active: true, status: "paid", balance: 50 }, Number), false);
  });
});
