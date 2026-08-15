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

function createScoreRuntime() {
  const names = [
    "roundPayoffMoney",
    "inferProjectionMinimumPayment",
    "normalizeDebtForProjection",
    "sortProjectionTargets",
    "planPaymentInputsForProjection",
    "estimateDebtFreeProjectionForDashboard",
    "clampDebtYaScorePoints",
    "scoreDebtDataCompleteness",
    "calculateWeightedAprForScore",
    "scoreInterestPressure",
    "scoreMonthlyPaymentStrength",
    "scorePayoffOutlook",
    "buildDebtYaScore",
    "buildDebtYaScoreWithExtra"
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
      const number = Number(row?.balance ?? row?.current_balance ?? 0);
      return Number.isFinite(number) ? Math.max(0, number) : 0;
    },
    isDebtActiveForDashboard(row) {
      const status = String(row?.status || "").toLowerCase();
      const balance = Number(row?.balance ?? row?.current_balance ?? 0);
      return !!row && row.is_active !== false && !["paid", "paid_off", "archived"].includes(status) && balance > 0.01;
    },
    parseAprValue(row) {
      const raw = row?.apr ?? row?.interest_rate;
      if (raw === null || raw === undefined || raw === "") return null;
      const number = Number(String(raw).replace("%", ""));
      return Number.isFinite(number) ? number : null;
    },
    cleanVisibleDebtName(value) {
      return String(value ?? "").replace(/^spinwheel\s+/i, "").trim();
    }
  };
  const code = names.map((name) => extractFunction(appSource, name)).join("\n\n");
  vm.runInNewContext(
    `${code}\nglobalThis.scorePlan = buildDebtYaScore; globalThis.scoreWithExtra = buildDebtYaScoreWithExtra;`,
    context
  );
  return { scorePlan: context.scorePlan, scoreWithExtra: context.scoreWithExtra };
}

test("V133 devuelve 100 cuando no quedan deudas activas", () => {
  const { scorePlan } = createScoreRuntime();
  const result = scorePlan([], {}, "avalanche");

  assert.equal(result.score, 100);
  assert.equal(result.statusKey, "score_status_debt_free");
  assert.deepEqual(Object.values(result.factors), [25, 25, 25, 25]);
});

test("V133 mantiene cada factor entre 0 y 25 y el total entre 0 y 100", () => {
  const { scorePlan } = createScoreRuntime();
  const result = scorePlan(
    [{ id: "card", name: "Card", balance: 5000, apr: 120, minimum_payment: 25 }],
    {},
    "avalanche"
  );

  assert.ok(result.score >= 0 && result.score <= 100);
  Object.values(result.factors).forEach((factor) => assert.ok(factor >= 0 && factor <= 25));
  assert.equal(result.factors.interest, 0);
  assert.equal(result.factors.outlook, 0);
});

test("V133 premia un plan completo y no inventa APR ni pago minimo", () => {
  const { scorePlan } = createScoreRuntime();
  const incomplete = scorePlan(
    [{ id: "card", name: "Card", balance: 5000 }],
    {},
    "avalanche"
  );
  const complete = scorePlan(
    [{ id: "card", name: "Card", balance: 5000, apr: 10, minimum_payment: 100 }],
    {},
    "avalanche"
  );

  assert.equal(incomplete.factors.data, 0);
  assert.equal(complete.factors.data, 25);
  assert.ok(complete.score > incomplete.score);
});

test("V133 calcula de forma conservadora la mejora con 50 dolares extra", () => {
  const { scoreWithExtra } = createScoreRuntime();
  const debts = [
    { id: "high", name: "High APR", balance: 5000, apr: 29.99, minimum_payment: 150 },
    { id: "low", name: "Low APR", balance: 2500, apr: 7.5, minimum_payment: 75 }
  ];
  const result = scoreWithExtra(debts, {}, "avalanche", 50);

  assert.equal(result.additional, 50);
  assert.ok(result.potential.score >= result.current.score);
  assert.equal(result.gain, result.potential.score - result.current.score);
});

test("V133 es local y no cambia APIs, almacenamiento ni integraciones", () => {
  const start = appSource.indexOf("function clampDebtYaScorePoints");
  const end = appSource.indexOf("function formatDebtFreeDateFromMonths", start);
  const scoreSource = appSource.slice(start, end);

  assert.equal(scoreSource.includes("api("), false);
  assert.equal(scoreSource.includes("localStorage"), false);
  assert.equal(scoreSource.includes("supabase"), false);
  assert.equal(scoreSource.includes("stripe"), false);
  assert.equal(scoreSource.includes("plaid"), false);
});

test("V135 publica el estado del plan sin mostrar un puntaje arbitrario", () => {
  for (const id of [
    "debtYaScoreStatus",
    "debtScoreDataPoints",
    "debtScoreInterestPoints",
    "debtScorePaymentPoints",
    "debtScoreOutlookPoints",
    "debtYaScoreAction"
  ]) {
    assert.match(indexSource, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(indexSource, /id="debtYaScoreValue"/);
  assert.doesNotMatch(indexSource, />\/100</);
  assert.doesNotMatch(indexSource, /id="debtScore(?:Data|Interest|Payment|Outlook)Bar"/);
  assert.match(indexSource, /data-i18n="score_title">Your plan status</);
  assert.match(indexSource, /Estimate based on the balances, APRs, and payments you entered\./);
});

test("V135 muestra datos financieros comprensibles", () => {
  assert.doesNotMatch(indexSource, />0\/25</);
  assert.match(indexSource, /data-i18n="score_factor_data">Complete information</);
  assert.match(indexSource, /data-i18n="score_factor_interest">Cost of your debt</);
  assert.match(indexSource, /data-i18n="score_factor_payment">Your monthly payment</);
  assert.match(indexSource, /data-i18n="score_factor_outlook">Time remaining</);
  assert.match(appSource, /score_data_value: "\{complete\} of \{count\} complete"/);
  assert.match(appSource, /score_payment_minimums: "Minimums only"/);
  assert.match(appSource, /score_interest_debt_free: "No interest"/);
  assert.match(appSource, /score_outlook_debt_free: "Debt free"/);
});

test("V135 explica el factor limitante y solo promete impacto financiero concreto", () => {
  for (const key of [
    "score_meaning_data",
    "score_meaning_interest",
    "score_meaning_payment",
    "score_meaning_outlook",
    "score_impact_both"
  ]) {
    assert.match(appSource, new RegExp(`${key}:`));
  }
  assert.match(appSource, /buildPayMoreProjection\(debts, state\.plan \|\| \{\}, strategy, 50\)/);
  assert.match(appSource, /interestSaved/);
  assert.match(appSource, /monthsSaved/);
  assert.doesNotMatch(appSource, /DebtYa Score: \{score\}/);
  assert.doesNotMatch(appSource, /score_impact_score/);
  assert.match(appSource, /if \(!hasMonths && !hasInterest\) return "";/);
});

test("V135 abre el simulador con 50 dolares desde el estado del plan", () => {
  assert.match(indexSource, /id="debtYaScoreSimulateBtn"/);
  assert.match(indexSource, /data-i18n="score_see_50_impact"/);
  assert.match(appSource, /state\.payoffSimulatorExtraMonthly = 50;/);
  assert.match(appSource, /\$\("payoffSimulationCard"\)\?\.scrollIntoView/);
});
