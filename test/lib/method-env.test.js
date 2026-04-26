const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

function loadMethodEnvFresh() {
  const resolved = path.join(__dirname, "..", "..", "lib", "method-env.js");
  delete require.cache[resolved];
  return require(resolved);
}

describe("lib/method-env", () => {
  const saved = {};

  beforeEach(() => {
    for (const k of [
      "METHOD_API_KEY",
      "DEBTYA_METHOD_API_KEY",
      "METHOD_APIKEY",
      "METHODFI_API_KEY",
      "METHOD_FI_API_KEY",
      "METHOD_SECRET_KEY",
      "METHOD_SECRET",
      "METHOD_ENV",
      "DEBTYA_METHOD_ENV",
      "METHOD_API_VERSION",
      "DEBTYA_METHOD_API_VERSION"
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

  it("lee METHOD_API_KEY con comillas envolventes", () => {
    process.env.METHOD_API_KEY = '"sk_test_abc"';
    const { readMethodApiKey, isMethodConfigured } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_test_abc");
    assert.equal(isMethodConfigured(), true);
  });

  it("acepta alias METHODFI_API_KEY", () => {
    process.env.METHODFI_API_KEY = "sk_from_alias";
    const { readMethodApiKey, isMethodConfigured } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_from_alias");
    assert.equal(isMethodConfigured(), true);
  });

  it("acepta DEBTYA_METHOD_API_KEY", () => {
    process.env.DEBTYA_METHOD_API_KEY = "sk_debtya_prefixed";
    const { readMethodApiKey, isMethodConfigured } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_debtya_prefixed");
    assert.equal(isMethodConfigured(), true);
  });

  it("ignora BOM y zero-width alrededor de la clave", () => {
    process.env.METHOD_API_KEY = "\uFEFF\u200Bsk_bom_clean\u200B";
    const { readMethodApiKey } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_bom_clean");
  });

  it("acepta alias METHOD_APIKEY y expone key_source", () => {
    process.env.METHOD_APIKEY = "sk_alias_no_underscore";
    const { readMethodApiKey, readMethodKeyStatus } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_alias_no_underscore");
    const st = readMethodKeyStatus();
    assert.equal(st.configured, true);
    assert.equal(st.key_source, "METHOD_APIKEY");
    assert.equal(st.key_length > 0, true);
  });

  it("quita prefijo Bearer duplicado de METHOD_API_KEY", () => {
    process.env.METHOD_API_KEY = "Bearer sk_test_strip";
    const { readMethodApiKey } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_test_strip");
  });

  it("quita prefijo bearer en minusculas", () => {
    process.env.METHOD_API_KEY = "bearer sk_test_lower";
    const { readMethodApiKey } = loadMethodEnvFresh();
    assert.equal(readMethodApiKey(), "sk_test_lower");
  });
});
