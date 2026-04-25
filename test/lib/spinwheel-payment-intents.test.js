const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  appendSpinwheelPaymentIntents,
  sortSpinwheelDebtsLikePlan,
  isSpinwheelPlanningIntent
} = require("../../lib/spinwheel-payment-intents");

function safeNumber(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

describe("lib/spinwheel-payment-intents", () => {
  it("sortSpinwheelDebtsLikePlan avalanche ordena por APR", () => {
    const debts = [
      { id: "1", apr: 10, balance: 1000 },
      { id: "2", apr: 22, balance: 100 },
      { id: "3", apr: 22, balance: 500 }
    ];
    const s = sortSpinwheelDebtsLikePlan(debts, "avalanche", safeNumber);
    assert.deepEqual(
      s.map((d) => d.id),
      ["3", "2", "1"]
    );
  });

  it("sortSpinwheelDebtsLikePlan snowball ordena por balance", () => {
    const debts = [
      { id: "a", apr: 5, balance: 500 },
      { id: "b", apr: 20, balance: 50 }
    ];
    const s = sortSpinwheelDebtsLikePlan(debts, "snowball", safeNumber);
    assert.deepEqual(
      s.map((d) => d.id),
      ["b", "a"]
    );
  });

  it("isSpinwheelPlanningIntent", () => {
    assert.equal(isSpinwheelPlanningIntent({ source: "spinwheel" }), true);
    assert.equal(isSpinwheelPlanningIntent({ source: "Spinwheel" }), true);
    assert.equal(isSpinwheelPlanningIntent({}), false);
  });

  it("appendSpinwheelPaymentIntents inserta draft con source y external_id", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const inserts = [];
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
                        eq() {
                          return {
                            gt() {
                              return Promise.resolve({
                                data: [
                                  {
                                    id: "22222222-2222-4222-8222-222222222222",
                                    balance: 200,
                                    minimum_payment: 25,
                                    apr: 18.9,
                                    spinwheel_external_id: "sw-ext-1",
                                    payment_capable: false,
                                    is_active: true,
                                    source: "spinwheel"
                                  }
                                ],
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
            }
          };
        }
        if (table === "payment_intents") {
          return {
            select() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        in() {
                          return Promise.resolve({ data: [], error: null });
                        }
                      };
                    }
                  };
                }
              };
            },
            insert(row) {
              inserts.push(row);
              return {
                select() {
                  return {
                    single() {
                      return Promise.resolve({ data: { id: "33333333-3333-4333-8333-333333333333" }, error: null });
                    }
                  };
                }
              };
            }
          };
        }
        throw new Error("unexpected table " + table);
      }
    };

    const r = await appendSpinwheelPaymentIntents(supabaseAdmin, userId, {
      safeNumber,
      getCurrentPaymentPlan: async () => ({ strategy: "avalanche" })
    });

    assert.equal(r.appended, 1);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].source, "spinwheel");
    assert.equal(inserts[0].external_id, "sw-ext-1");
    assert.equal(inserts[0].status, "draft");
    assert.equal(inserts[0].metadata.interest_rate, 18.9);
    assert.equal(inserts[0].amount, 25);
  });

  it("appendSpinwheelPaymentIntents omite external_id ya abierto", async () => {
    const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
                        eq() {
                          return {
                            gt() {
                              return Promise.resolve({
                                data: [
                                  {
                                    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                                    balance: 100,
                                    minimum_payment: 10,
                                    apr: 12,
                                    spinwheel_external_id: "dup",
                                    payment_capable: true,
                                    is_active: true,
                                    source: "spinwheel"
                                  }
                                ],
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
            }
          };
        }
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      in() {
                        return Promise.resolve({
                          data: [{ external_id: "dup", status: "draft" }],
                          error: null
                        });
                      }
                    };
                  }
                };
              }
            };
          },
          insert() {
            throw new Error("no insert expected");
          }
        };
      }
    };

    const r = await appendSpinwheelPaymentIntents(supabaseAdmin, userId, {
      safeNumber,
      getCurrentPaymentPlan: async () => ({ strategy: "snowball" })
    });

    assert.equal(r.appended, 0);
    assert.equal(r.skipped, 1);
  });

  it("appendSpinwheelPaymentIntents reintenta quitando columnas no soportadas", async () => {
    const userId = "99999999-9999-4999-8999-999999999999";
    let insertCalls = 0;
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
                        eq() {
                          return {
                            gt() {
                              return Promise.resolve({
                                data: [
                                  {
                                    id: "88888888-8888-4888-8888-888888888888",
                                    balance: 60,
                                    minimum_payment: 12,
                                    apr: 15,
                                    spinwheel_external_id: "legacy-no-strategy",
                                    payment_capable: true,
                                    is_active: true,
                                    source: "spinwheel"
                                  }
                                ],
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
            }
          };
        }
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      in() {
                        return Promise.resolve({ data: [], error: null });
                      }
                    };
                  }
                };
              }
            };
          },
          insert() {
            insertCalls += 1;
            return {
              select() {
                return {
                  single() {
                    if (insertCalls === 1) {
                      return Promise.resolve({
                        data: null,
                        error: {
                          code: "42703",
                          message: 'column "strategy" of relation "payment_intents" does not exist'
                        }
                      });
                    }
                    return Promise.resolve({
                      data: { id: "77777777-7777-4777-8777-777777777777" },
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

    const r = await appendSpinwheelPaymentIntents(supabaseAdmin, userId, {
      safeNumber,
      getCurrentPaymentPlan: async () => ({ strategy: "avalanche" })
    });

    assert.equal(r.appended, 1);
    assert.equal(r.skipped, 0);
    assert.equal(insertCalls, 2);
  });
});
