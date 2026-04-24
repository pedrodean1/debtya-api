const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractSpinwheelUserIdFromApiResponse,
  extractConnectionStatusFromApiResponse,
  mapConnectionStatusToRowStatus,
  upsertSpinwheelUserFromApiResponse,
  updateSpinwheelUserRawResponse
} = require("../../lib/spinwheel-users");

describe("lib/spinwheel-users", () => {
  it("extractSpinwheelUserIdFromApiResponse lee data.userId", () => {
    const id = extractSpinwheelUserIdFromApiResponse({
      status: { code: 201, desc: "success" },
      data: {
        userId: "550e8400-e29b-41d4-a716-446655440000",
        extUserId: "other",
        connectionId: "660e8400-e29b-41d4-a716-446655440000",
        connectionStatus: "IN_PROGRESS",
        sms: { codeExpiresAt: 1, codeTimeoutSeconds: 300 }
      }
    });
    assert.equal(id, "550e8400-e29b-41d4-a716-446655440000");
  });

  it("extractSpinwheelUserIdFromApiResponse rechaza UUID inválido", () => {
    assert.equal(
      extractSpinwheelUserIdFromApiResponse({
        data: { userId: "not-a-uuid" }
      }),
      null
    );
  });

  it("mapConnectionStatusToRowStatus", () => {
    assert.equal(mapConnectionStatusToRowStatus("SUCCESS"), "active");
    assert.equal(mapConnectionStatusToRowStatus("FAILED"), "failed");
    assert.equal(mapConnectionStatusToRowStatus("IN_PROGRESS"), "linking");
    assert.equal(mapConnectionStatusToRowStatus(null), "active");
  });

  it("extractConnectionStatusFromApiResponse", () => {
    assert.equal(
      extractConnectionStatusFromApiResponse({
        data: { connectionStatus: "FAILED" }
      }),
      "FAILED"
    );
  });

  it("upsertSpinwheelUserFromApiResponse sin userId en respuesta", async () => {
    const supabaseAdmin = { from: () => ({}) };
    const r = await upsertSpinwheelUserFromApiResponse(supabaseAdmin, {
      debtyaUserId: "550e8400-e29b-41d4-a716-446655440000",
      spinwheelBody: { status: { code: 200, desc: "success" } },
      environment: "sandbox"
    });
    assert.equal(r.upserted, false);
    assert.equal(r.reason, "no_spinwheel_user_id_in_response");
  });

  it("upsertSpinwheelUserFromApiResponse hace upsert", async () => {
    const savedRow = {
      id: "770e8400-e29b-41d4-a716-446655440000",
      user_id: "550e8400-e29b-41d4-a716-446655440000",
      spinwheel_user_id: "550e8400-e29b-41d4-a716-446655440001",
      environment: "sandbox",
      status: "linking",
      raw_response: null,
      created_at: "t",
      updated_at: "t"
    };
    const supabaseAdmin = {
      from() {
        return {
          upsert(_row, _opts) {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: savedRow, error: null });
                  }
                };
              }
            };
          }
        };
      }
    };
    const r = await upsertSpinwheelUserFromApiResponse(supabaseAdmin, {
      debtyaUserId: "550e8400-e29b-41d4-a716-446655440000",
      spinwheelBody: {
        data: {
          userId: "550e8400-e29b-41d4-a716-446655440001",
          connectionStatus: "IN_PROGRESS"
        }
      },
      environment: "sandbox"
    });
    assert.equal(r.upserted, true);
    assert.equal(r.row.spinwheel_user_id, "550e8400-e29b-41d4-a716-446655440001");
  });

  it("updateSpinwheelUserRawResponse actualiza fila", async () => {
    const supabaseAdmin = {
      from() {
        return {
          update() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle() {
                                return Promise.resolve({
                                  data: { id: "1", spinwheel_user_id: "550e8400-e29b-41d4-a716-446655440001" },
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
        };
      }
    };
    const r = await updateSpinwheelUserRawResponse(supabaseAdmin, {
      debtyaUserId: "550e8400-e29b-41d4-a716-446655440000",
      spinwheelUserId: "550e8400-e29b-41d4-a716-446655440001",
      spinwheelBody: { data: { connectionStatus: "SUCCESS" } },
      environment: "sandbox"
    });
    assert.equal(r.updated, true);
    assert.ok(r.row);
  });

  it("updateSpinwheelUserRawResponse no pisa raw_response si body no es debt profile", async () => {
    let patch;
    const supabaseAdmin = {
      from() {
        return {
          update(p) {
            patch = p;
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle() {
                                return Promise.resolve({
                                  data: { id: "1", spinwheel_user_id: "550e8400-e29b-41d4-a716-446655440001" },
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
        };
      }
    };
    await updateSpinwheelUserRawResponse(supabaseAdmin, {
      debtyaUserId: "550e8400-e29b-41d4-a716-446655440000",
      spinwheelUserId: "550e8400-e29b-41d4-a716-446655440001",
      spinwheelBody: { data: { connectionStatus: "SUCCESS" } },
      environment: "sandbox"
    });
    assert.equal(patch.raw_response, undefined);
    assert.equal(patch.spinwheel_debt_profile_raw, undefined);
    assert.equal(patch.status, "active");
  });

  it("updateSpinwheelUserRawResponse persiste debt profile en raw y columna dedicada", async () => {
    let patch;
    const debtBody = {
      data: {
        creditCards: [],
        autoLoans: [],
        homeLoans: [],
        personalLoans: [],
        studentLoans: [],
        miscellaneousLiabilities: []
      }
    };
    const supabaseAdmin = {
      from() {
        return {
          update(p) {
            patch = p;
            return {
              eq() {
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          select() {
                            return {
                              maybeSingle() {
                                return Promise.resolve({ data: { id: "1" }, error: null });
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
        };
      }
    };
    await updateSpinwheelUserRawResponse(supabaseAdmin, {
      debtyaUserId: "550e8400-e29b-41d4-a716-446655440000",
      spinwheelUserId: "550e8400-e29b-41d4-a716-446655440001",
      spinwheelBody: debtBody,
      environment: "sandbox"
    });
    assert.deepEqual(patch.raw_response, debtBody);
    assert.deepEqual(patch.spinwheel_debt_profile_raw, debtBody);
  });
});
