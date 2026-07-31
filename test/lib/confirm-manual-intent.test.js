const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createConfirmManualPaymentIntentHandler } = require("../../lib/confirm-manual-intent");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const intentId = "660e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

function parseMeta(m) {
  if (!m) return {};
  if (typeof m === "object") return m;
  try {
    return JSON.parse(String(m));
  } catch {
    return {};
  }
}

function createSupabaseMock() {
  let row = {
    id: intentId,
    user_id: userId,
    status: "pending_review",
    debt_id: debtId,
    total_amount: 10,
    amount: 10,
    executed_at: null,
    metadata: {}
  };
  let claimPass = true;
  let executionDeleted = false;

  function mergeRow(patch) {
    const nextMeta = {
      ...parseMeta(row.metadata),
      ...(patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {})
    };
    row = { ...row, ...patch, metadata: nextMeta };
  }

  function chainSelectSingle() {
    return Promise.resolve({ data: JSON.parse(JSON.stringify(row)), error: null });
  }

  function paymentIntentsFrom() {
    return {
      select() {
        return {
          eq() {
            return {
              eq() {
                return {
                  single: chainSelectSingle
                };
              }
            };
          }
        };
      },
      update(patch) {
        return {
          eq() {
            return {
              eq() {
                const afterTwoEq = {
                  in() {
                    return {
                      select() {
                        if (!claimPass) {
                          return Promise.resolve({ data: [], error: null });
                        }
                        claimPass = false;
                        row = {
                          ...row,
                          ...patch,
                          metadata: patch.metadata || row.metadata
                        };
                        return Promise.resolve({
                          data: [JSON.parse(JSON.stringify(row))],
                          error: null
                        });
                      }
                    };
                  },
                  then(onFulfilled, onRejected) {
                    mergeRow(patch);
                    return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
                  }
                };
                return afterTwoEq;
              }
            };
          }
        };
      }
    };
  }

  const supabaseAdmin = {
    from(table) {
      if (table === "debts") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: () =>
                        Promise.resolve({
                          data: { id: debtId, name: "Test", status: "active", balance: 100 },
                          error: null
                        })
                    };
                  }
                };
              }
            };
          }
        };
      }
      if (table === "payment_executions") {
        return {
          upsert: () => Promise.resolve({ error: null }),
          delete: () => ({
            eq: () => {
              executionDeleted = true;
              return Promise.resolve({ error: null });
            }
          })
        };
      }
      if (table === "payment_intents") return paymentIntentsFrom();
      return {};
    },
    _getRow: () => row,
    _setClaimPass: (v) => {
      claimPass = v;
    },
    _setRow: (patch) => {
      mergeRow(patch);
    },
    _executionDeleted: () => executionDeleted
  };

  return supabaseAdmin;
}

describe("lib/confirm-manual-intent", () => {
  it("doble confirmacion secuencial: segundo es already_confirmed sin segundo apply", async () => {
    const supabaseAdmin = createSupabaseMock();
    let applyCount = 0;
    let emailCount = 0;

    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        if (applyCount === 1) {
          supabaseAdmin._setRow({
            metadata: {
              ...parseMeta(supabaseAdmin._getRow().metadata),
              debt_balance_applied_at: "2020-01-01T00:00:01.000Z",
              debt_balance_previous: 100,
              debt_balance_next: 90
            }
          });
          return {
            ok: true,
            skipped: false,
            previous_balance: 100,
            next_balance: 90,
            previous_status: "active",
            debt_marked_paid_now: false
          };
        }
        return { ok: true, skipped: true, reason: "ya_aplicado", previous_balance: 90, next_balance: 90 };
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
        supabaseAdmin._setRow({
          metadata: {
            ...parseMeta(supabaseAdmin._getRow().metadata),
            payment_recorded_email_sent_at: "2020-01-01T00:00:02.000Z"
          }
        });
        return {
          ok: true,
          payment_email_sent: true,
          celebration_email_sent: false,
          skipped: false
        };
      },
      appDebug: () => {}
    });

    supabaseAdmin._setClaimPass(true);
    const r1 = await confirm(userId, intentId, {});
    assert.ok(r1.already_confirmed !== true);
    assert.equal(r1.ok, true);
    assert.equal(applyCount, 1);
    assert.equal(emailCount, 1);
    assert.deepEqual(r1.transactional_email, {
      ok: true,
      payment_email_sent: true,
      celebration_email_sent: false,
      skipped: false
    });

    const r2 = await confirm(userId, intentId, {});
    assert.equal(r2.already_confirmed, true);
    assert.equal(applyCount, 1);
    assert.equal(emailCount, 1);
  });

  it("claim perdido: fila ya ejecutada con balance aplicado reintenta email si faltaba", async () => {
    const supabaseAdmin = createSupabaseMock();
    supabaseAdmin._setRow({
      status: "executed",
      metadata: {
        debt_balance_applied_at: "2020-01-01T00:00:01.000Z",
        debt_balance_previous: 50,
        debt_balance_next: 40
      }
    });
    supabaseAdmin._setClaimPass(false);

    let applyCount = 0;
    let emailCount = 0;

    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        return { ok: true, skipped: true, reason: "ya_aplicado" };
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
        return {
          ok: true,
          payment_email_sent: true,
          celebration_email_sent: false,
          skipped: false
        };
      },
      appDebug: () => {}
    });

    const r = await confirm(userId, intentId, {});
    assert.equal(r.already_confirmed, true);
    assert.equal(applyCount, 0);
    assert.equal(emailCount, 1);
    assert.deepEqual(r.transactional_email, {
      ok: true,
      payment_email_sent: true,
      celebration_email_sent: false,
      skipped: false
    });
  });

  it("fila ya ejecutada no reintenta email si metadata indica enviado", async () => {
    const supabaseAdmin = createSupabaseMock();
    supabaseAdmin._setRow({
      status: "executed",
      metadata: {
        debt_balance_applied_at: "2020-01-01T00:00:01.000Z",
        debt_balance_previous: 50,
        debt_balance_next: 40,
        payment_recorded_email_sent_at: "2020-01-01T00:00:02.000Z"
      }
    });

    let emailCount = 0;
    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        throw new Error("should not apply");
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
      },
      appDebug: () => {}
    });

    const r = await confirm(userId, intentId, {});
    assert.equal(r.already_confirmed, true);
    assert.equal(emailCount, 0);
    assert.equal(r.transactional_email, undefined);
  });

  it("deuda ya pagada al confirmar manual retira intent stale sin registrar pago ni email", async () => {
    const supabaseAdmin = createSupabaseMock();
    let applyCount = 0;
    let emailCount = 0;

    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        return {
          ok: true,
          skipped: true,
          reason: "deuda_ya_pagada",
          debt_id: debtId,
          amount: 10,
          previous_balance: 0,
          next_balance: 0,
          previous_status: "paid",
          debt_marked_paid_now: false
        };
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
      },
      appDebug: () => {}
    });

    const r = await confirm(userId, intentId, {});
    const row = supabaseAdmin._getRow();
    const meta = parseMeta(row.metadata);

    assert.equal(r.ok, true);
    assert.equal(r.already_confirmed, true);
    assert.equal(r.debt_apply.reason, "deuda_ya_pagada");
    assert.equal(r.old_balance, 0);
    assert.equal(r.new_balance, 0);
    assert.equal(row.status, "skipped");
    assert.equal(row.executed_at, null);
    assert.equal(meta.debt_balance_apply_reason, "deuda_ya_pagada");
    assert.equal(meta.manual_confirm_skipped_reason, "deuda_ya_pagada");
    assert.ok(meta.manual_confirm_skipped_at);
    assert.equal(meta.debt_balance_previous, 0);
    assert.equal(meta.debt_balance_next, 0);
    assert.equal(supabaseAdmin._executionDeleted(), true);
    assert.equal(applyCount, 1);
    assert.equal(emailCount, 0);
  });

  it("executed sin debt_balance_applied_at devuelve confirmation_in_progress y no llama apply ni email", async () => {
    const supabaseAdmin = createSupabaseMock();
    supabaseAdmin._setRow({
      status: "executed",
      executed_at: "2020-01-01T00:00:00.000Z",
      metadata: { manual_confirmed: true, paid_outside_app: true }
    });
    supabaseAdmin._setClaimPass(false);

    let applyCount = 0;
    let emailCount = 0;

    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        return { ok: true, skipped: false, previous_balance: 100, next_balance: 90 };
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
      },
      appDebug: () => {}
    });

    const r = await confirm(userId, intentId, {});
    assert.equal(r.ok, true);
    assert.equal(r.confirmation_in_progress, true);
    assert.equal(r.already_confirmed, true);
    assert.equal(r.debt_apply && r.debt_apply.reason, "confirmacion_en_progreso");
    assert.equal(applyCount, 0);
    assert.equal(emailCount, 0);
  });

  it("claim perdido: executed sin metadata (carrera) devuelve confirmation_in_progress sin apply", async () => {
    const supabaseAdmin = createSupabaseMock();
    supabaseAdmin._setRow({
      status: "executed",
      executed_at: "2020-01-01T00:00:00.000Z",
      metadata: {}
    });
    supabaseAdmin._setClaimPass(false);

    let applyCount = 0;
    let emailCount = 0;
    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        return { ok: true, skipped: false };
      },
      sendPaymentRecordedEmailsSafe: async () => {
        emailCount += 1;
      },
      appDebug: () => {}
    });

    const r = await confirm(userId, intentId, {});
    assert.equal(r.confirmation_in_progress, true);
    assert.equal(applyCount, 0);
    assert.equal(emailCount, 0);
  });

  it("doble llamada en paralelo a executed sin metadata: ninguna rebaja (sin apply)", async () => {
    const supabaseAdmin = createSupabaseMock();
    supabaseAdmin._setRow({
      status: "executed",
      executed_at: "2020-01-01T00:00:00.000Z",
      metadata: {}
    });
    supabaseAdmin._setClaimPass(false);

    let applyCount = 0;
    const confirm = createConfirmManualPaymentIntentHandler({
      supabaseAdmin,
      isUuid: (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      getIntentAmount: (intent) => Number(intent.total_amount || intent.amount || 0),
      getIntentMetadata: (intent) => parseMeta(intent?.metadata),
      intentRowForDebtBalanceApply: (pre, post, amt) => ({
        ...post,
        debt_id: post.debt_id || pre.debt_id,
        total_amount: amt,
        amount: amt
      }),
      applyExecutedIntentToDebt: async () => {
        applyCount += 1;
        return { ok: true, skipped: false };
      },
      sendPaymentRecordedEmailsSafe: async () => {},
      appDebug: () => {}
    });

    const [a, b] = await Promise.all([confirm(userId, intentId, {}), confirm(userId, intentId, {})]);
    assert.equal(a.confirmation_in_progress, true);
    assert.equal(b.confirmation_in_progress, true);
    assert.equal(applyCount, 0);
  });
});
