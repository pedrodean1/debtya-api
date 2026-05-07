const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { executeManualPlanRebuild } = require("../../lib/manual-plan-rebuild");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const debtA = "11111111-1111-4111-8111-111111111111";
const debtB = "22222222-2222-4222-8222-222222222222";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

function normalizePaymentPlan(row) {
  if (!row) {
    return {
      strategy: "avalanche",
      monthly_budget: 0,
      extra_payment_default: 0,
      payment_target_debt_id: null
    };
  }
  return { ...row };
}

/**
 * Pasos payment_intents: select abiertos; [cancel]; insert; select stray; [cancel stray]
 */
function makeSupabaseMock({ debts, openRows, newIntentRow, strayRows = [] }) {
  const steps = ["selectOpen"];
  if (openRows.length) steps.push("cancelOpen");
  steps.push("insert");
  steps.push("straySelect");
  if (strayRows.length) steps.push("cancelStray");

  let idx = 0;
  return {
    from(table) {
      if (table === "debts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: debts, error: null })
            })
          })
        };
      }
      if (table === "payment_intents") {
        const step = steps[idx++];
        if (step === "selectOpen") {
          return {
            select: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: openRows, error: null })
              })
            })
          };
        }
        if (step === "cancelOpen") {
          return {
            update: () => ({
              in: () => ({
                eq: () => Promise.resolve({ error: null })
              })
            })
          };
        }
        if (step === "insert") {
          return {
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: newIntentRow, error: null })
              })
            })
          };
        }
        if (step === "straySelect") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  neq: () => Promise.resolve({ data: strayRows, error: null })
                })
              })
            })
          };
        }
        if (step === "cancelStray") {
          return {
            update: () => ({
              in: () => ({
                eq: () => Promise.resolve({ error: null })
              })
            })
          };
        }
        throw new Error(`mock payment_intents paso desconocido: ${step}`);
      }
      throw new Error(`mock tabla ${table}`);
    }
  };
}

describe("lib/manual-plan-rebuild", () => {
  it("Avalanche: prioriza APR mas alto (B sobre A)", async () => {
    const debts = [
      {
        id: debtA,
        user_id: userId,
        is_active: true,
        balance: 1000,
        apr: 10,
        minimum_payment: 50,
        name: "A"
      },
      {
        id: debtB,
        user_id: userId,
        is_active: true,
        balance: 500,
        apr: 25,
        minimum_payment: 25,
        name: "B"
      }
    ];
    const newIntentRow = {
      id: "99999999-9999-4999-a999-999999999999",
      debt_id: debtB,
      user_id: userId,
      status: "pending_review",
      metadata: { manual_first_rebuild: true },
      amount: 25,
      total_amount: 25
    };
    const supabaseAdmin = makeSupabaseMock({
      debts,
      openRows: [],
      newIntentRow,
      strayRows: []
    });

    const out = await executeManualPlanRebuild({
      userId,
      body: {},
      supabaseAdmin,
      getCurrentPaymentPlan: async () =>
        normalizePaymentPlan({
          strategy: "avalanche",
          monthly_budget: 0,
          extra_payment_default: 0
        }),
      normalizePaymentPlan,
      safeNumber,
      isUuid
    });

    assert.equal(out.ok, true);
    assert.equal(out.manual_plan_rebuild, true);
    assert.equal(out.manual_first_reconcile.priorityDebtId, debtB);
    assert.equal(out.intent.debt_id, debtB);
  });

  it("Snowball: prioriza balance mas bajo (A sobre B)", async () => {
    const debts = [
      {
        id: debtA,
        user_id: userId,
        is_active: true,
        balance: 100,
        apr: 15,
        minimum_payment: 25,
        name: "A"
      },
      {
        id: debtB,
        user_id: userId,
        is_active: true,
        balance: 500,
        apr: 5,
        minimum_payment: 25,
        name: "B"
      }
    ];
    const newIntentRow = {
      id: "aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      debt_id: debtA,
      user_id: userId,
      status: "pending_review",
      amount: 25,
      total_amount: 25
    };
    const supabaseAdmin = makeSupabaseMock({
      debts,
      openRows: [],
      newIntentRow,
      strayRows: []
    });

    const out = await executeManualPlanRebuild({
      userId,
      body: { strategy: "snowball" },
      supabaseAdmin,
      getCurrentPaymentPlan: async () =>
        normalizePaymentPlan({
          strategy: "avalanche",
          monthly_budget: 0,
          extra_payment_default: 0
        }),
      normalizePaymentPlan,
      safeNumber,
      isUuid
    });

    assert.equal(out.manual_plan_rebuild, true);
    assert.equal(out.manual_first_reconcile.priorityDebtId, debtA);
    assert.equal(out.intent.debt_id, debtA);
  });

  it("cancela intents abiertos viejos (cualquier source)", async () => {
    const debts = [
      {
        id: debtA,
        user_id: userId,
        is_active: true,
        balance: 200,
        apr: 12,
        minimum_payment: 30,
        name: "Only"
      }
    ];
    const openRows = [
      { id: "open-sw", status: "pending_review", source: "spinwheel" },
      { id: "open-pl", status: "pending_review", source: "plaid" }
    ];
    const newIntentRow = {
      id: "bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      debt_id: debtA,
      user_id: userId,
      status: "pending_review",
      metadata: { manual_first_rebuild: true },
      amount: 30,
      total_amount: 30
    };
    const supabaseAdmin = makeSupabaseMock({
      debts,
      openRows,
      newIntentRow,
      strayRows: []
    });

    const out = await executeManualPlanRebuild({
      userId,
      body: {},
      supabaseAdmin,
      getCurrentPaymentPlan: async () =>
        normalizePaymentPlan({
          strategy: "avalanche",
          monthly_budget: 0,
          extra_payment_default: 0
        }),
      normalizePaymentPlan,
      safeNumber,
      isUuid
    });

    assert.ok(out.manual_first_reconcile.canceled >= 2);
  });

  it("post-insert cleanup cancela stray pending_review ademas del nuevo", async () => {
    const debts = [
      {
        id: debtA,
        user_id: userId,
        is_active: true,
        balance: 300,
        apr: 11,
        minimum_payment: 20,
        name: "X"
      }
    ];
    const newIntentRow = {
      id: "ccccccc-cccc-4ccc-8ccc-cccccccccccc",
      debt_id: debtA,
      user_id: userId,
      status: "pending_review",
      amount: 20,
      total_amount: 20
    };
    const stray = [{ id: "stray-1", status: "pending_review" }];
    const supabaseAdmin = makeSupabaseMock({
      debts,
      openRows: [],
      newIntentRow,
      strayRows: stray
    });

    const out = await executeManualPlanRebuild({
      userId,
      body: {},
      supabaseAdmin,
      getCurrentPaymentPlan: async () =>
        normalizePaymentPlan({
          strategy: "avalanche",
          monthly_budget: 0,
          extra_payment_default: 0
        }),
      normalizePaymentPlan,
      safeNumber,
      isUuid
    });

    assert.ok(out.manual_first_reconcile.canceled >= 1);
  });

  it("no consulta ni cancela intents executed (no estan en abiertos)", async () => {
    const debts = [
      {
        id: debtA,
        user_id: userId,
        is_active: true,
        balance: 400,
        apr: 9,
        minimum_payment: 40,
        name: "Y"
      }
    ];
    const newIntentRow = {
      id: "ddddddd-dddd-4ddd-8ddd-dddddddddddd",
      debt_id: debtA,
      user_id: userId,
      status: "pending_review",
      amount: 40,
      total_amount: 40
    };
    const supabaseAdmin = makeSupabaseMock({
      debts,
      openRows: [],
      newIntentRow,
      strayRows: []
    });

    const out = await executeManualPlanRebuild({
      userId,
      body: {},
      supabaseAdmin,
      getCurrentPaymentPlan: async () =>
        normalizePaymentPlan({
          strategy: "avalanche",
          monthly_budget: 0,
          extra_payment_default: 0
        }),
      normalizePaymentPlan,
      safeNumber,
      isUuid
    });

    assert.equal(out.ok, true);
    assert.ok(out.intent);
  });
});
