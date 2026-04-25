const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateDebtCreatePayload } = require("../../lib/validation");
const {
  extractDebtProfileData,
  spinwheelRawResponseHasDebtProfileData,
  collectOpenLiabilitiesForImport,
  spinwheelItemToDebtPayload,
  importDebtsFromSpinwheelApi,
  insertSpinwheelDebtResilient,
  isMissingDebtsColumnError
} = require("../../lib/spinwheel-debt-import");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

describe("lib/spinwheel-debt-import", () => {
  it("extractDebtProfileData lee data", () => {
    const d = extractDebtProfileData({ status: {}, data: { creditCards: [] } });
    assert.ok(d);
    assert.ok(Array.isArray(d.creditCards));
  });

  it("spinwheelRawResponseHasDebtProfileData false sin colecciones de liabilities", () => {
    assert.equal(
      spinwheelRawResponseHasDebtProfileData({
        data: { userId: "550e8400-e29b-41d4-a716-446655440000", connectionStatus: "SUCCESS" }
      }),
      false
    );
    assert.equal(spinwheelRawResponseHasDebtProfileData(null), false);
  });

  it("spinwheelRawResponseHasDebtProfileData true si hay al menos una colección array", () => {
    assert.equal(
      spinwheelRawResponseHasDebtProfileData({ data: { creditCards: [], autoLoans: [] } }),
      true
    );
    assert.equal(
      spinwheelRawResponseHasDebtProfileData({
        data: { miscellaneousLiabilities: [{ miscId: "x" }] }
      }),
      true
    );
  });

  it("collectOpenLiabilitiesForImport solo OPEN y balance > 0", () => {
    const data = {
      creditCards: [
        {
          creditCardId: "a1111111-1111-4111-8111-111111111111",
          displayName: "Closed",
          cardProfile: { status: "CLOSED", liabilitySubtype: "CreditCard", debtType: "U" },
          balanceDetails: { outstandingBalance: 100 }
        },
        {
          creditCardId: "b2222222-2222-4222-8222-222222222222",
          displayName: "OpenZero",
          cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "U" },
          balanceDetails: { outstandingBalance: 0 }
        },
        {
          creditCardId: "c3333333-3333-4333-8333-333333333333",
          displayName: "OpenOk",
          cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
          balanceDetails: { outstandingBalance: 50 },
          statementSummary: { minimumPaymentAmount: 5, dueDate: "2024-06-15T00:00:00.000Z" },
          capabilities: { payments: { billPayment: { availability: "SUPPORTED" } } },
          creditor: { originalName: "TEST BANK" }
        }
      ]
    };
    const li = collectOpenLiabilitiesForImport(data);
    assert.equal(li.length, 1);
    assert.equal(li[0].collection, "creditCards");
  });

  it("spinwheelItemToDebtPayload pasa validateDebtCreatePayload", () => {
    const data = {
      creditCards: [
        {
          creditCardId: "c3333333-3333-4333-8333-333333333333",
          displayName: "OpenOk",
          cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
          balanceDetails: { outstandingBalance: 50 },
          statementSummary: { minimumPaymentAmount: 5, dueDate: "2024-06-15T00:00:00.000Z" },
          capabilities: { payments: { billPayment: { availability: "SUPPORTED" } } }
        }
      ]
    };
    const li = collectOpenLiabilitiesForImport(data)[0];
    const row = spinwheelItemToDebtPayload(userId, li.collection, li.item, safeNumber);
    assert.equal(validateDebtCreatePayload(row), null);
    assert.equal(row.source, "spinwheel");
    assert.equal(row.payment_capable, true);
  });

  it("importDebtsFromSpinwheelApi upsert una fila (primera vez = inserted)", async () => {
    const sampleBody = {
      status: { code: 200, desc: "success" },
      data: {
        creditCards: [
          {
            creditCardId: "d4444444-4444-4444-8444-444444444444",
            displayName: "Card",
            cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
            balanceDetails: { outstandingBalance: 12 },
            statementSummary: { minimumPaymentAmount: 1, dueDate: "2024-08-20" },
            capabilities: { payments: { billPayment: { availability: "NOT_SUPPORTED" } } }
          }
        ],
        autoLoans: [],
        homeLoans: [],
        personalLoans: [],
        studentLoans: [],
        miscellaneousLiabilities: []
      }
    };
    const client = {
      requestDetailed() {
        return Promise.resolve({ status: 200, body: sampleBody, url: "x" });
      }
    };
    let upserted = false;
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data: [], error: null });
                  }
                };
              }
            };
          },
          upsert(payload, opts) {
            upserted = true;
            assert.deepEqual(opts, { onConflict: "user_id,source,spinwheel_external_id" });
            assert.equal(payload.source, "spinwheel");
            assert.equal(payload.spinwheel_external_id, "d4444444-4444-4444-8444-444444444444");
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
    };
    const summary = await importDebtsFromSpinwheelApi(supabaseAdmin, {
      debtyaUserId: userId,
      spinwheelUserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      client,
      safeNumber,
      validateDebtCreatePayload
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.inserted, 1);
    assert.equal(summary.updated, 0);
    assert.equal(upserted, true);
    assert.equal(summary.source_used, "fresh_spinwheel_api");
  });

  it("importDebtsFromSpinwheelApi dos importaciones seguidas no duplican (upsert idempotente)", async () => {
    const sampleBody = {
      status: { code: 200, desc: "success" },
      data: {
        creditCards: [
          {
            creditCardId: "d4444444-4444-4444-8444-444444444444",
            displayName: "Card",
            cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
            balanceDetails: { outstandingBalance: 12 },
            statementSummary: { minimumPaymentAmount: 1, dueDate: "2024-08-20" },
            capabilities: { payments: { billPayment: { availability: "NOT_SUPPORTED" } } }
          }
        ],
        autoLoans: [],
        homeLoans: [],
        personalLoans: [],
        studentLoans: [],
        miscellaneousLiabilities: []
      }
    };
    const client = {
      requestDetailed() {
        return Promise.resolve({ status: 200, body: sampleBody, url: "x" });
      }
    };
    let prefetchN = 0;
    let upsertN = 0;
    const stableDebtId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const supabaseAdmin = {
      from() {
        return {
          select() {
            prefetchN += 1;
            const data =
              prefetchN === 1
                ? []
                : [{ spinwheel_external_id: "d4444444-4444-4444-8444-444444444444" }];
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data, error: null });
                  }
                };
              }
            };
          },
          upsert(payload, opts) {
            upsertN += 1;
            assert.deepEqual(opts, { onConflict: "user_id,source,spinwheel_external_id" });
            assert.equal(payload.spinwheel_external_id, "d4444444-4444-4444-8444-444444444444");
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: { id: stableDebtId }, error: null });
                  }
                };
              }
            };
          }
        };
      }
    };
    const args = {
      debtyaUserId: userId,
      spinwheelUserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      client,
      safeNumber,
      validateDebtCreatePayload
    };
    const s1 = await importDebtsFromSpinwheelApi(supabaseAdmin, args);
    const s2 = await importDebtsFromSpinwheelApi(supabaseAdmin, args);
    assert.equal(s1.inserted, 1);
    assert.equal(s1.updated, 0);
    assert.equal(s2.inserted, 0);
    assert.equal(s2.updated, 1);
    assert.equal(upsertN, 2);
    assert.equal(s1.results[0].id, stableDebtId);
    assert.equal(s2.results[0].id, stableDebtId);
    assert.equal(s1.results[0].action, "inserted");
    assert.equal(s2.results[0].action, "updated");
  });

  it("importDebtsFromSpinwheelApi usa cachedRawResponse y no llama al cliente", async () => {
    const cached = {
      status: { code: 200, desc: "success" },
      data: {
        creditCards: [
          {
            creditCardId: "e5555555-5555-4555-8555-555555555555",
            displayName: "Cached",
            cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
            balanceDetails: { outstandingBalance: 9 },
            statementSummary: { minimumPaymentAmount: 1, dueDate: "2024-09-01" },
            capabilities: { payments: { billPayment: { availability: "NOT_SUPPORTED" } } }
          }
        ],
        autoLoans: [],
        homeLoans: [],
        personalLoans: [],
        studentLoans: [],
        miscellaneousLiabilities: []
      }
    };
    const client = {
      requestDetailed() {
        throw new Error("no debe llamarse con caché útil");
      }
    };
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data: [], error: null });
                  }
                };
              }
            };
          },
          upsert() {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
    };
    const summary = await importDebtsFromSpinwheelApi(supabaseAdmin, {
      debtyaUserId: userId,
      spinwheelUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client,
      cachedRawResponse: cached,
      safeNumber,
      validateDebtCreatePayload
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.source_used, "cached_raw_response");
    assert.equal(summary.inserted, 1);
  });

  it("importDebtsFromSpinwheelApi prioriza spinwheel_debt_profile_raw sobre raw_response", async () => {
    const profileCol = {
      status: { code: 200, desc: "success" },
      data: {
        creditCards: [
          {
            creditCardId: "f6666666-6666-4666-8666-666666666666",
            displayName: "ColOnly",
            cardProfile: { status: "OPEN", liabilitySubtype: "CreditCard", debtType: "UNSECURED" },
            balanceDetails: { outstandingBalance: 7 },
            statementSummary: { minimumPaymentAmount: 1, dueDate: "2024-10-01" },
            capabilities: { payments: { billPayment: { availability: "NOT_SUPPORTED" } } }
          }
        ],
        autoLoans: [],
        homeLoans: [],
        personalLoans: [],
        studentLoans: [],
        miscellaneousLiabilities: []
      }
    };
    const verifyLikeRaw = { data: { connectionStatus: "SUCCESS", userId: userId } };
    const client = {
      requestDetailed() {
        throw new Error("no debe llamarse cuando hay columna con perfil");
      }
    };
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ data: [], error: null });
                  }
                };
              }
            };
          },
          upsert() {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
    };
    const summary = await importDebtsFromSpinwheelApi(supabaseAdmin, {
      debtyaUserId: userId,
      spinwheelUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      client,
      cachedSpinwheelDebtProfileRaw: profileCol,
      cachedRawResponse: verifyLikeRaw,
      safeNumber,
      validateDebtCreatePayload
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.source_used, "cached_spinwheel_debt_profile_raw");
    assert.equal(summary.inserted, 1);
  });

  it("isMissingDebtsColumnError detecta schema cache de linked_plaid en debts", () => {
    assert.equal(
      isMissingDebtsColumnError(
        {
          message:
            "Could not find the 'linked_plaid_account_id' column of 'debts' in the schema cache"
        },
        "linked_plaid_account_id"
      ),
      true
    );
    assert.equal(
      isMissingDebtsColumnError(
        {
          message: "Could not find the 'linked_plaid_account_id' column in the schema cache"
        },
        "linked_plaid_account_id"
      ),
      true
    );
    assert.equal(isMissingDebtsColumnError({ message: "otro error" }, "linked_plaid_account_id"), false);
  });

  it("insertSpinwheelDebtResilient reintenta con ultra-minimal ante schema cache", async () => {
    let insertCalls = 0;
    const supabaseAdmin = {
      from() {
        return {
          insert() {
            insertCalls += 1;
            return {
              select() {
                return {
                  single() {
                    if (insertCalls < 3) {
                      return Promise.resolve({
                        data: null,
                        error: {
                          message:
                            "Could not find the 'linked_plaid_account_id' column of 'debts' in the schema cache"
                        }
                      });
                    }
                    return Promise.resolve({ data: { id: "abc-def-0000-0000-000000000001" }, error: null });
                  }
                };
              }
            };
          }
        };
      }
    };
    const r = await insertSpinwheelDebtResilient(supabaseAdmin, {
      user_id: userId,
      name: "T",
      balance: 1,
      apr: 0,
      minimum_payment: 0,
      type: "loan",
      source: "spinwheel",
      spinwheel_external_id: "550e8400-e29b-41d4-a716-446655440099",
      raw_spinwheel: { a: 1 },
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    assert.equal(insertCalls, 3);
    assert.equal(r.error, null);
    assert.equal(r.data.id, "abc-def-0000-0000-000000000001");
  });
});
