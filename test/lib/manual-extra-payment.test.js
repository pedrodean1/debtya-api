const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeManualExtraAppliedAmount, round2 } = require("../../lib/manual-extra-payment");

describe("lib/manual-extra-payment", () => {
  it("round2 redondea a 2 decimales", () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(10.999), 11);
  });

  it("aplica monto completo cuando cabe en balance", () => {
    const out = computeManualExtraAppliedAmount(50, 200);
    assert.equal(out.requested, 50);
    assert.equal(out.balance_snapshot, 200);
    assert.equal(out.applied, 50);
    assert.equal(out.amount_clamped, false);
  });

  it("clamp seguro al balance con amount_clamped", () => {
    const out = computeManualExtraAppliedAmount(100, 40.5);
    assert.equal(out.requested, 100);
    assert.equal(out.balance_snapshot, 40.5);
    assert.equal(out.applied, 40.5);
    assert.equal(out.amount_clamped, true);
  });

  it("rechaza monto cero o negativo en applied", () => {
    const z = computeManualExtraAppliedAmount(0, 100);
    assert.equal(z.applied, 0);
    assert.equal(z.amount_clamped, false);
    const neg = computeManualExtraAppliedAmount(-5, 100);
    assert.equal(neg.applied, 0);
  });

  it("no baja balance por debajo de cero (balance ya cero)", () => {
    const out = computeManualExtraAppliedAmount(50, 0);
    assert.equal(out.applied, 0);
    assert.equal(out.amount_clamped, true);
  });
});
