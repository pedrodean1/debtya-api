const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerDebtsExtraPaymentRoutes } = require("../../routes/debts-extra-payment-routes");
const { jsonError } = require("../../lib/json-error");
const { requestIdMiddleware } = require("../../lib/request-id");

const userId = "550e8400-e29b-41d4-a716-446655440000";
const debtId = "770e8400-e29b-41d4-a716-446655440000";

function makeDeps(overrides = {}) {
  return {
    requireUser:
      overrides.requireUser ||
      ((req, res, next) => {
        req.user = { id: userId };
        next();
      }),
    recordManualExtraDebtPayment:
      overrides.recordManualExtraDebtPayment ||
      (async () => ({
        ok: true,
        intent_id: "660e8400-e29b-41d4-a716-446655440000",
        debt_id: debtId,
        requested_amount: 50,
        applied_amount: 40,
        amount_clamped: true,
        data: { id: debtId, balance: 10 }
      })),
    jsonError,
    ...overrides
  };
}

function mount(deps) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  registerDebtsExtraPaymentRoutes(app, deps);
  return app;
}

describe("routes/debts-extra-payment-routes", () => {
  it("401 sin usuario autenticado", async () => {
    const app = mount(
      makeDeps({
        requireUser: (_req, res) => jsonError(res, 401, "Unauthorized")
      })
    );
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 10 });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
  });

  it("404 cuando la deuda no pertenece al usuario (handler)", async () => {
    const err = new Error("Deuda no encontrada");
    err.status = 404;
    const app = mount(
      makeDeps({
        recordManualExtraDebtPayment: async () => {
          throw err;
        }
      })
    );
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 10 });
    assert.equal(res.status, 404);
    assert.match(String(res.body.error || ""), /no encontrada/i);
  });

  it("400 cuando la deuda ya está pagada (handler)", async () => {
    const err = new Error("Esta deuda ya está marcada como pagada en DebtYa.");
    err.status = 400;
    const app = mount(
      makeDeps({
        recordManualExtraDebtPayment: async () => {
          throw err;
        }
      })
    );
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 10 });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error || ""), /pagada/i);
  });

  it("400 monto inválido (handler)", async () => {
    const err = new Error("El monto debe ser mayor que cero.");
    err.status = 400;
    const app = mount(
      makeDeps({
        recordManualExtraDebtPayment: async () => {
          throw err;
        }
      })
    );
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 0 });
    assert.equal(res.status, 400);
  });

  it("200 aplica monto y devuelve deuda + flags", async () => {
    const app = mount(makeDeps({}));
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 50, note: "x" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied_amount, 40);
    assert.equal(res.body.amount_clamped, true);
    assert.equal(res.body.data.balance, 10);
  });

  it("extra-payment pasa preferred_language al handler", async () => {
    let captured;
    const app = mount(
      makeDeps({
        recordManualExtraDebtPayment: async (uid, did, amt, note, opts) => {
          captured = { uid, did, amt, note, opts };
          return {
            ok: true,
            intent_id: "660e8400-e29b-41d4-a716-446655440000",
            debt_id: did,
            requested_amount: amt,
            applied_amount: amt,
            amount_clamped: false,
            data: { id: did, balance: 10 }
          };
        }
      })
    );
    const res = await request(app)
      .post(`/debts/${debtId}/extra-payment`)
      .send({ amount: 10, preferred_language: "es" });
    assert.equal(res.status, 200);
    assert.equal(captured.opts.preferredLanguageHint, "es");
  });

  it("propaga status del error sin status como 500", async () => {
    const app = mount(
      makeDeps({
        recordManualExtraDebtPayment: async () => {
          throw new Error("fallo interno");
        }
      })
    );
    const res = await request(app).post(`/debts/${debtId}/extra-payment`).send({ amount: 1 });
    assert.equal(res.status, 500);
  });
});
