const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSpinwheelPayableSummary } = require("../../lib/spinwheel-payable-summary");

function sn(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

const baseRawSupported = {
  liability: { payments: { billPayment: { availability: "SUPPORTED" } } }
};

const baseRawNotSupported = {
  liability: { payments: { billPayment: { availability: "NOT_SUPPORTED" } } }
};

describe("lib/spinwheel-payable-summary", () => {
  it("clasifica payable vs planning_only vs not_supported vs field_error", () => {
    const debtId1 = "a10e8400-e29b-41d4-a716-446655440001";
    const debtId2 = "a10e8400-e29b-41d4-a716-446655440002";
    const debtId3 = "a10e8400-e29b-41d4-a716-446655440003";
    const debtId4 = "a10e8400-e29b-41d4-a716-446655440004";
    const rows = [
      {
        id: debtId1,
        name: "Card A",
        balance: 100,
        minimum_payment: 25,
        apr: 19.99,
        spinwheel_external_id: "b10e8400-e29b-41d4-a716-446655440001",
        payment_capable: true,
        raw_spinwheel: baseRawSupported,
        is_active: true,
        source: "spinwheel"
      },
      {
        id: debtId2,
        name: "Card B",
        balance: 200,
        minimum_payment: 20,
        apr: 12,
        spinwheel_external_id: "b10e8400-e29b-41d4-a716-446655440002",
        payment_capable: false,
        raw_spinwheel: { liability: { payments: { billPayment: { availability: "PENDING" } } } },
        is_active: true,
        source: "spinwheel"
      },
      {
        id: debtId3,
        name: "Card C",
        balance: 50,
        minimum_payment: 10,
        apr: 8,
        spinwheel_external_id: "b10e8400-e29b-41d4-a716-446655440003",
        payment_capable: false,
        raw_spinwheel: baseRawNotSupported,
        is_active: true,
        source: "spinwheel"
      },
      {
        id: debtId4,
        name: "Bad",
        balance: 0,
        minimum_payment: 0,
        apr: 0,
        spinwheel_external_id: "b10e8400-e29b-41d4-a716-446655440004",
        payment_capable: true,
        raw_spinwheel: baseRawSupported,
        is_active: true,
        source: "spinwheel"
      }
    ];

    const s = buildSpinwheelPayableSummary(rows, sn);
    assert.equal(s.total_spinwheel_debts, 4);
    assert.equal(s.payable_count, 1);
    assert.equal(s.planning_only_count, 1);
    assert.equal(s.not_supported_count, 1);
    assert.equal(s.field_error_count, 1);
    assert.equal(s.payable_debts.length, 1);
    assert.equal(s.payable_debts[0].id, debtId1);
    assert.equal(s.blocked_debts.length, 3);
    const reasons = new Set(s.blocked_debts.map((b) => b.reason));
    assert.ok(reasons.has("balance_not_positive"));
    assert.ok(reasons.has("spinwheel_planning_only"));
    assert.ok(reasons.has("spinwheel_bill_pay_not_supported"));
  });

  it("field_error por raw_spinwheel ausente", () => {
    const s = buildSpinwheelPayableSummary(
      [
        {
          id: "c10e8400-e29b-41d4-a716-446655440001",
          name: "X",
          balance: 10,
          minimum_payment: 1,
          apr: 5,
          spinwheel_external_id: "d10e8400-e29b-41d4-a716-446655440001",
          payment_capable: true,
          raw_spinwheel: null,
          is_active: true,
          source: "spinwheel"
        }
      ],
      sn
    );
    assert.equal(s.field_error_count, 1);
    assert.equal(s.payable_count, 0);
    assert.equal(s.blocked_debts[0].reason, "missing_raw_spinwheel");
  });
});
