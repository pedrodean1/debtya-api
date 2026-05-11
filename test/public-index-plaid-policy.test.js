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
