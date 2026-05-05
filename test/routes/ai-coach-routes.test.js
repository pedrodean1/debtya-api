const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerAiCoachRoutes } = require("../../routes/ai-coach-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");
const { isUuid } = require("../../lib/validation");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const intentId = "660e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

const defaultIntent = {
  id: intentId,
  user_id: userId,
  debt_id: debtId,
  total_amount: 120.5,
  status: "pending_review",
  strategy: "avalanche"
};

const defaultDebt = {
  id: debtId,
  user_id: userId,
  name: "Card A",
  balance: 5000,
  apr: 22.9,
  minimum_payment: 50
};

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function getIntentAmount(intent) {
  return safeNumber(intent?.total_amount ?? intent?.amount ?? 0);
}

function makeMockSupabase(overrides = {}) {
  const intent = overrides.intent !== undefined ? overrides.intent : defaultIntent;
  const debt = overrides.debt !== undefined ? overrides.debt : defaultDebt;
  const plan = overrides.plan !== undefined ? overrides.plan : { strategy: "avalanche" };

  return {
    from(table) {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        maybeSingle: async () => {
          if (table === "payment_intents") return { data: intent, error: null };
          if (table === "debts") return { data: debt, error: null };
          if (table === "payment_plans") return { data: plan, error: null };
          return { data: null, error: null };
        }
      };
      return chain;
    }
  };
}

function makeDeps(overrides = {}) {
  return {
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    jsonError,
    appError: () => {},
    supabaseAdmin: overrides.supabaseAdmin || makeMockSupabase(),
    getIntentAmount: overrides.getIntentAmount || getIntentAmount,
    isUuid,
    safeNumber
  };
}

function mount(depsOverrides) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerAiCoachRoutes(app, makeDeps(depsOverrides));
  return app;
}

const validBody = {
  intent_id: intentId,
  locale: "en"
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

  it("POST sin intent_id => 400", async () => {
    const app = mount();
    const res = await request(app).post("/ai/explain-next-payment").send({ locale: "en" });
    assert.equal(res.status, 400);
  });

  it("POST intent_id invalido => 400", async () => {
    const app = mount();
    const res = await request(app)
      .post("/ai/explain-next-payment")
      .send({ intent_id: "not-a-uuid", locale: "en" });
    assert.equal(res.status, 400);
  });

  it("POST intent no encontrado => 404", async () => {
    const app = mount({
      supabaseAdmin: makeMockSupabase({ intent: null })
    });
    const res = await request(app).post("/ai/explain-next-payment").send(validBody);
    assert.equal(res.status, 404);
  });

  it("POST monto recomendado invalido => 400", async () => {
    const app = mount({
      supabaseAdmin: makeMockSupabase({
        intent: { ...defaultIntent, total_amount: 0, amount: 0, amount_cents: null }
      }),
      getIntentAmount: () => 0
    });
    const res = await request(app).post("/ai/explain-next-payment").send(validBody);
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

  it("POST sin OPENAI_API_KEY => fallback ES (locale)", async () => {
    const app = mount();
    const res = await request(app)
      .post("/ai/explain-next-payment")
      .send({ intent_id: intentId, locale: "es" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.explanation, /DebtYa recomienda/i);
    assert.match(res.body.explanation, /fuera de DebtYa/i);
  });
});
