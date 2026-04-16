const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.join(__dirname, "..", "..", "scripts", "validate-env.js");

function runValidateEnv(extraEnv) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

describe("scripts/validate-env.js", () => {
  it("en CI production con todas las claves sale 0", () => {
    const r = runValidateEnv({
      CI: "true",
      NODE_ENV: "production",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      SUPABASE_ANON_KEY: "anon",
      STRIPE_SECRET_KEY: "sk",
      STRIPE_WEBHOOK_SECRET: "wh",
      CRON_SECRET: "cron"
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });

  it("en CI production sin STRIPE_SECRET_KEY falla", () => {
    const r = runValidateEnv({
      CI: "true",
      NODE_ENV: "production",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      SUPABASE_ANON_KEY: "anon",
      STRIPE_WEBHOOK_SECRET: "wh",
      CRON_SECRET: "cron"
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /STRIPE_SECRET_KEY/);
  });

  it("no CI solo exige SUPABASE_URL", () => {
    const r = runValidateEnv({
      CI: "false",
      NODE_ENV: "development",
      SUPABASE_URL: "https://x.supabase.co"
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
});
