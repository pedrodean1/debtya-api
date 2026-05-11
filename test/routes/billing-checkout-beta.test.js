const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerBillingRoutes } = require("../../routes/billing-routes");
const { jsonError } = require("../../lib/json-error");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function mount() {
  const app = express();
  app.use(express.json());
  registerBillingRoutes(app, {
    SERVER_VERSION: "test",
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    stripe: {
      checkout: {
        sessions: {
          create: async () => {
            throw new Error("stripe should not be called when checkout blocked");
          }
        }
      },
      billingPortal: {
        sessions: {
          create: async () => {
            throw new Error("stripe portal should not be called when portal blocked");
          }
        }
      }
    },
    STRIPE_PRICE_ID_BETA_MONTHLY: "price_test",
    STRIPE_PORTAL_CONFIG_ID: null,
    getLatestBillingSubscriptionForUser: async () => null,
    redeemCompPromoForUser: async () => ({ ok: false }),
    getCompPromoMeta: () => ({ configured: false, count: 0 }),
    ensureProfile: async () => {},
    getOrCreateStripeCustomerForUser: async () => "cus_test",
    getBaseUrl: () => "https://www.debtya.com",
    stripeDebug: () => {},
    jsonError
  });
  return app;
}

describe("routes/billing checkout beta", () => {
  afterEach(() => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    delete process.env.DEBTYA_ALLOW_STRIPE_PORTAL;
  });

  it("POST /stripe/create-checkout-session devuelve 403 checkout_disabled_during_beta por defecto", async () => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    const app = mount();
    const res = await request(app).post("/stripe/create-checkout-session").send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "checkout_disabled_during_beta");
  });

  it("permite checkout cuando DEBTYA_ALLOW_STRIPE_CHECKOUT=1", async () => {
    process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT = "1";
    const app = express();
    app.use(express.json());
    let stripeHit = false;
    registerBillingRoutes(app, {
      SERVER_VERSION: "test",
      requireUser: (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      stripe: {
        checkout: {
          sessions: {
            create: async () => {
              stripeHit = true;
              return { id: "cs_test", url: "https://stripe.test/checkout" };
            }
          }
        }
      },
      STRIPE_PRICE_ID_BETA_MONTHLY: "price_test",
      STRIPE_PORTAL_CONFIG_ID: null,
      getLatestBillingSubscriptionForUser: async () => null,
      redeemCompPromoForUser: async () => ({ ok: false }),
      getCompPromoMeta: () => ({ configured: false, count: 0 }),
      ensureProfile: async () => {},
      getOrCreateStripeCustomerForUser: async () => "cus_test",
      getBaseUrl: () => "https://www.debtya.com",
      stripeDebug: () => {},
      jsonError
    });
    const res = await request(app).post("/stripe/create-checkout-session").send({});
    assert.equal(res.status, 200);
    assert.equal(stripeHit, true);
    assert.equal(res.body.ok, true);
    assert.ok(String(res.body.url || "").includes("stripe.test"));
  });

  it("POST /stripe/create-portal-session devuelve 403 billing_portal_disabled_during_beta por defecto", async () => {
    delete process.env.DEBTYA_ALLOW_STRIPE_CHECKOUT;
    delete process.env.DEBTYA_ALLOW_STRIPE_PORTAL;
    const app = mount();
    const res = await request(app).post("/stripe/create-portal-session").send({});
    assert.equal(res.status, 403);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "billing_portal_disabled_during_beta");
  });

  it("permite portal cuando DEBTYA_ALLOW_STRIPE_PORTAL=1", async () => {
    process.env.DEBTYA_ALLOW_STRIPE_PORTAL = "1";
    const app = express();
    app.use(express.json());
    let portalHit = false;
    registerBillingRoutes(app, {
      SERVER_VERSION: "test",
      requireUser: (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      stripe: {
        billingPortal: {
          sessions: {
            create: async () => {
              portalHit = true;
              return { url: "https://stripe.test/portal" };
            }
          }
        }
      },
      STRIPE_PRICE_ID_BETA_MONTHLY: "price_test",
      STRIPE_PORTAL_CONFIG_ID: null,
      getLatestBillingSubscriptionForUser: async () => ({
        stripe_customer_id: "cus_test",
        status: "active",
        active: true,
        current_period_end: null,
        cancel_at_period_end: false
      }),
      redeemCompPromoForUser: async () => ({ ok: false }),
      getCompPromoMeta: () => ({ configured: false, count: 0 }),
      ensureProfile: async () => {},
      getOrCreateStripeCustomerForUser: async () => "cus_test",
      getBaseUrl: () => "https://www.debtya.com",
      stripeDebug: () => {},
      jsonError
    });
    const res = await request(app).post("/stripe/create-portal-session").send({});
    assert.equal(res.status, 200);
    assert.equal(portalHit, true);
    assert.ok(String(res.body.url || "").includes("stripe.test"));
  });
});
