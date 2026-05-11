const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerGuideRoutes } = require("../../routes/guide-routes");
const { jsonError } = require("../../lib/json-error");

const userId = "550e8400-e29b-41d4-a716-446655440000";

function mount(overrides = {}) {
  const app = express();
  app.use(express.json());
  registerGuideRoutes(app, {
    jsonError,
    appError: () => {},
    requireUser: (req, res, next) => {
      req.user = { id: userId };
      next();
    },
    ...overrides
  });
  return app;
}

describe("routes/guide-routes POST /guide-assistant", () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevOff = process.env.OPENAI_GUIDE_DISABLED;

  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevOff === undefined) delete process.env.OPENAI_GUIDE_DISABLED;
    else process.env.OPENAI_GUIDE_DISABLED = prevOff;
  });

  it("no devuelve mensaje crudo del proveedor ante error", async () => {
    process.env.OPENAI_API_KEY = "sk-test-guide-routes";
    delete process.env.OPENAI_GUIDE_DISABLED;

    const secret = "OPENAI_PROVIDER_SECRET_XYZ_12345";
    const app = mount({
      openAiChatCompletions: async () => {
        const err = new Error("axios");
        err.response = {
          status: 401,
          data: { error: { message: secret, code: "invalid_api_key" } }
        };
        throw err;
      }
    });

    const res = await request(app).post("/guide-assistant").send({ message: "hello", lang: "en" });
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "assistant_unavailable");
    const raw = JSON.stringify(res.body);
    assert.equal(raw.includes(secret), false);
  });

  it("respuesta vacia del proveedor => assistant_unavailable sin detalles", async () => {
    process.env.OPENAI_API_KEY = "sk-test-guide-routes";
    delete process.env.OPENAI_GUIDE_DISABLED;

    const app = mount({
      openAiChatCompletions: async () => ({
        data: { choices: [{ message: { content: "   " } }] }
      })
    });

    const res = await request(app).post("/guide-assistant").send({ message: "hello", lang: "en" });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "assistant_unavailable");
  });
});
