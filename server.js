require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

function getSupabaseUrl() {
  return String(process.env.SUPABASE_URL || "").trim();
}

function getSupabaseAnonKey() {
  return (
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  ).trim();
}

function getSupabaseServiceRoleKey() {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  ).trim();
}

function assertServerConfig() {
  const missing = [];

  if (!getSupabaseUrl()) missing.push("SUPABASE_URL");
  if (!getSupabaseAnonKey()) missing.push("SUPABASE_ANON_KEY");
  if (!getSupabaseServiceRoleKey()) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!String(process.env.CRON_SECRET || "").trim()) missing.push("CRON_SECRET");

  if (missing.length) {
    console.warn(`[DebtYa] Faltan variables de entorno críticas: ${missing.join(", ")}`);
  }
}

assertServerConfig();

function supabaseHeaders(extra = {}) {
  const anonKey = getSupabaseAnonKey();
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    ...extra,
  };
}

function supabaseAdminHeaders(extra = {}) {
  const serviceKey = getSupabaseServiceRoleKey();

  if (!serviceKey) {
    const error = new Error("Falta la service role key de Supabase en el servidor.");
    error.status = 500;
    throw error;
  }

  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  };
}

function moneyNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

function toIsoNow() {
  return new Date().toISOString();
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.replace("Bearer ", "").trim();
}

function normalizeError(error) {
  return error?.response?.data || error?.message || "Error interno";
}

function sendError(res, error, fallbackStatus = 500) {
  res.status(error.status || fallbackStatus).json({
    ok: false,
    error: normalizeError(error),
    debug: error.debug || null,
  });
}

async function getUserFromToken(req) {
  const token = getAuthToken(req);

  if (!token) {
    const error = new Error("Falta Authorization Bearer token");
    error.status = 401;
    throw error;
  }

  const response = await axios.get(`${getSupabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.data?.id) {
    const error = new Error("Token inválido");
    error.status = 401;
    throw error;
  }

  return response.data;
}

async function supabaseSelect(table, query, req) {
  await getUserFromToken(req);

  const response = await axios.get(`${getSupabaseUrl()}/rest/v1/${table}?${query}`, {
    headers: supabaseHeaders({
      Authorization: `Bearer ${getAuthToken(req)}`,
    }),
  });

  return response.data || [];
}

async function supabaseSelectAdmin(table, query) {
  const response = await axios.get(`${getSupabaseUrl()}/rest/v1/${table}?${query}`, {
    headers: supabaseAdminHeaders(),
  });

  return response.data || [];
}

async function supabaseInsert(table, payload, req) {
  await getUserFromToken(req);

  const response = await axios.post(
    `${getSupabaseUrl()}/rest/v1/${table}`,
    payload,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
    }
  );

  return response.data || [];
}

async function supabasePatch(table, query, payload, req) {
  await getUserFromToken(req);

  const response = await axios.patch(
    `${getSupabaseUrl()}/rest/v1/${table}?${query}`,
    payload,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
    }
  );

  return response.data || [];
}

async function supabaseDelete(table, query, req) {
  await getUserFromToken(req);

  const response = await axios.delete(
    `${getSupabaseUrl()}/rest/v1/${table}?${query}`,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
        Prefer: "return=representation",
      }),
    }
  );

  return response.data || [];
}

async function supabaseRpc(functionName, payload, req) {
  await getUserFromToken(req);

  const response = await axios.post(
    `${getSupabaseUrl()}/rest/v1/rpc/${functionName}`,
    payload,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
        "Content-Type": "application/json",
      }),
    }
  );

  return response.data;
}

async function ensureUserProfile(req, user) {
  const existing = await supabaseSelect(
    "profiles",
    `select=*&id=eq.${user.id}&limit=1`,
    req
  );

  if (existing.length) return existing[0];

  const inserted = await supabaseInsert(
    "profiles",
    {
      id: user.id,
      email: user.email || null,
      created_at: toIsoNow(),
      updated_at: toIsoNow(),
    },
    req
  );

  return inserted[0] || null;
}

function normalizeDebt(debt) {
  return {
    id: debt.id,
    user_id: debt.user_id,
    name: debt.name,
    balance: moneyNumber(debt.balance),
    apr: Number(debt.apr || 0),
    minimum_payment: moneyNumber(debt.minimum_payment || debt.min_payment || 0),
    due_day: Number(debt.due_day || 0),
    type: debt.type || "debt",
    is_active: debt.is_active !== false,
    created_at: debt.created_at,
    updated_at: debt.updated_at,
  };
}

function sortDebtsByStrategy(debts, strategy) {
  if (strategy === "avalanche") {
    return [...debts].sort((a, b) => {
      if (Number(b.apr || 0) !== Number(a.apr || 0)) return Number(b.apr || 0) - Number(a.apr || 0);
      if (Number(a.balance || 0) !== Number(b.balance || 0)) return Number(a.balance || 0) - Number(b.balance || 0);
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  if (strategy === "snowball") {
    return [...debts].sort((a, b) => {
      if (Number(a.balance || 0) !== Number(b.balance || 0)) return Number(a.balance || 0) - Number(b.balance || 0);
      if (Number(b.apr || 0) !== Number(a.apr || 0)) return Number(b.apr || 0) - Number(a.apr || 0);
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  throw new Error("Estrategia no soportada");
}

function buildPlan(debts, strategy, extraPayment) {
  const sorted = sortDebtsByStrategy(debts, strategy);
  const totalMinimumPayment = sorted.reduce((sum, debt) => sum + Number(debt.minimum_payment || 0), 0);
  const targetDebt = sorted[0] || null;

  const plan = sorted.map((debt, index) => ({
    priority: index + 1,
    id: debt.id,
    name: debt.name,
    balance: moneyNumber(debt.balance),
    apr: Number(debt.apr || 0),
    minimum_payment: moneyNumber(debt.minimum_payment || 0),
    due_day: Number(debt.due_day || 0),
    recommended_payment:
      debt.id === targetDebt?.id
        ? moneyNumber(Number(debt.minimum_payment || 0) + Number(extraPayment || 0))
        : moneyNumber(Number(debt.minimum_payment || 0)),
    focus: debt.id === targetDebt?.id,
  }));

  const monthlyBudget = totalMinimumPayment + Number(extraPayment || 0);
  const totalDebt = sorted.reduce((sum, debt) => sum + Number(debt.balance || 0), 0);

  return {
    strategy,
    extra_payment: moneyNumber(extraPayment),
    total_minimum_payment: moneyNumber(totalMinimumPayment),
    total_debt: moneyNumber(totalDebt),
    monthly_budget_estimate: moneyNumber(monthlyBudget),
    target_debt: targetDebt,
    plan,
  };
}

function simulateStrategy(debts, strategy, extraPayment) {
  const activeDebts = debts
    .filter((d) => d.is_active !== false && Number(d.balance || 0) > 0)
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: moneyNumber(d.balance),
      apr: Number(d.apr || 0),
      minimum_payment: moneyNumber(d.minimum_payment),
      due_day: Number(d.due_day || 0),
      type: d.type || "debt",
    }));

  if (!activeDebts.length) {
    return {
      strategy,
      extra_payment: moneyNumber(extraPayment),
      total_minimum_payment: 0,
      total_debt: 0,
      monthly_budget_estimate: 0,
      estimated_months_to_payoff: 0,
      total_interest_paid: 0,
      total_paid: 0,
      target_debt: null,
      payoff_order: [],
      payoff_order_ids: [],
      plan: [],
      amortization_preview: [],
      completed: true,
      reason: "No hay deudas activas.",
    };
  }

  const basePlan = buildPlan(activeDebts, strategy, extraPayment);
  const originalTotalDebt = activeDebts.reduce((sum, d) => sum + d.balance, 0);
  const totalMinimumPayment = activeDebts.reduce((sum, d) => sum + d.minimum_payment, 0);
  const monthlyBudget = totalMinimumPayment + Number(extraPayment || 0);

  let workingDebts = activeDebts.map((d) => ({ ...d }));
  let months = 0;
  let totalInterestPaid = 0;
  let totalPaid = 0;
  const payoffOrder = [];
  const payoffOrderIds = [];
  const amortizationPreview = [];
  const maxMonths = 600;

  while (workingDebts.some((d) => d.balance > 0.005) && months < maxMonths) {
    months += 1;

    let monthInterest = 0;
    let monthPaid = 0;

    for (const debt of workingDebts) {
      if (debt.balance <= 0) continue;
      const monthlyRate = debt.apr > 0 ? debt.apr / 100 / 12 : 0;
      const interest = debt.balance * monthlyRate;
      debt.balance += interest;
      monthInterest += interest;
    }

    totalInterestPaid += monthInterest;

    const ordered = sortDebtsByStrategy(
      workingDebts.filter((d) => d.balance > 0.005),
      strategy
    );

    let remainingBudget = monthlyBudget;

    for (const debt of ordered) {
      if (remainingBudget <= 0) break;
      if (debt.balance <= 0) continue;

      const minDue = Math.min(debt.minimum_payment, debt.balance);
      const payment = Math.min(minDue, remainingBudget, debt.balance);

      debt.balance -= payment;
      remainingBudget -= payment;
      monthPaid += payment;
    }

    while (remainingBudget > 0.005) {
      const focusList = sortDebtsByStrategy(
        workingDebts.filter((d) => d.balance > 0.005),
        strategy
      );

      const focusDebt = focusList[0];
      if (!focusDebt) break;

      const extra = Math.min(remainingBudget, focusDebt.balance);
      focusDebt.balance -= extra;
      remainingBudget -= extra;
      monthPaid += extra;
    }

    totalPaid += monthPaid;

    for (const debt of workingDebts) {
      if (debt.balance < 0.005) {
        debt.balance = 0;
        if (!payoffOrderIds.includes(debt.id)) {
          payoffOrderIds.push(debt.id);
          payoffOrder.push(debt.name);
        }
      }
    }

    if (amortizationPreview.length < 12) {
      const focusListAfterPayment = sortDebtsByStrategy(
        workingDebts.filter((d) => d.balance > 0.005),
        strategy
      );
      const focusDebtAfterPayment = focusListAfterPayment[0] || null;
      const remainingTotal = workingDebts.reduce((sum, d) => sum + d.balance, 0);

      amortizationPreview.push({
        month: months,
        interest_paid: moneyNumber(monthInterest),
        total_paid: moneyNumber(monthPaid),
        remaining_total_balance: moneyNumber(remainingTotal),
        focus_debt_name: focusDebtAfterPayment ? focusDebtAfterPayment.name : "Pagado",
      });
    }
  }

  const completed = workingDebts.reduce((sum, d) => sum + d.balance, 0) <= 0.01;

  return {
    strategy,
    extra_payment: moneyNumber(extraPayment),
    total_minimum_payment: moneyNumber(totalMinimumPayment),
    total_debt: moneyNumber(originalTotalDebt),
    monthly_budget_estimate: moneyNumber(monthlyBudget),
    estimated_months_to_payoff: completed ? months : null,
    total_interest_paid: moneyNumber(totalInterestPaid),
    total_paid: moneyNumber(totalPaid),
    target_debt: basePlan.target_debt,
    payoff_order: payoffOrder,
    payoff_order_ids: payoffOrderIds,
    plan: basePlan.plan,
    amortization_preview: amortizationPreview,
    completed,
    reason: completed ? "Simulación completada." : "La simulación no terminó dentro del límite.",
  };
}

function compareStrategiesLocally(debts, extraPayment) {
  const avalanche = simulateStrategy(debts, "avalanche", extraPayment);
  const snowball = simulateStrategy(debts, "snowball", extraPayment);

  let recommended_strategy = "avalanche";
  let reason = "Avalanche minimiza interés total.";

  const avalancheInterest = Number(avalanche.total_interest_paid || 0);
  const snowballInterest = Number(snowball.total_interest_paid || 0);
  const avalancheMonths = Number(avalanche.estimated_months_to_payoff || 0);
  const snowballMonths = Number(snowball.estimated_months_to_payoff || 0);

  if (snowballInterest < avalancheInterest) {
    recommended_strategy = "snowball";
    reason = "Snowball sale mejor en interés total con tus datos actuales.";
  } else if (snowballMonths && avalancheMonths && snowballMonths < avalancheMonths) {
    recommended_strategy = "snowball";
    reason = "Snowball termina antes con tus datos actuales.";
  }

  return {
    recommended_strategy,
    reason,
    extra_payment: moneyNumber(extraPayment),
    avalanche,
    snowball,
  };
}

function inferTransactionCategory(tx) {
  const merchant = String(tx.merchant_name || "").toLowerCase();
  const description = String(tx.description || tx.name || "").toLowerCase();
  const category = String(tx.category || "").toLowerCase();
  const direction = String(tx.direction || "").toLowerCase();
  const text = `${merchant} ${description} ${category}`;

  if (direction === "credit") return "ingreso";
  if (text.includes("loan") || text.includes("credit card") || text.includes("payment")) return "deuda";
  if (text.includes("rent") || text.includes("insurance") || text.includes("phone") || text.includes("utility")) return "gasto_fijo";
  if (text.includes("restaurant") || text.includes("uber") || text.includes("amazon") || text.includes("walmart") || text.includes("gas")) return "gasto_variable";
  if (text.includes("transfer")) return "transferencia";
  return "otros";
}

function summarizeTransactionCategories(transactions) {
  const buckets = {};

  for (const tx of transactions) {
    const bucket = inferTransactionCategory(tx);
    if (!buckets[bucket]) {
      buckets[bucket] = {
        category: bucket,
        count: 0,
        total_amount: 0,
      };
    }

    buckets[bucket].count += 1;
    buckets[bucket].total_amount = moneyNumber(
      buckets[bucket].total_amount + Math.abs(Number(tx.amount || 0))
    );
  }

  return Object.values(buckets).sort((a, b) => b.total_amount - a.total_amount);
}

async function getActiveDebtsForUser(req, userId) {
  const data = await supabaseSelect(
    "debts",
    `select=*&user_id=eq.${userId}&is_active=eq.true&order=created_at.desc`,
    req
  );
  return data.map(normalizeDebt);
}

async function getAllDebtsForUser(req, userId) {
  const data = await supabaseSelect(
    "debts",
    `select=*&user_id=eq.${userId}&order=created_at.desc`,
    req
  );
  return data.map(normalizeDebt);
}

async function getTransactionsForUser(req, userId) {
  const data = await supabaseSelect(
    "transactions_raw",
    `select=*&user_id=eq.${userId}&order=created_at.desc`,
    req
  );
  return data || [];
}

async function getLatestPlaidItemForUser(req, userId) {
  const items = await supabaseSelect(
    "plaid_items",
    `select=*&user_id=eq.${userId}&order=created_at.desc&limit=1`,
    req
  );
  return items[0] || null;
}

function normalizePlaidTransaction(tx, userId, plaidItemRow) {
  return {
    user_id: userId,
    plaid_item_id: plaidItemRow?.id || null,
    account_id: null,
    external_transaction_id: tx.transaction_id,
    transaction_date: tx.date || null,
    authorized_date: tx.authorized_date || null,
    merchant_name: tx.merchant_name || tx.name || null,
    description: tx.name || null,
    category:
      tx.personal_finance_category?.detailed ||
      (Array.isArray(tx.category) ? tx.category[0] : tx.category || null),
    subcategory:
      tx.personal_finance_category?.primary ||
      (Array.isArray(tx.category) ? tx.category[1] || null : null),
    amount: moneyNumber(tx.amount || 0),
    iso_currency_code: tx.iso_currency_code || "USD",
    direction: Number(tx.amount || 0) >= 0 ? "debit" : "credit",
    raw_payload: tx,
    updated_at: toIsoNow(),
  };
}

async function upsertTransactionByExternalId(req, txPayload) {
  const existing = await supabaseSelect(
    "transactions_raw",
    `select=*&user_id=eq.${txPayload.user_id}&external_transaction_id=eq.${encodeURIComponent(txPayload.external_transaction_id)}`,
    req
  );

  if (existing.length > 0) {
    const existingRow = existing[0];
    const updated = await supabasePatch(
      "transactions_raw",
      `id=eq.${existingRow.id}&user_id=eq.${txPayload.user_id}`,
      { ...txPayload },
      req
    );
    return updated[0] || null;
  }

  const inserted = await supabaseInsert("transactions_raw", txPayload, req);
  return inserted[0] || null;
}

function daysUntilDue(dueDay) {
  const day = Number(dueDay || 0);
  if (!day || day < 1 || day > 31) return null;

  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let due = new Date(now.getFullYear(), now.getMonth(), day);

  if (due < current) {
    due = new Date(now.getFullYear(), now.getMonth() + 1, day);
  }

  const diffMs = due.getTime() - current.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

async function buildDashboardSummary(req, user) {
  const [debts, accounts, transactions, intents, plans, executions] = await Promise.all([
    getAllDebtsForUser(req, user.id),
    supabaseSelect("accounts", `select=*&user_id=eq.${user.id}&order=created_at.desc`, req),
    supabaseSelect("transactions_raw", `select=*&user_id=eq.${user.id}&order=created_at.desc&limit=500`, req),
    supabaseSelect("payment_intents", `select=*&user_id=eq.${user.id}&order=created_at.desc`, req),
    supabaseSelect("payment_plans", `select=*&user_id=eq.${user.id}&order=created_at.desc&limit=1`, req),
    supabaseSelect("payment_executions", `select=*&user_id=eq.${user.id}&order=created_at.desc`, req),
  ]);

  const activeDebts = debts.filter((d) => d.is_active !== false);
  const totalDebtBalance = moneyNumber(activeDebts.reduce((sum, d) => sum + Number(d.balance || 0), 0));
  const totalMinimumPayment = moneyNumber(activeDebts.reduce((sum, d) => sum + Number(d.minimum_payment || 0), 0));
  const totalAccountBalance = moneyNumber(accounts.reduce((sum, a) => sum + Number(a.balance_current ?? a.current_balance ?? 0), 0));
  const totalAvailableBalance = moneyNumber(accounts.reduce((sum, a) => sum + Number(a.balance_available ?? a.available_balance ?? 0), 0));
  const pendingIntents = intents.filter((i) =>
    ["pending_review", "queued", "pending"].includes(String(i.status || "").toLowerCase())
  );
  const executedIntents = intents.filter((i) =>
    ["executed", "success", "completed"].includes(String(i.status || "").toLowerCase())
  );
  const totalExecutedAmount = moneyNumber(
    executions.reduce((sum, e) => sum + Number(e.execution_amount || 0), 0)
  );

  const income = transactions
    .filter((t) => String(t.direction || "").toLowerCase() === "credit")
    .reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);

  const expenses = transactions
    .filter((t) => String(t.direction || "").toLowerCase() !== "credit")
    .reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);

  const availableToAttackDebt = moneyNumber(Math.max(totalAvailableBalance, income - expenses, 0));
  const latestPlan = plans[0]?.payload_json || null;

  const nextDueDebts = activeDebts
    .map((d) => ({
      id: d.id,
      name: d.name,
      due_day: d.due_day,
      days_until_due: daysUntilDue(d.due_day),
      minimum_payment: moneyNumber(d.minimum_payment || 0),
      balance: moneyNumber(d.balance || 0),
      priority:
        daysUntilDue(d.due_day) !== null && daysUntilDue(d.due_day) <= 3
          ? "alta"
          : daysUntilDue(d.due_day) !== null && daysUntilDue(d.due_day) <= 7
            ? "media"
            : "baja",
    }))
    .filter((d) => d.days_until_due !== null)
    .sort((a, b) => a.days_until_due - b.days_until_due)
    .slice(0, 5);

  return {
    user_id: user.id,
    debt_count: debts.length,
    active_debt_count: activeDebts.length,
    accounts_count: accounts.length,
    transactions_count: transactions.length,
    payment_intents_count: intents.length,
    pending_intents_count: pendingIntents.length,
    executed_intents_count: executedIntents.length,
    total_debt_balance: totalDebtBalance,
    total_minimum_payment: totalMinimumPayment,
    total_account_balance: totalAccountBalance,
    total_available_balance: totalAvailableBalance,
    available_to_attack_debt: availableToAttackDebt,
    total_executed_amount: totalExecutedAmount,
    next_due_debts: nextDueDebts,
    latest_plan: latestPlan,
  };
}

async function runRulesInternal(req, userId) {
  const result = await supabaseRpc(
    "apply_rules_v2",
    {
      p_user_id: userId,
      p_mode: null,
      p_limit: 1000,
    },
    req
  );

  const allocations = await supabaseSelect(
    "transaction_allocations",
    `select=*&user_id=eq.${userId}&order=created_at.desc&limit=200`,
    req
  );

  return {
    summary: Array.isArray(result) ? result[0] || {} : result || {},
    allocations,
  };
}

async function buildPaymentIntentsInternal(req, userId, executionMode = "safe", debtId = null) {
  const payload = {
    p_user_id: userId,
    p_mode: executionMode || null,
    p_frequency: null,
    p_auto_approve: String(executionMode || "").toLowerCase() === "full_auto",
  };

  const result = await supabaseRpc("build_intents_v2", payload, req);

  let query = `select=*&user_id=eq.${userId}&execution_mode=eq.${executionMode}&order=created_at.desc&limit=100`;
  if (debtId) {
    query = `select=*&user_id=eq.${userId}&execution_mode=eq.${executionMode}&debt_id=eq.${debtId}&order=created_at.desc&limit=100`;
  }

  const intents = await supabaseSelect("payment_intents", query, req);

  return {
    summary: Array.isArray(result) ? result[0] || {} : result || {},
    intents,
  };
}

async function approvePaymentIntentInternal(req, userId, intentId) {
  const result = await supabaseRpc(
    "approve_intent_v2",
    {
      p_intent_id: intentId,
      p_user_id: userId,
    },
    req
  );

  const intent = await supabaseSelect(
    "payment_intents",
    `select=*&id=eq.${intentId}&user_id=eq.${userId}&limit=1`,
    req
  );

  return {
    summary: Array.isArray(result) ? result[0] || {} : result || {},
    intent: intent[0] || null,
  };
}

async function executePaymentIntentInternal(req, userId, intentId) {
  const result = await supabaseRpc(
    "execute_intent_v2",
    {
      p_intent_id: intentId,
      p_user_id: userId,
      p_provider: "manual",
    },
    req
  );

  const intent = await supabaseSelect(
    "payment_intents",
    `select=*&id=eq.${intentId}&user_id=eq.${userId}&limit=1`,
    req
  );

  const execution = await supabaseSelect(
    "payment_executions",
    `select=*&payment_intent_id=eq.${intentId}&user_id=eq.${userId}&order=created_at.desc&limit=1`,
    req
  );

  return {
    summary: Array.isArray(result) ? result[0] || {} : result || {},
    intent: intent[0] || null,
    execution: execution[0] || null,
  };
}

async function runFullAutoInternal(req, userId) {
  const result = await supabaseRpc(
    "auto_sweep_v2",
    {
      p_user_id: userId,
    },
    req
  );

  const latestIntents = await supabaseSelect(
    "payment_intents",
    `select=*&user_id=eq.${userId}&execution_mode=eq.full_auto&order=created_at.desc&limit=50`,
    req
  );

  const latestExecutions = await supabaseSelect(
    "payment_executions",
    `select=*&user_id=eq.${userId}&order=created_at.desc&limit=50`,
    req
  );

  return {
    summary: Array.isArray(result) ? result[0] || {} : result || {},
    intents: latestIntents,
    executions: latestExecutions,
  };
}

function normalizeSecret(value) {
  return String(value ?? "")
    .replace(/^["']|["']$/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim();
}

function getCronSecretFromRequest(req) {
  const headerSecret =
    req.headers["x-cron-secret"] ||
    req.headers["x-debtya-cron-secret"] ||
    req.headers["x-api-key"] ||
    null;

  const authHeader = req.headers.authorization || "";
  const bearerSecret = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7)
    : null;

  const querySecret = req.query?.secret || null;
  const bodySecret = req.body?.secret || null;

  return {
    raw: headerSecret || bearerSecret || querySecret || bodySecret || "",
    source:
      headerSecret ? "header"
      : bearerSecret ? "bearer"
      : querySecret ? "query"
      : bodySecret ? "body"
      : "missing",
  };
}

function getAcceptedCronSecrets() {
  return [
    process.env.CRON_SECRET,
    process.env.CRON_SECRET_FALLBACK,
  ]
    .map(normalizeSecret)
    .filter(Boolean);
}

function requireCronSecret(req) {
  const acceptedSecrets = getAcceptedCronSecrets();

  if (!acceptedSecrets.length) {
    const error = new Error("CRON_SECRET no está configurado en Render.");
    error.status = 500;
    throw error;
  }

  const receivedInfo = getCronSecretFromRequest(req);
  const received = normalizeSecret(receivedInfo.raw);
  const isValid = acceptedSecrets.includes(received);

  if (!received || !isValid) {
    const primary = acceptedSecrets[0] || "";
    const error = new Error("Cron secret inválido.");
    error.status = 401;
    error.debug = {
      expected_length: primary.length,
      received_length: received.length,
      received_source: receivedInfo.source,
      expected_preview: primary.slice(0, 6),
      received_preview: received.slice(0, 6),
      accepted_count: acceptedSecrets.length,
      expected_char_codes: primary.split("").slice(0, 12).map((c) => c.charCodeAt(0)),
      received_char_codes: received.split("").slice(0, 12).map((c) => c.charCodeAt(0)),
    };
    throw error;
  }
}

async function getFullAutoUsersAdmin() {
  const rules = await supabaseSelectAdmin(
    "automation_rules",
    "select=user_id,execution_mode,active&execution_mode=eq.full_auto&active=eq.true"
  );

  const uniqueUserIds = [...new Set((rules || []).map((r) => r.user_id).filter(Boolean))];
  return uniqueUserIds;
}

async function runCronFullAutoSweep() {
  const userIds = await getFullAutoUsersAdmin();

  const results = [];
  let totalUsers = 0;
  let successUsers = 0;
  let failedUsers = 0;
  let totalAllocations = 0;
  let totalIntents = 0;
  let totalExecuted = 0;
  let totalExecutedAmount = 0;

  for (const userId of userIds) {
    totalUsers += 1;

    try {
      const response = await axios.post(
        `${getSupabaseUrl()}/rest/v1/rpc/auto_sweep_v2`,
        { p_user_id: userId },
        {
          headers: supabaseAdminHeaders({
            "Content-Type": "application/json",
          }),
        }
      );

      const raw = response.data;
      const summary = Array.isArray(raw) ? raw[0] || {} : raw || {};

      const row = {
        user_id: userId,
        ok: true,
        allocations_created: Number(summary.allocations_created || 0),
        intents_created: Number(summary.intents_created || 0),
        intents_executed: Number(summary.intents_executed || 0),
        total_executed: moneyNumber(summary.total_executed || 0),
      };

      totalAllocations += row.allocations_created;
      totalIntents += row.intents_created;
      totalExecuted += row.intents_executed;
      totalExecutedAmount = moneyNumber(totalExecutedAmount + row.total_executed);
      successUsers += 1;
      results.push(row);
    } catch (error) {
      failedUsers += 1;
      results.push({
        user_id: userId,
        ok: false,
        error: normalizeError(error),
      });
    }
  }

  return {
    ok: true,
    ran_at: toIsoNow(),
    total_users: totalUsers,
    success_users: successUsers,
    failed_users: failedUsers,
    allocations_created: totalAllocations,
    intents_created: totalIntents,
    intents_executed: totalExecuted,
    total_executed_amount: moneyNumber(totalExecutedAmount),
    results,
    env_debug: {
      has_supabase_url: !!getSupabaseUrl(),
      has_anon_key: !!getSupabaseAnonKey(),
      has_service_role_key: !!getSupabaseServiceRoleKey(),
      has_cron_secret: !!normalizeSecret(process.env.CRON_SECRET),
    },
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    message: "DebtYa API funcionando",
    now: toIsoNow(),
    env_debug: {
      has_supabase_url: !!getSupabaseUrl(),
      has_anon_key: !!getSupabaseAnonKey(),
      has_service_role_key: !!getSupabaseServiceRoleKey(),
      has_cron_secret: !!normalizeSecret(process.env.CRON_SECRET),
    },
  });
});

app.get("/me", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    res.json({ ok: true, user });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/dashboard/summary", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await buildDashboardSummary(req, user);
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/dashboard/payoff", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const strategy = String(req.query.strategy || "avalanche").toLowerCase();
    const extraPayment = Number(req.query.extra_payment || 0);
    const debts = await getActiveDebtsForUser(req, user.id);
    const result = simulateStrategy(debts, strategy, extraPayment);

    res.json({
      ok: true,
      data: result,
      ...result,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/dashboard/feed", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const [summary, debts, transactions] = await Promise.all([
      buildDashboardSummary(req, user),
      getActiveDebtsForUser(req, user.id),
      getTransactionsForUser(req, user.id),
    ]);

    const categories = summarizeTransactionCategories(transactions).slice(0, 5);
    const payoff = simulateStrategy(debts, "avalanche", 0);

    res.json({
      ok: true,
      data: {
        summary,
        categories,
        payoff,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/notifications/preview", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const debts = await getActiveDebtsForUser(req, user.id);

    const reminders = debts
      .map((debt) => ({
        debt_id: debt.id,
        debt_name: debt.name,
        due_day: debt.due_day,
        days_until_due: daysUntilDue(debt.due_day),
        minimum_payment: moneyNumber(debt.minimum_payment || 0),
        balance: moneyNumber(debt.balance || 0),
        priority:
          daysUntilDue(debt.due_day) !== null && daysUntilDue(debt.due_day) <= 3
            ? "alta"
            : daysUntilDue(debt.due_day) !== null && daysUntilDue(debt.due_day) <= 7
              ? "media"
              : "baja",
      }))
      .filter((x) => x.days_until_due !== null)
      .sort((a, b) => a.days_until_due - b.days_until_due);

    res.json({
      ok: true,
      count: reminders.length,
      data: reminders,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/analytics/categories", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const transactions = await getTransactionsForUser(req, user.id);
    const data = summarizeTransactionCategories(transactions);

    res.json({
      ok: true,
      count: data.length,
      data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/goals/preview", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const targetAmount = Number(req.query.target_amount || 0);
    const targetMonths = Number(req.query.target_months || 0);
    const debts = await getActiveDebtsForUser(req, user.id);
    const currentDebt = moneyNumber(debts.reduce((sum, d) => sum + Number(d.balance || 0), 0));
    const reductionNeeded = moneyNumber(Math.max(currentDebt - targetAmount, 0));
    const monthlyNeeded = targetMonths > 0 ? moneyNumber(reductionNeeded / targetMonths) : reductionNeeded;

    res.json({
      ok: true,
      data: {
        current_debt: currentDebt,
        target_amount: moneyNumber(targetAmount),
        target_months: targetMonths,
        reduction_needed: reductionNeeded,
        required_monthly_reduction: monthlyNeeded,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/strategy/compare", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const extraPayment = Number(req.body.extra_payment || 0);
    const debts = await getActiveDebtsForUser(req, user.id);
    const result = compareStrategiesLocally(debts, extraPayment);
    res.json({ ok: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/debts", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await getAllDebtsForUser(req, user.id);
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/accounts", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "accounts",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/transactions-raw", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "transactions_raw",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/transactions", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "transactions_raw",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/preferences", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const profile = await ensureUserProfile(req, user);
    res.json({
      ok: true,
      data: {
        full_name: profile?.full_name || "",
        preferred_strategy: profile?.preferred_strategy || "avalanche",
        default_extra_payment: Number(profile?.default_extra_payment || 0),
        default_monthly_budget: Number(profile?.default_monthly_budget || 0),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/preferences", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    await ensureUserProfile(req, user);

    const updated = await supabasePatch(
      "profiles",
      `id=eq.${user.id}`,
      {
        full_name: req.body.full_name || null,
        preferred_strategy: req.body.preferred_strategy || "avalanche",
        default_extra_payment: moneyNumber(req.body.default_extra_payment || 0),
        default_monthly_budget: moneyNumber(req.body.default_monthly_budget || 0),
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data: updated[0] || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/automation-rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "automation_rules",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "automation_rules",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/automation/rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "automation_rules",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation-rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const payload = {
      user_id: user.id,
      source_account_id: req.body.source_account_id || null,
      target_debt_id: req.body.target_debt_id,
      rule_name: req.body.rule_name || "Regla automática",
      rule_type: req.body.rule_type || "fixed_amount",
      rule_value: moneyNumber(req.body.rule_value || 0),
      execution_mode: req.body.execution_mode || "safe",
      execution_frequency: req.body.execution_frequency || "daily",
      apply_to_transaction_type: req.body.apply_to_transaction_type || "debit_only",
      min_transaction_amount: moneyNumber(req.body.min_transaction_amount || 0),
      max_per_transaction:
        req.body.max_per_transaction === undefined || req.body.max_per_transaction === "" ? null : moneyNumber(req.body.max_per_transaction),
      max_per_day:
        req.body.max_per_day === undefined || req.body.max_per_day === "" ? null : moneyNumber(req.body.max_per_day),
      max_per_month:
        req.body.max_per_month === undefined || req.body.max_per_month === "" ? null : moneyNumber(req.body.max_per_month),
      require_user_confirmation:
        req.body.require_user_confirmation === undefined ? true : !!req.body.require_user_confirmation,
      allow_partial_execution:
        req.body.allow_partial_execution === undefined ? true : !!req.body.allow_partial_execution,
      active: req.body.active === undefined ? true : !!req.body.active,
      starts_at: req.body.starts_at || null,
      ends_at: req.body.ends_at || null,
      updated_at: toIsoNow(),
    };

    const data = await supabaseInsert("automation_rules", payload, req);
    res.json({ ok: true, inserted_count: data.length, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/automation-rules/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const existing = await supabaseSelect(
      "automation_rules",
      `select=*&id=eq.${id}&user_id=eq.${user.id}&limit=1`,
      req
    );

    if (!existing.length) {
      return res.status(404).json({ ok: false, error: "Regla no encontrada" });
    }

    const current = existing[0];
    const payload = {
      rule_name: req.body.rule_name !== undefined ? req.body.rule_name : current.rule_name,
      rule_type: req.body.rule_type !== undefined ? req.body.rule_type : current.rule_type,
      rule_value: req.body.rule_value !== undefined ? moneyNumber(req.body.rule_value) : current.rule_value,
      execution_mode: req.body.execution_mode !== undefined ? req.body.execution_mode : current.execution_mode,
      execution_frequency: req.body.execution_frequency !== undefined ? req.body.execution_frequency : current.execution_frequency,
      apply_to_transaction_type:
        req.body.apply_to_transaction_type !== undefined ? req.body.apply_to_transaction_type : current.apply_to_transaction_type,
      min_transaction_amount:
        req.body.min_transaction_amount !== undefined ? moneyNumber(req.body.min_transaction_amount) : current.min_transaction_amount,
      max_per_transaction:
        req.body.max_per_transaction !== undefined
          ? (req.body.max_per_transaction === "" || req.body.max_per_transaction === null ? null : moneyNumber(req.body.max_per_transaction))
          : current.max_per_transaction,
      max_per_day:
        req.body.max_per_day !== undefined
          ? (req.body.max_per_day === "" || req.body.max_per_day === null ? null : moneyNumber(req.body.max_per_day))
          : current.max_per_day,
      max_per_month:
        req.body.max_per_month !== undefined
          ? (req.body.max_per_month === "" || req.body.max_per_month === null ? null : moneyNumber(req.body.max_per_month))
          : current.max_per_month,
      require_user_confirmation:
        req.body.require_user_confirmation !== undefined ? !!req.body.require_user_confirmation : current.require_user_confirmation,
      allow_partial_execution:
        req.body.allow_partial_execution !== undefined ? !!req.body.allow_partial_execution : current.allow_partial_execution,
      active:
        req.body.active !== undefined ? !!req.body.active : current.active,
      target_debt_id:
        req.body.target_debt_id !== undefined ? req.body.target_debt_id : current.target_debt_id,
      source_account_id:
        req.body.source_account_id !== undefined ? req.body.source_account_id : current.source_account_id,
      starts_at:
        req.body.starts_at !== undefined ? req.body.starts_at : current.starts_at,
      ends_at:
        req.body.ends_at !== undefined ? req.body.ends_at : current.ends_at,
      updated_at: toIsoNow(),
    };

    const data = await supabasePatch(
      "automation_rules",
      `id=eq.${id}&user_id=eq.${user.id}`,
      payload,
      req
    );

    res.json({ ok: true, data: data[0] || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/automation-rules/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const data = await supabaseDelete(
      "automation_rules",
      `id=eq.${id}&user_id=eq.${user.id}`,
      req
    );

    res.json({ ok: true, deleted_count: data.length, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const payload = {
      user_id: user.id,
      source_account_id: req.body.source_account_id || null,
      target_debt_id: req.body.target_debt_id,
      rule_name: req.body.rule_name || "Regla automática",
      rule_type: req.body.rule_type || "fixed_amount",
      rule_value: moneyNumber(req.body.rule_value || 0),
      execution_mode: req.body.execution_mode || "safe",
      execution_frequency: req.body.execution_frequency || "daily",
      apply_to_transaction_type: req.body.apply_to_transaction_type || "debit_only",
      min_transaction_amount: moneyNumber(req.body.min_transaction_amount || 0),
      max_per_transaction:
        req.body.max_per_transaction === undefined || req.body.max_per_transaction === "" ? null : moneyNumber(req.body.max_per_transaction),
      max_per_day:
        req.body.max_per_day === undefined || req.body.max_per_day === "" ? null : moneyNumber(req.body.max_per_day),
      max_per_month:
        req.body.max_per_month === undefined || req.body.max_per_month === "" ? null : moneyNumber(req.body.max_per_month),
      require_user_confirmation:
        req.body.require_user_confirmation === undefined ? true : !!req.body.require_user_confirmation,
      allow_partial_execution:
        req.body.allow_partial_execution === undefined ? true : !!req.body.allow_partial_execution,
      active: req.body.active === undefined ? true : !!req.body.active,
      starts_at: req.body.starts_at || null,
      ends_at: req.body.ends_at || null,
      updated_at: toIsoNow(),
    };

    const data = await supabaseInsert("automation_rules", payload, req);
    res.json({ ok: true, inserted_count: data.length, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation-rules/run", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const result = await runRulesInternal(req, user.id);

    res.json({
      ok: true,
      created_count: Number(result.summary?.allocations_created || 0),
      summary: result.summary,
      data: result.allocations,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation/apply", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const result = await supabaseRpc(
      "apply_rules_v2",
      {
        p_user_id: user.id,
        p_mode: req.body.mode || null,
        p_limit: Number(req.body.limit || 1000),
      },
      req
    );

    res.json({ ok: true, data: Array.isArray(result) ? result[0] || {} : result || {} });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/rules/apply", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const result = await supabaseRpc(
      "apply_rules_v2",
      {
        p_user_id: user.id,
        p_mode: req.body.mode || null,
        p_limit: Number(req.body.limit || 1000),
      },
      req
    );

    res.json({ ok: true, data: Array.isArray(result) ? result[0] || {} : result || {} });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/transaction-allocations", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "transaction_allocations",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/allocations", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "transaction_allocations",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-intents/build", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { execution_mode = "safe", debt_id = null } = req.body;

    const result = await buildPaymentIntentsInternal(req, user.id, execution_mode, debt_id);

    if (!result.intents.length) {
      return res.json({
        ok: true,
        message: "No hay asignaciones pendientes para convertir.",
        summary: result.summary,
        data: [],
      });
    }

    res.json({
      ok: true,
      created_count: Number(result.summary?.intents_created || 0),
      summary: result.summary,
      data: result.intents,
      message: `Payment intents creados: ${Number(result.summary?.intents_created || 0)}`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-intents/build-single", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { execution_mode = "safe", debt_id = null } = req.body;

    if (!debt_id) {
      return res.status(400).json({ ok: false, error: "Falta debt_id" });
    }

    const result = await buildPaymentIntentsInternal(req, user.id, execution_mode, debt_id);

    if (!result.intents.length) {
      return res.json({
        ok: true,
        message: "No hay asignaciones pendientes para esa deuda.",
        summary: result.summary,
        data: [],
      });
    }

    res.json({
      ok: true,
      created_count: Number(result.summary?.intents_created || 0),
      summary: result.summary,
      data: result.intents,
      message: `Payment intents individuales creados: ${Number(result.summary?.intents_created || 0)}`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/payment-intents", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "payment_intents",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-intents/:id/approve", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const result = await approvePaymentIntentInternal(req, user.id, id);

    res.json({
      ok: true,
      data: result.intent,
      summary: result.summary,
      message: "Payment intent aprobado.",
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-intents/:id/execute", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const result = await executePaymentIntentInternal(req, user.id, id);

    res.json({
      ok: true,
      data: result,
      message: "Payment intent ejecutado.",
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/payment-executions", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "payment_executions",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/executions", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "payment_executions",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/history", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "payment_executions",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/trace", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "v_payment_trace",
      `select=*&user_id=eq.${user.id}&order=transaction_date.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/payment-plans", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "payment_plans",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-plans/save", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const strategy = String(req.body.strategy || "avalanche").toLowerCase();
    const extraPayment = Number(req.body.extra_payment || 0);
    const monthlyBudget = moneyNumber(req.body.monthly_budget || 0);
    const debts = await getActiveDebtsForUser(req, user.id);
    const payloadJson = simulateStrategy(debts, strategy, extraPayment);

    const data = await supabaseInsert(
      "payment_plans",
      {
        user_id: user.id,
        strategy,
        extra_payment: moneyNumber(extraPayment),
        monthly_budget: monthlyBudget,
        payload_json: payloadJson,
        created_at: toIsoNow(),
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data: data[0] || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation/full-auto/run", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const result = await runFullAutoInternal(req, user.id);

    res.json({
      ok: true,
      message: "Ciclo full auto ejecutado.",
      summary: result.summary,
      created_allocations_count: Number(result.summary?.allocations_created || 0),
      created_intents_count: Number(result.summary?.intents_created || 0),
      auto_executed_count: Number(result.summary?.intents_executed || 0),
      data: {
        created_intents: result.intents,
        auto_executed: result.executions,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/auto-sweep", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const result = await runFullAutoInternal(req, user.id);

    res.json({
      ok: true,
      summary: result.summary,
      data: result,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/plaid/item", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "plaid_items",
      `select=*&user_id=eq.${user.id}&order=created_at.desc&limit=1`,
      req
    );
    res.json({ ok: true, data: data[0] || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const response = await axios.post(
      `${plaidBase}/link/token/create`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        client_name: "DebtYa",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["auth", "transactions"],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    res.json({
      ok: true,
      data: response.data,
      link_token: response.data?.link_token || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/plaid/web", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const response = await axios.post(
      `${plaidBase}/link/token/create`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        client_name: "DebtYa",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["auth", "transactions"],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    res.json({
      ok: true,
      data: response.data,
      link_token: response.data?.link_token || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { public_token, institution_name } = req.body;

    if (!public_token) {
      return res.status(400).json({ ok: false, error: "Falta public_token" });
    }

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const response = await axios.post(
      `${plaidBase}/item/public_token/exchange`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        public_token,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const payload = {
      user_id: user.id,
      plaid_item_id: response.data?.item_id,
      plaid_access_token: response.data?.access_token,
      institution_name:
        institution_name || req.body?.metadata?.institution?.name || "Banco conectado",
      updated_at: toIsoNow(),
    };

    const existing = await supabaseSelect(
      "plaid_items",
      `select=*&plaid_item_id=eq.${response.data?.item_id}&user_id=eq.${user.id}`,
      req
    );

    let data;
    if (existing.length) {
      data = await supabasePatch(
        "plaid_items",
        `id=eq.${existing[0].id}&user_id=eq.${user.id}`,
        payload,
        req
      );
    } else {
      data = await supabaseInsert("plaid_items", payload, req);
    }

    res.json({
      ok: true,
      data: data[0] || null,
      item_id: response.data?.item_id || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/plaid/items", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "plaid_items",
      `select=*&user_id=eq.${user.id}&order=created_at.desc`,
      req
    );
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/accounts/import-last", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const plaidItem = await getLatestPlaidItemForUser(req, user.id);

    if (!plaidItem?.plaid_access_token) {
      return res.status(400).json({ ok: false, error: "No hay access_token de Plaid guardado." });
    }

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const response = await axios.post(
      `${plaidBase}/accounts/get`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: plaidItem.plaid_access_token,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const rows = [];
    for (const account of response.data?.accounts || []) {
      const payload = {
        user_id: user.id,
        plaid_item_id: plaidItem.id,
        plaid_account_id: account.account_id,
        name: account.name || account.official_name || "Cuenta",
        official_name: account.official_name || null,
        mask: account.mask || null,
        subtype: account.subtype || null,
        type: account.type || null,
        balance_current: moneyNumber(account.balances?.current || 0),
        balance_available:
          account.balances?.available === null || account.balances?.available === undefined
            ? null
            : moneyNumber(account.balances.available),
        iso_currency_code: account.balances?.iso_currency_code || "USD",
        updated_at: toIsoNow(),
      };

      const existing = await supabaseSelect(
        "accounts",
        `select=*&user_id=eq.${user.id}&plaid_account_id=eq.${account.account_id}`,
        req
      );

      let saved;
      if (existing.length) {
        saved = await supabasePatch(
          "accounts",
          `id=eq.${existing[0].id}&user_id=eq.${user.id}`,
          payload,
          req
        );
      } else {
        saved = await supabaseInsert("accounts", payload, req);
      }

      if (saved[0]) rows.push(saved[0]);
    }

    res.json({ ok: true, imported_count: rows.length, data: rows });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/accounts/import", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const plaidItem = await getLatestPlaidItemForUser(req, user.id);

    if (!plaidItem?.plaid_access_token) {
      return res.status(400).json({ ok: false, error: "No hay access_token de Plaid guardado." });
    }

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const response = await axios.post(
      `${plaidBase}/accounts/get`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: plaidItem.plaid_access_token,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const rows = [];
    for (const account of response.data?.accounts || []) {
      const payload = {
        user_id: user.id,
        plaid_item_id: plaidItem.id,
        plaid_account_id: account.account_id,
        name: account.name || account.official_name || "Cuenta",
        official_name: account.official_name || null,
        mask: account.mask || null,
        subtype: account.subtype || null,
        type: account.type || null,
        balance_current: moneyNumber(account.balances?.current || 0),
        balance_available:
          account.balances?.available === null || account.balances?.available === undefined
            ? null
            : moneyNumber(account.balances.available),
        iso_currency_code: account.balances?.iso_currency_code || "USD",
        updated_at: toIsoNow(),
      };

      const existing = await supabaseSelect(
        "accounts",
        `select=*&user_id=eq.${user.id}&plaid_account_id=eq.${account.account_id}`,
        req
      );

      let saved;
      if (existing.length) {
        saved = await supabasePatch(
          "accounts",
          `id=eq.${existing[0].id}&user_id=eq.${user.id}`,
          payload,
          req
        );
      } else {
        saved = await supabaseInsert("accounts", payload, req);
      }

      if (saved[0]) rows.push(saved[0]);
    }

    res.json({ ok: true, imported_count: rows.length, data: rows });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/transactions/import-last", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const plaidItem = await getLatestPlaidItemForUser(req, user.id);

    if (!plaidItem?.plaid_access_token) {
      return res.status(400).json({ ok: false, error: "No hay access_token de Plaid guardado." });
    }

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    const startDate =
      req.body?.start_date ||
      new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString().slice(0, 10);
    const endDate = req.body?.end_date || new Date().toISOString().slice(0, 10);

    const response = await axios.post(
      `${plaidBase}/transactions/get`,
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: plaidItem.plaid_access_token,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset: 0 },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const savedRows = [];
    for (const tx of response.data?.transactions || []) {
      const payload = normalizePlaidTransaction(tx, user.id, plaidItem);
      const saved = await upsertTransactionByExternalId(req, payload);
      if (saved) savedRows.push(saved);
    }

    res.json({ ok: true, imported_count: savedRows.length, data: savedRows });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/transactions/sync", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const plaidItem = await getLatestPlaidItemForUser(req, user.id);

    if (!plaidItem?.plaid_access_token) {
      return res.status(400).json({ ok: false, error: "No hay access_token de Plaid guardado." });
    }

    const plaidBase =
      process.env.PLAID_ENV === "production"
        ? "https://production.plaid.com"
        : process.env.PLAID_ENV === "development"
          ? "https://development.plaid.com"
          : "https://sandbox.plaid.com";

    let hasMore = true;
    let cursor = plaidItem.transactions_cursor || null;
    let importedCount = 0;
    let modifiedCount = 0;
    let removedCount = 0;

    while (hasMore) {
      const response = await axios.post(
        `${plaidBase}/transactions/sync`,
        {
          client_id: process.env.PLAID_CLIENT_ID,
          secret: process.env.PLAID_SECRET,
          access_token: plaidItem.plaid_access_token,
          cursor,
        },
        { headers: { "Content-Type": "application/json" } }
      );

      const data = response.data || {};
      const added = data.added || [];
      const modified = data.modified || [];
      const removed = data.removed || [];

      for (const tx of [...added, ...modified]) {
        const payload = normalizePlaidTransaction(tx, user.id, plaidItem);
        await upsertTransactionByExternalId(req, payload);
      }

      for (const tx of removed) {
        if (tx.transaction_id) {
          await supabaseDelete(
            "transactions_raw",
            `user_id=eq.${user.id}&external_transaction_id=eq.${encodeURIComponent(tx.transaction_id)}`,
            req
          );
        }
      }

      importedCount += added.length;
      modifiedCount += modified.length;
      removedCount += removed.length;
      hasMore = !!data.has_more;
      cursor = data.next_cursor || cursor;
    }

    await supabasePatch(
      "plaid_items",
      `id=eq.${plaidItem.id}&user_id=eq.${user.id}`,
      {
        transactions_cursor: cursor,
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({
      ok: true,
      imported_count: importedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      next_cursor: cursor,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/cron/full-auto", async (req, res) => {
  try {
    requireCronSecret(req);
    const data = await runCronFullAutoSweep();
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/cron/full-auto", async (req, res) => {
  try {
    requireCronSecret(req);
    const data = await runCronFullAutoSweep();
    res.json(data);
  } catch (error) {
    sendError(res, error);
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`DebtYa API running on port ${PORT}`);
});