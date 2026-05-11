/**
 * Month-by-month Avalanche vs Snowball comparison (estimated, not guaranteed).
 * Money rounded to 2 decimals. Max 600 months then capped flag.
 */

const { debtRowEligibleForPlan } = require("./debt-paid-helpers");

const MAX_MONTHS = 600;
const EPS = 0.02;

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function inferMinimumPayment(balance, statedMin) {
  const sm = round2(Number(statedMin));
  if (sm > 0) return Math.min(sm, balance);
  if (!(balance > EPS)) return 0;
  return Math.min(balance, Math.max(25, round2(balance * 0.02)));
}

/**
 * @param {object} row debt row from DB
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function normalizeDebtRow(row, safeNumber) {
  if (!row || typeof row !== "object") return null;
  const id = row.id != null ? String(row.id).trim() : "";
  if (!id) return null;
  const name = row.name != null ? String(row.name).trim() : "";
  const balance = Math.max(
    0,
    round2(safeNumber(row.balance ?? row.current_balance ?? row.currentBalance ?? 0))
  );
  const apr = Math.max(0, safeNumber(row.apr ?? row.interest_rate ?? row.APR ?? 0));
  const minimum_payment = inferMinimumPayment(balance, row.minimum_payment ?? row.min_payment);
  return { id, name, balance, apr, minimum_payment };
}

function sortExtraRecipients(debts, strategy) {
  const arr = debts.filter((d) => d.balance > EPS);
  if (strategy === "snowball") {
    arr.sort((a, b) => a.balance - b.balance || b.apr - a.apr || String(a.id).localeCompare(String(b.id)));
  } else {
    arr.sort((a, b) => b.apr - a.apr || b.balance - a.balance || String(a.id).localeCompare(String(b.id)));
  }
  return arr;
}

/**
 * @param {"avalanche"|"snowball"} strategy
 * @param {ReturnType<typeof normalizeDebtRow>[]} normalizedDebts
 * @param {number} totalMonthlyPayment
 */
function simulateStrategy(strategy, normalizedDebts, totalMonthlyPayment) {
  const items = normalizedDebts
    .filter(Boolean)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: d.balance,
      apr: d.apr,
      minimum_payment: d.minimum_payment
    }));

  let month = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  let firstRecommended = null;
  let capped = false;

  while (items.some((d) => d.balance > EPS) && month < MAX_MONTHS) {
    month += 1;

    for (const d of items) {
      if (d.balance <= EPS) continue;
      const interest = round2((d.balance * d.apr) / 100 / 12);
      totalInterest += interest;
      d.balance = round2(d.balance + interest);
    }

    let pool = round2(totalMonthlyPayment);
    const active = items.filter((d) => d.balance > EPS);
    if (!active.length) break;

    const minOrder = [...active].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const d of minOrder) {
      const need = Math.min(d.minimum_payment, d.balance);
      const pay = Math.min(need, pool);
      d.balance = round2(Math.max(0, d.balance - pay));
      pool = round2(pool - pay);
      totalPaid += pay;
    }

    if (month === 1) {
      const ord = sortExtraRecipients(items, strategy);
      if (ord[0]) {
        firstRecommended = { id: ord[0].id, name: ord[0].name || "" };
      }
    }

    while (pool > EPS) {
      const withBal = items.filter((d) => d.balance > EPS);
      if (!withBal.length) break;
      const ord = sortExtraRecipients(withBal, strategy);
      const tgt = ord[0];
      if (!tgt) break;
      const pay = Math.min(tgt.balance, pool);
      tgt.balance = round2(Math.max(0, tgt.balance - pay));
      pool = round2(pool - pay);
      totalPaid += pay;
    }
  }

  if (items.some((d) => d.balance > EPS)) capped = true;

  return {
    strategy,
    months: month,
    months_to_payoff: capped ? `${MAX_MONTHS}+` : month,
    months_numeric: month,
    months_capped: capped,
    total_interest: round2(totalInterest),
    total_paid: round2(totalPaid),
    first_recommended_debt: firstRecommended,
    timeline: []
  };
}

/**
 * @param {object[]} debtRows raw rows from debts table
 * @param {number} monthlyBudget
 * @param {number} extraPayment
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function compareStrategiesFromDebtRows(debtRows, monthlyBudget, extraPayment, safeNumber) {
  const normalized = (debtRows || [])
    .filter((r) => debtRowEligibleForPlan(r, safeNumber))
    .map((r) => normalizeDebtRow(r, safeNumber))
    .filter(Boolean)
    .filter((d) => d.balance > EPS);

  if (!normalized.length) {
    return {
      insufficient_data: true,
      insufficient_reason: "no_active_debt_balance",
      inputs: {
        debts: [],
        monthly_budget: round2(monthlyBudget),
        extra_payment: round2(extraPayment),
        total_monthly_payment: 0,
        minimums_sum: 0
      },
      avalanche: null,
      snowball: null
    };
  }

  const minSum = round2(
    normalized.reduce((s, d) => s + Math.min(d.minimum_payment, d.balance), 0)
  );
  const userInput = round2(safeNumber(monthlyBudget) + safeNumber(extraPayment));
  const totalMonthlyPayment =
    userInput > EPS ? Math.max(userInput, minSum) : minSum;

  if (!(minSum > EPS)) {
    return {
      insufficient_data: true,
      insufficient_reason: "could_not_infer_minimums",
      inputs: {
        debts: normalized,
        monthly_budget: round2(monthlyBudget),
        extra_payment: round2(extraPayment),
        total_monthly_payment: totalMonthlyPayment,
        minimums_sum: minSum
      },
      avalanche: null,
      snowball: null
    };
  }

  if (totalMonthlyPayment + 1e-6 < minSum) {
    return {
      insufficient_data: true,
      insufficient_reason: "monthly_payment_below_minimums_sum",
      inputs: {
        debts: normalized,
        monthly_budget: round2(monthlyBudget),
        extra_payment: round2(extraPayment),
        total_monthly_payment: totalMonthlyPayment,
        minimums_sum: minSum
      },
      avalanche: null,
      snowball: null
    };
  }

  const avalanche = simulateStrategy("avalanche", normalized, totalMonthlyPayment);
  const snowball = simulateStrategy("snowball", normalized, totalMonthlyPayment);

  return {
    insufficient_data: false,
    insufficient_reason: null,
    inputs: {
      debts: normalized,
      monthly_budget: round2(monthlyBudget),
      extra_payment: round2(extraPayment),
      total_monthly_payment: round2(totalMonthlyPayment),
      minimums_sum: minSum
    },
    avalanche,
    snowball
  };
}

module.exports = {
  MAX_MONTHS,
  round2,
  inferMinimumPayment,
  normalizeDebtRow,
  compareStrategiesFromDebtRows
};
