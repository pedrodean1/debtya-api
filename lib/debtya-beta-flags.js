/**
 * Product flags for manual-first beta (Google Play / public release).
 * Stripe checkout is blocked unless explicitly allowed (opt-in for staging).
 */

function isStripeCheckoutBlockedForBeta() {
  return String(process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT || "").trim() !== "1";
}

/** Billing portal blocked during manual-first beta unless portal or checkout explicitly allowed (staging). */
function isStripePortalBlockedDuringBeta() {
  if (String(process.env.DEBTYA_ALLOW_STRIPE_PORTAL || "").trim() === "1") return false;
  if (String(process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT || "").trim() === "1") return false;
  return true;
}

/** Public HTML helper at GET /plaid/web — disabled unless explicitly allowed. */
function isPublicPlaidWebDisabled() {
  return String(process.env.DEBTYA_ALLOW_PUBLIC_PLAID_WEB || "").trim() !== "1";
}

module.exports = {
  isStripeCheckoutBlockedForBeta,
  isStripePortalBlockedDuringBeta,
  isPublicPlaidWebDisabled
};
