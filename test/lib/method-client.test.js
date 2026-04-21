const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  unwrapMethodResourceBody,
  methodErrorMessageFromJson
} = require("../../lib/method-client");

describe("lib/method-client helpers", () => {
  it("unwrapMethodResourceBody extrae data cuando trae id", () => {
    const inner = { id: "cxn_1", status: "pending" };
    assert.deepEqual(unwrapMethodResourceBody({ data: inner }), inner);
  });

  it("unwrapMethodResourceBody deja pasar objetos planos", () => {
    const flat = { id: "cxn_2", status: "completed" };
    assert.deepEqual(unwrapMethodResourceBody(flat), flat);
  });

  it("methodErrorMessageFromJson lee data.error.message", () => {
    const msg = methodErrorMessageFromJson({
      success: false,
      message: "outer",
      data: { error: { type: "INVALID_REQUEST", message: "inner detail" } }
    });
    assert.equal(msg, "inner detail");
  });

  it("methodErrorMessageFromJson usa message top-level si no hay nested", () => {
    assert.equal(methodErrorMessageFromJson({ message: "hello" }), "hello");
  });
});
