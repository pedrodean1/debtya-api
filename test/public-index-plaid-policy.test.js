const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("public/index.html Plaid policy", () => {
  it("no carga Plaid CDN como script estatico unico; solo con flag debug en linea", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    assert.ok(
      !html.includes('<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>')
    );
    assert.ok(html.includes("debugBank"));
    assert.ok(html.includes("cdn.plaid.com/link/v2/stable/link-initialize.js"));
  });
});

describe("public debt list UI", () => {
  it("uses internal scrolling for active and paid debt lists on desktop and mobile", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

    assert.match(html, /id="debtsList"[^>]*class="[^"]*active-debts-list-scroll/i);
    assert.match(html, /id="paidDebtsList"[^>]*class="[^"]*paid-debts-list-scroll/i);
    assert.match(css, /\.active-debts-list-scroll\s*\{[\s\S]*?overflow-y\s*:\s*auto/i);
    assert.match(css, /\.paid-debts-section\s+\.paid-debts-list-scroll\s*\{[\s\S]*?overflow-y\s*:\s*auto/i);
    assert.match(css, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.active-debts-list-scroll/i);
    assert.match(css, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.paid-debts-section\s+\.paid-debts-list-scroll/i);
  });

  it("shows manual-first auto tracking copy in both languages", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

    assert.match(html, /id="autoTrackMinimumPayments"/i);
    assert.match(html, /DebtYa does not make the payment for you/i);
    assert.match(app, /DebtYa no hace el pago por ti/i);
  });
  it("hides SMS reminder controls in normal UI", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

    assert.match(html, /id="simpleNotifSms"[^>]*tabindex="-1"/i);
    assert.match(html, /id="simpleNotifPhoneWrap"[^>]*hidden[^>]*aria-hidden="true"/i);
    assert.match(css, /\.ui-sms-channel-hidden\s*\{\s*display\s*:\s*none\s*!important;/i);
  });

  it("exposes admin diagnostics UI without embedding cron secret", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

    assert.match(html, /id="adminDiagnosticsPanel"/i);
    assert.match(html, /id="adminDiagnosticsBtn"[^>]*class="[^"]*hidden/i);
    assert.match(app, /\/api\/admin\/diagnostics\?days=7&limit=1000/i);
    assert.equal(html.includes("CRON_SECRET"), false);
    assert.equal(app.includes("CRON_SECRET"), false);
    assert.equal(app.includes("x-cron-secret"), false);
  });
});
