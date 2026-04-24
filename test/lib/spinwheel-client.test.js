const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createSpinwheelClient, spinwheelErrorMessageFromJson } = require("../../lib/spinwheel-client");

describe("lib/spinwheel-client", () => {
  let savedFetch;

  beforeEach(() => {
    savedFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it("spinwheelErrorMessageFromJson lee status.messages[0].desc", () => {
    const msg = spinwheelErrorMessageFromJson({
      status: { code: 400, desc: "INVALID_NUMBER", messages: [{ desc: "Bad phone" }] }
    });
    assert.equal(msg, "Bad phone");
  });

  it("requestDetailed envía Authorization Bearer y JSON", async () => {
    let seenUrl;
    let seenInit;
    global.fetch = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ status: { code: 201, desc: "success" }, data: { ok: true } })
      };
    };
    const c = createSpinwheelClient({
      apiSecret: "secret-xyz",
      apiBaseUrl: "https://sandbox-api.spinwheel.io",
      secureApiBaseUrl: "https://secure-sandbox-api.spinwheel.io"
    });
    const out = await c.requestDetailed("POST", "/v1/users/connect/sms", { phoneNumber: "+1" }, "default");
    assert.equal(out.status, 201);
    assert.equal(seenUrl, "https://sandbox-api.spinwheel.io/v1/users/connect/sms");
    assert.equal(seenInit.method, "POST");
    assert.ok(String(seenInit.headers.Authorization).includes("secret-xyz"));
    assert.equal(seenInit.headers["Content-Type"], "application/json");
  });

  it("usa host secure cuando hostKind es secure", async () => {
    let seenUrl;
    global.fetch = async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => "{}"
      };
    };
    const c = createSpinwheelClient({
      apiSecret: "s",
      apiBaseUrl: "https://api.spinwheel.io",
      secureApiBaseUrl: "https://secure-api.spinwheel.io"
    });
    await c.requestDetailed("POST", "/v1/users/connect/kba", {}, "secure");
    assert.equal(seenUrl, "https://secure-api.spinwheel.io/v1/users/connect/kba");
  });
});
