const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("V136 retira por completo el score y el estado arbitrario", () => {
  for (const source of [appSource, indexSource, stylesSource]) {
    assert.doesNotMatch(source, /debtYaScore/i);
    assert.doesNotMatch(source, /debt-score/i);
    assert.doesNotMatch(source, /score_status_/i);
  }
  assert.doesNotMatch(indexSource, /Your plan status/);
  assert.doesNotMatch(indexSource, /Estado de tu plan/);
});

test("V136 mantiene el inicio enfocado en decisiones financieras concretas", () => {
  for (const id of [
    "dashboardNextStepCard",
    "dashboardNextStepPrimary",
    "statDebtFreeDate",
    "payoffSimulationCard",
    "simCustomExtra"
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }

  const nextStepPosition = indexSource.indexOf('id="dashboardNextStepCard"');
  const debtFreePosition = indexSource.indexOf('id="statDebtFreeDate"');
  const simulatorPosition = indexSource.indexOf('id="payoffSimulationCard"');
  assert.ok(nextStepPosition < debtFreePosition);
  assert.ok(debtFreePosition < simulatorPosition);
});

test("V136 conserva el control privado de visibilidad de contrasena", () => {
  assert.match(indexSource, /class="password-visibility-toggle"/);
  assert.match(appSource, /function wirePasswordVisibilityToggles/);
  assert.match(appSource, /input\.type === "password" \? "text" : "password"/);
});
