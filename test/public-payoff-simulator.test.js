const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function createSimulatorRuntime() {
  const names = [
    "roundPayoffMoney",
    "inferProjectionMinimumPayment",
    "normalizeDebtForProjection",
    "sortProjectionTargets",
    "planPaymentInputsForProjection",
    "estimateDebtFreeProjectionForDashboard",
    "normalizePayoffSimulatorExtra",
    "buildPayMoreProjection"
  ];
  const context = {
    Number,
    Math,
    String,
    Array,
    Object,
    PAYOFF_MAX_MONTHS_UI: 600,
    PAYOFF_EPS_UI: 0.02,
    toNum(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    },
    debtBalanceForDashboard(row) {
      const number = Number(row?.balance ?? row?.current_balance ?? row?.currentBalance ?? 0);
      return Number.isFinite(number) ? Math.max(0, number) : 0;
    },
    isDebtActiveForDashboard(row) {
      const status = String(row?.status || "").toLowerCase();
      return row && status !== "paid" && status !== "closed" && status !== "inactive";
    },
    parseAprValue(row) {
      const number = Number(row?.apr ?? row?.interest_rate ?? row?.APR);
      return Number.isFinite(number) ? number : null;
    },
    cleanVisibleDebtName(value) {
      return String(value ?? "").replace(/^spinwheel\s+/i, "").trim();
    }
  };
  const code = names.map((name) => extractFunction(appSource, name)).join("\n\n");
  vm.runInNewContext(`${code}\nglobalThis.buildProjection = buildPayMoreProjection;`, context);
  return context.buildProjection;
}

const debts = [
  { id: "high-apr", name: "High APR", balance: 5000, apr: 29.99, minimum_payment: 150 },
  { id: "low-apr", name: "Low APR", balance: 2500, apr: 7.5, minimum_payment: 75 }
];

test("V132 suma el monto simulado por encima de los pagos minimos", () => {
  const buildProjection = createSimulatorRuntime();
  const result = buildProjection(debts, {}, "avalanche", 100);

  assert.equal(result.ok, true);
  assert.equal(result.baseline.totalMonthlyPayment, 225);
  assert.equal(result.scenario.totalMonthlyPayment, 325);
  assert.ok(result.scenario.months <= result.baseline.months);
  assert.ok(result.scenario.totalInterest <= result.baseline.totalInterest);
});

test("V132 conserva el plan actual y agrega la cantidad elegida", () => {
  const buildProjection = createSimulatorRuntime();
  const result = buildProjection(
    debts,
    { monthly_budget: 300, extra_payment_default: 50 },
    "snowball",
    250
  );

  assert.equal(result.ok, true);
  assert.equal(result.baseline.totalMonthlyPayment, 350);
  assert.equal(result.scenario.totalMonthlyPayment, 600);
  assert.ok(result.monthsSaved >= 0);
  assert.ok(result.interestSaved >= 0);
});

test("V132 limita cantidades invalidas sin guardar ni llamar APIs", () => {
  const buildProjection = createSimulatorRuntime();
  assert.equal(buildProjection(debts, {}, "avalanche", -50).additional, 0);
  assert.equal(buildProjection(debts, {}, "avalanche", 250000).additional, 100000);

  const start = appSource.indexOf("function normalizePayoffSimulatorExtra");
  const end = appSource.indexOf("function normalizeIntentMetadata", start);
  const simulatorSource = appSource.slice(start, end);
  assert.equal(simulatorSource.includes("api("), false);
  assert.equal(simulatorSource.includes("localStorage"), false);
});

test("V132 no promete ahorro de interes cuando la base supera 600 meses", () => {
  const buildProjection = createSimulatorRuntime();
  const result = buildProjection(
    [{ id: "growing", name: "Growing", balance: 1000, apr: 120, minimum_payment: 25 }],
    {},
    "avalanche",
    100
  );

  assert.equal(result.ok, true);
  assert.equal(result.baseline.monthsCapped, true);
  assert.equal(result.interestSaved, null);
});

test("V132 expone cantidades rapidas, entrada personalizada y ambos resultados", () => {
  for (const amount of ["50", "100", "250"]) {
    assert.match(indexSource, new RegExp(`data-sim-extra="${amount}"`));
  }
  for (const id of [
    "simCustomExtra",
    "simAvalancheDate",
    "simAvalancheMonths",
    "simAvalancheInterest",
    "simSnowballDate",
    "simSnowballMonths",
    "simSnowballInterest",
    "simCompareSummary"
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
});
