const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateDebtCreatePayload } = require("../../lib/validation");
const {
  extractDebtProfileData,
  spinwheelRawResponseHasDebtProfileData,
  collectOpenLiabilitiesForImport,
  spinwheelItemToDebtPayload,
  importDebtsFromSpinwheelApi
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

  it("importDebtsFromSpinwheelApi inserta una fila", async () => {
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
    let inserted = false;
    const supabaseAdmin = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          maybeSingle() {
                            return Promise.resolve({ data: null, error: null });
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          },
          insert(payload) {
            inserted = true;
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
    assert.equal(inserted, true);
    assert.equal(summary.source_used, "fresh_spinwheel_api");
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
                    return {
                      eq() {
                        return {
                          maybeSingle() {
                            return Promise.resolve({ data: null, error: null });
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          },
          insert() {
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
                    return {
                      eq() {
                        return {
                          maybeSingle() {
                            return Promise.resolve({ data: null, error: null });
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          },
          insert() {
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
});
