const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  isStripeCheckoutBlockedForBeta,
  isPublicPlaidWebDisabled
} = require("../../lib/debtya-beta-flags");

describe("lib/debtya-beta-flags", () => {
  afterEach(() => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    delete process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB;
  });

  it("bloquea checkout salvo DEBTYA_ALLOW_STRIPE_CHECKOUT=1", () => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    assert.equal(isStripeCheckoutBlockedForBeta(), true);
    process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT = "1";
    assert.equal(isStripeCheckoutBlockedForBeta(), false);
  });

  it("plaid web publico deshabilitado salvo DEBTYA_ALLOW_PUBLIC_PLAID_WEB=1", () => {
    delete process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB;
    assert.equal(isPublicPlaidWebDisabled(), true);
    process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB = "1";
    assert.equal(isPublicPlaidWebDisabled(), false);
  });
});
