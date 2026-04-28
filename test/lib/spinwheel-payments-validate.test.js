const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createSpinwheelPaymentIntent,
  validateSpinwheelPaymentPayload
} = require("../../lib/spinwheel-payments");

describe("lib/spinwheel-payments validateSpinwheelPaymentPayload", () => {
  const saved = {};

  beforeEach(() => {
    saved.fetch = global.fetch;
    for (const k of [
      "SPINWHEEL_API_SECRET",
      "SPINWHEEL_SANDBOX_PAYER_ID",
      "SPINWHEEL_PAYMENT_VALIDATE_BASE_URL",
      "SPINWHEEL_PAYMENT_VALIDATE_PATH"
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SPINWHEEL_API_SECRET = "test-secret";
  });

  afterEach(() => {
    global.fetch = saved.fetch;
    for (const k of Object.keys(saved)) {
      if (k === "fetch") continue;
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("rechaza sin secreto", async () => {
    delete process.env.SPINWHEEL_API_SECRET;
    const { payload } = createSpinwheelPaymentIntent(
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", external_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      {
        debtyaUserId: "u1",
        spinwheelUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        safeNumber: (v, fb) => (typeof fb === "number" ? fb : Number(v) || 0)
      }
    );
    const r = await validateSpinwheelPaymentPayload(payload);
    assert.equal(r.valid, false);
    assert.equal(r.details.code, "spinwheel_not_configured");
  });

  it("rechaza si falta SPINWHEEL_SANDBOX_PAYER_ID antes de llamar a Spinwheel", async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const { payload } = createSpinwheelPaymentIntent(
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", external_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      {
        debtyaUserId: "u1",
        spinwheelUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        safeNumber: (v, fb) => (typeof fb === "number" ? fb : Number(v) || 0)
      }
    );
    const r = await validateSpinwheelPaymentPayload(payload);
    assert.equal(r.valid, false);
    assert.equal(r.error, "Missing SPINWHEEL_SANDBOX_PAYER_ID");
    assert.equal(r.details.code, "spinwheel_missing_sandbox_payer_id");
    assert.equal(fetchCalled, false);
  });

  it("200 → valid true con cuerpo Spinwheel", async () => {
    let seenUrl;
    let seenBody;
    global.fetch = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ status: { code: 200, desc: "success" }, data: { extRequestId: seenBody.extRequestId } })
      };
    };
    process.env.SPINWHEEL_SANDBOX_PAYER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { payload } = createSpinwheelPaymentIntent(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        external_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        total_amount: 12.34
      },
      {
        debtyaUserId: "u1",
        spinwheelUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        safeNumber: (v, fb) => Number(v) || fb || 0
      }
    );
    const r = await validateSpinwheelPaymentPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(r.response.status.code, 200);
    assert.ok(seenUrl.includes("sandbox-api.spinwheel.io"));
    assert.ok(seenUrl.endsWith("/v1/payments/requests"));
    assert.equal(seenBody.userId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert.equal(seenBody.payerId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert.equal(seenBody.amount, 12.34);
    assert.equal(seenBody.useOfFunds.allocation[0].creditCardId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("422 → valid false con error y details", async () => {
    process.env.SPINWHEEL_SANDBOX_PAYER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    global.fetch = async () => ({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          status: { code: 422, desc: "INVALID", messages: [{ desc: "payerId requerido" }] }
        })
    });
    const { payload } = createSpinwheelPaymentIntent(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        external_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        total_amount: 5
      },
      {
        debtyaUserId: "u1",
        spinwheelUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        safeNumber: (v, fb) => Number(v) || fb || 0
      }
    );
    const r = await validateSpinwheelPaymentPayload(payload);
    assert.equal(r.valid, false);
    assert.equal(r.error, "payerId requerido");
    assert.equal(r.details.http_status, 422);
    assert.ok(r.details.request_sent);
  });

  it("401 → valid false", async () => {
    process.env.SPINWHEEL_SANDBOX_PAYER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    global.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Unauthorized" })
    });
    const { payload } = createSpinwheelPaymentIntent(
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", external_id: "x", total_amount: 1 },
      {
        debtyaUserId: "u1",
        spinwheelUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        safeNumber: (v, fb) => Number(v) || fb || 0
      }
    );
    const r = await validateSpinwheelPaymentPayload(payload);
    assert.equal(r.valid, false);
    assert.equal(r.details.http_status, 401);
  });
});
