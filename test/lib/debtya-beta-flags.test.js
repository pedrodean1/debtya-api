const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  isStripeCheckoutBlockedForBeta,
  isStripePortalBlockedDuringBeta,
  isPublicPlaidWebDisabled,
  isLegacyStatusRoutesAllowed
} = require("../../lib/debtya-beta-flags");

describe("lib/debtya-beta-flags", () => {
  afterEach(() => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    delete process.env.DEBTYA_ALLOW_STRIPE_PORTAL;
    delete process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB;
    delete process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
  });

  it("bloquea checkout salvo DEBTYA_ALLOW_STRIPE_CHECKOUT=1", () => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    assert.equal(isStripeCheckoutBlockedForBeta(), true);
    process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT = "1";
    assert.equal(isStripeCheckoutBlockedForBeta(), false);
  });

  it("rutas legacy /method/status y /spinwheel/status deshabilitadas salvo DEBTYA_ALLOW_LEGACY_STATUS_ROUTES=1", () => {
    delete process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES;
    assert.equal(isLegacyStatusRoutesAllowed(), false);
    process.env.DEBTYA_ALLOW_LEGACY_STATUS_ROUTES = "1";
    assert.equal(isLegacyStatusRoutesAllowed(), true);
  });

  it("portal Stripe bloqueado en beta salvo DEBTYA_ALLOW_STRIPE_PORTAL=1 o CHECKOUT=1", () => {
    delete process.env.DEBTYA_ALLOW_STRIPE_PORTAL;
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    assert.equal(isStripePortalBlockedDuringBeta(), true);
    process.env.DEBTYA_ALLOW_STRIPE_PORTAL = "1";
    assert.equal(isStripePortalBlockedDuringBeta(), false);
    delete process.env.DEBTYA_ALLOW_STRIPE_PORTAL;
    process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT = "1";
    assert.equal(isStripePortalBlockedDuringBeta(), false);
  });

  it("plaid web publico deshabilitado salvo DEBTYA_ALLOW_PUBLIC_PLAID_WEB=1", () => {
    delete process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB;
    assert.equal(isPublicPlaidWebDisabled(), true);
    process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB = "1";
    assert.equal(isPublicPlaidWebDisabled(), false);
  });
});
