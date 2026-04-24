const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

function loadSpinwheelEnvFresh() {
  const resolved = path.join(__dirname, "..", "..", "lib", "spinwheel-env.js");
  delete require.cache[resolved];
  return require(resolved);
}

describe("lib/spinwheel-env", () => {
  const saved = {};

  beforeEach(() => {
    for (const k of [
      "SPINWHEEL_API_SECRET",
      "DEBTYA_SPINWHEEL_API_SECRET",
      "SPINWHEEL_SECRET_KEY",
      "SPINWHEEL_API_KEY",
      "SPINWHEEL_ENV",
      "DEBTYA_SPINWHEEL_ENV",
      "SPINWHEEL_BASE_URL",
      "SPINWHEEL_SECURE_BASE_URL",
      "SPINWHEEL_WEBHOOK_SECRET"
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("lee SPINWHEEL_API_SECRET y normaliza Bearer duplicado", () => {
    process.env.SPINWHEEL_API_SECRET = "Bearer token-one";
    const { readSpinwheelApiSecret, isSpinwheelConfigured } = loadSpinwheelEnvFresh();
    assert.equal(readSpinwheelApiSecret(), "token-one");
    assert.equal(isSpinwheelConfigured(), true);
  });

  it("acepta DEBTYA_SPINWHEEL_API_SECRET y expone key_source", () => {
    process.env.DEBTYA_SPINWHEEL_API_SECRET = "sw_from_alias";
    const { readSpinwheelApiSecret, readSpinwheelKeyStatus } = loadSpinwheelEnvFresh();
    assert.equal(readSpinwheelApiSecret(), "sw_from_alias");
    const st = readSpinwheelKeyStatus();
    assert.equal(st.configured, true);
    assert.equal(st.key_source, "DEBTYA_SPINWHEEL_API_SECRET");
  });

  it("readSpinwheelEnv production con alias prod", () => {
    process.env.SPINWHEEL_ENV = "prod";
    const { readSpinwheelEnv } = loadSpinwheelEnvFresh();
    assert.equal(readSpinwheelEnv(), "production");
  });

  it("readSpinwheelApiBaseUrl override", () => {
    process.env.SPINWHEEL_BASE_URL = "https://custom.example/spin";
    const { readSpinwheelApiBaseUrl } = loadSpinwheelEnvFresh();
    assert.equal(readSpinwheelApiBaseUrl(), "https://custom.example/spin");
  });
});
