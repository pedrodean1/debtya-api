const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerAiCoachRoutes } = require("../../routes/ai-coach-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function makeDeps() {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    jsonError,
    appError: () => {}
  };
}

function mount() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerAiCoachRoutes(app, makeDeps());
  return app;
}

const validBody = {
  lang: "en",
  strategy: "avalanche",
  payment_amount: 120.5,
  intent: { id: "660e8400-e29b-41d4-a716-446655440000", debt_id: "770e8400-e29b-41d4-a716-446655440000", status: "pending_review" },
  debt: { id: "770e8400-e29b-41d4-a716-446655440000", name: "Card A", balance: 5000, apr: 22.9, minimum_payment: 50 }
};

describe("routes/ai-coach-routes", () => {
  let prevKey;
  let prevCoachDisabled;

  beforeEach(() => {
    prevKey = process.env.OPENAI_API_KEY;
    prevCoachDisabled = process.env.OPENAI_COACH_DISABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COACH_DISABLED;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevCoachDisabled === undefined) delete process.env.OPENAI_COACH_DISABLED;
    else process.env.OPENAI_COACH_DISABLED = prevCoachDisabled;
  });

  it("POST sin intent => 400", async () => {
    const app = mount();
    const res = await request(app).post("/ai/explain-next-payment").send({ payment_amount: 10 });
    assert.equal(res.status, 400);
  });

  it("POST sin payment_amount valido => 400", async () => {
    const app = mount();
    const res = await request(app).post("/ai/explain-next-payment").send({ intent: { id: "x" }, payment_amount: 0 });
    assert.equal(res.status, 400);
  });

  it("POST sin OPENAI_API_KEY => ok y texto fallback EN", async () => {
    const app = mount();
    const res = await request(app).post("/ai/explain-next-payment").send(validBody);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.explanation, /DebtYa recommends/i);
    assert.match(res.body.explanation, /outside DebtYa/i);
  });

  it("POST sin OPENAI_API_KEY => fallback ES", async () => {
    const app = mount();
    const res = await request(app).post("/ai/explain-next-payment").send({ ...validBody, lang: "es" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.explanation, /DebtYa recomienda/i);
    assert.match(res.body.explanation, /fuera de DebtYa/i);
  });
});
