const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { attachStripeWebhook } = require("../../routes/stripe-webhook-routes");
const { requestIdMiddleware } = require("../../lib/request-id");
const { jsonError } = require("../../lib/json-error");

function noop() {}

function makeApp(getDeps) {
  const app = express();
  app.use(requestIdMiddleware);
  attachStripeWebhook(app, express, getDeps);
  return app;
}

describe("routes/stripe-webhook-routes", () => {
  it("500 sin Stripe y conserva request_id", async () => {
    const app = makeApp(() => ({
      stripe: null,
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      stripeDebug: noop,
      stripeError: noop,
      stripeInfo: noop,
      jsonError,
      resolveStripeUserId: async () => null,
      upsertBillingSubscriptionFromStripe: async () => null
    }));
    const res = await request(app)
      .post("/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", "wh-req-1")
      .send("{}");
    assert.equal(res.status, 500);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.request_id, "wh-req-1");
    assert.equal(res.body.http_status, 500);
  });

  it("400 sin cabecera stripe-signature", async () => {
    const stripe = {
      webhooks: {
        constructEvent() {
          return { type: "ping", data: { object: null } };
        }
      }
    };
    const app = makeApp(() => ({
      stripe,
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      stripeDebug: noop,
      stripeError: noop,
      stripeInfo: noop,
      jsonError,
      resolveStripeUserId: async () => null,
      upsertBillingSubscriptionFromStripe: async () => null
    }));
    const res = await request(app)
      .post("/stripe/webhook")
      .set("Content-Type", "application/json")
      .send("{}");
    assert.equal(res.status, 400);
    assert.equal(res.body.http_status, 400);
    assert.ok(res.body.request_id);
  });

  it("400 firma invalida", async () => {
    const stripe = {
      webhooks: {
        constructEvent() {
          throw new Error("bad sig");
        }
      }
    };
    const app = makeApp(() => ({
      stripe,
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      stripeDebug: noop,
      stripeError: noop,
      stripeInfo: noop,
      jsonError,
      resolveStripeUserId: async () => null,
      upsertBillingSubscriptionFromStripe: async () => null
    }));
    const res = await request(app)
      .post("/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=abc")
      .send("{}");
    assert.equal(res.status, 400);
    assert.ok(String(res.body.error || "").includes("Firma"));
  });

  it("200 evento simple sin side effects de base", async () => {
    const stripe = {
      webhooks: {
        constructEvent() {
          return { type: "charge.succeeded", data: { object: { id: "ch_1" } } };
        }
      }
    };
    const app = makeApp(() => ({
      stripe,
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      stripeDebug: noop,
      stripeError: noop,
      stripeInfo: noop,
      jsonError,
      resolveStripeUserId: async () => null,
      upsertBillingSubscriptionFromStripe: async () => null
    }));
    const res = await request(app)
      .post("/stripe/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=abc")
      .send("{}");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.received, true);
    assert.equal(res.body.type, "charge.succeeded");
  });
});
