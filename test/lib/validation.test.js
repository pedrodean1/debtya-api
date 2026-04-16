const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isUuid,
  validateDebtCreatePayload,
  validateDebtPatch,
  validateRuleCreateBody,
  validateRulePatch,
  validatePaymentIntentCreate,
  validateIntentRouteParamId
} = require("../../lib/validation");

const validUuid = "550e8400-e29b-41d4-a716-446655440000";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

describe("isUuid", () => {
  it("acepta UUID v4 tipico", () => {
    assert.equal(isUuid(validUuid), true);
  });
  it("rechaza texto arbitrario", () => {
    assert.equal(isUuid("not-a-uuid"), false);
  });
});

describe("validateDebtCreatePayload", () => {
  it("acepta deuda minima valida", () => {
    assert.equal(
      validateDebtCreatePayload({
        balance: 100,
        minimum_payment: 25,
        apr: 19.99
      }),
      null
    );
  });
  it("rechaza balance negativo", () => {
    assert.equal(validateDebtCreatePayload({ balance: -1, minimum_payment: 0, apr: 0 }), "balance inválido");
  });
});

describe("validateDebtPatch", () => {
  it("no valida campos ausentes", () => {
    assert.equal(validateDebtPatch({ updated_at: "x" }), null);
  });
  it("rechaza apr fuera de rango", () => {
    assert.equal(validateDebtPatch({ apr: 5000 }), "apr inválido");
  });
  it("acepta due_day 0 y 31", () => {
    assert.equal(validateDebtPatch({ due_day: 0 }), null);
    assert.equal(validateDebtPatch({ due_day: 31 }), null);
  });
  it("rechaza due_day fuera de rango", () => {
    assert.equal(validateDebtPatch({ due_day: 32 }), "due_day inválido");
  });
});

describe("validateRuleCreateBody", () => {
  it("rechaza target_debt_id invalido", () => {
    assert.equal(validateRuleCreateBody({ target_debt_id: "bad" }), "target_debt_id inválido");
  });
  it("acepta sin deuda objetivo", () => {
    assert.equal(validateRuleCreateBody({ mode: "fixed_amount" }), null);
  });
  it("acepta UUID en config", () => {
    assert.equal(
      validateRuleCreateBody({
        config: { target_debt_id: validUuid }
      }),
      null
    );
  });
});

describe("validateRulePatch", () => {
  it("rechaza percent fuera de rango", () => {
    assert.equal(validateRulePatch({ percent: 2000 }), "percent inválido");
  });
  it("rechaza target_debt_id no uuid", () => {
    assert.equal(validateRulePatch({ target_debt_id: "x" }), "target_debt_id inválido");
  });
});

describe("validatePaymentIntentCreate", () => {
  it("rechaza amount negativo", () => {
    assert.equal(validatePaymentIntentCreate({ amount: -1 }, safeNumber), "amount inválido");
  });
  it("acepta intent minimo", () => {
    assert.equal(validatePaymentIntentCreate({ amount: 10 }, safeNumber), null);
  });
  it("rechaza debt_id invalido si viene", () => {
    assert.equal(
      validatePaymentIntentCreate({ amount: 1, debt_id: "nope" }, safeNumber),
      "debt_id inválido"
    );
  });
  it("rechaza source_account_id invalido", () => {
    assert.equal(
      validatePaymentIntentCreate({ amount: 1, source_account_id: "bad" }, safeNumber),
      "source_account_id inválido"
    );
  });
  it("rechaza amount por encima del tope", () => {
    assert.equal(
      validatePaymentIntentCreate({ amount: 1e15 }, safeNumber),
      "amount inválido"
    );
  });
});

describe("validateIntentRouteParamId", () => {
  it("rechaza id vacio", () => {
    assert.equal(validateIntentRouteParamId(""), "intent id inválido");
  });
  it("acepta uuid", () => {
    assert.equal(validateIntentRouteParamId(validUuid), null);
  });
});
