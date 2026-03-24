require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

function supabaseHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
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
  });
}

async function getUserFromToken(req) {
  const token = getAuthToken(req);

  if (!token) {
    const error = new Error("Falta Authorization Bearer token");
    error.status = 401;
    throw error;
  }

  const response = await axios.get(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
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

  const response = await axios.get(
    `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
      }),
    }
  );

  return response.data || [];
}

async function supabaseInsert(table, payload, req) {
  await getUserFromToken(req);

  const response = await axios.post(
    `${process.env.SUPABASE_URL}/rest/v1/${table}`,
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
    `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`,
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
    `${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`,
    {
      headers: supabaseHeaders({
        Authorization: `Bearer ${getAuthToken(req)}`,
        Prefer: "return=representation",
      }),
    }
  );

  return response.data || [];
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

function compareStrategies(avalanche, snowball) {
  const interestSavedWithAvalanche = moneyNumber(
    (snowball?.total_interest_paid || 0) - (avalanche?.total_interest_paid || 0)
  );

  const monthsSavedWithAvalanche =
    Number(snowball?.estimated_months_to_payoff || 0) -
    Number(avalanche?.estimated_months_to_payoff || 0);

  let recommended = "empate";
  let reason = "Ambas estrategias dieron el mismo resultado.";

  if ((avalanche?.estimated_months_to_payoff ?? 0) < (snowball?.estimated_months_to_payoff ?? 0)) {
    recommended = "avalanche";
    reason = "Avalanche termina en menos meses.";
  } else if ((snowball?.estimated_months_to_payoff ?? 0) < (avalanche?.estimated_months_to_payoff ?? 0)) {
    recommended = "snowball";
    reason = "Snowball termina en menos meses.";
  } else if ((avalanche?.total_interest_paid ?? 0) < (snowball?.total_interest_paid ?? 0)) {
    recommended = "avalanche";
    reason = "Empatan en meses, pero Avalanche paga menos intereses.";
  } else if ((snowball?.total_interest_paid ?? 0) < (avalanche?.total_interest_paid ?? 0)) {
    recommended = "snowball";
    reason = "Empatan en meses, pero Snowball paga menos intereses.";
  }

  return {
    recommended_strategy: recommended,
    reason,
    interest_saved_with_avalanche: interestSavedWithAvalanche,
    months_saved_with_avalanche: monthsSavedWithAvalanche,
  };
}

function calculateAllocationAmount(rule, transactionAmount) {
  const ruleType = rule.rule_type;
  const ruleValue = Number(rule.rule_value || 0);
  let calculated = 0;

  if (ruleType === "percentage") {
    calculated = Number(transactionAmount || 0) * (ruleValue / 100);
  } else if (ruleType === "fixed_amount") {
    calculated = ruleValue;
  } else if (ruleType === "round_up") {
    const absolute = Math.abs(Number(transactionAmount || 0));
    calculated = Math.ceil(absolute) - absolute;
  }

  if (rule.max_per_transaction !== null && rule.max_per_transaction !== undefined) {
    calculated = Math.min(calculated, Number(rule.max_per_transaction || 0));
  }

  if (calculated < 0) calculated = 0;

  return moneyNumber(calculated);
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

async function getRulesForUser(req, userId, onlyActive = true) {
  const query = onlyActive
    ? `select=*&user_id=eq.${userId}&active=eq.true&order=created_at.desc`
    : `select=*&user_id=eq.${userId}&order=created_at.desc`;

  const data = await supabaseSelect("automation_rules", query, req);
  return data || [];
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
    category: Array.isArray(tx.personal_finance_category?.detailed)
      ? tx.personal_finance_category?.detailed?.join(" / ")
      : tx.personal_finance_category?.detailed ||
        (Array.isArray(tx.category) ? tx.category[0] : tx.category || null),
    subcategory: tx.personal_finance_category?.primary || (Array.isArray(tx.category) ? tx.category[1] || null : null),
    amount: moneyNumber(tx.amount || 0),
    iso_currency_code: tx.iso_currency_code || "USD",
    direction: Number(tx.amount || 0) >= 0 ? "debit" : "credit",
    raw_payload: tx,
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
  const rules = await getRulesForUser(req, userId, true);
  const transactions = await getTransactionsForUser(req, userId);
  const createdAllocations = [];

  for (const rule of rules) {
    for (const tx of transactions) {
      if (rule.source_account_id && tx.account_id !== rule.source_account_id) continue;
      if (tx.direction !== "debit" && rule.apply_to_transaction_type === "debit_only") continue;
      if (Number(tx.amount || 0) < Number(rule.min_transaction_amount || 0)) continue;

      const calculated = calculateAllocationAmount(rule, tx.amount);
      if (calculated <= 0) continue;

      const existing = await supabaseSelect(
        "transaction_allocations",
        `select=*&transaction_id=eq.${tx.id}&rule_id=eq.${rule.id}&user_id=eq.${userId}`,
        req
      );

      if ((existing || []).length > 0) continue;

      const status =
        rule.execution_mode === "full_auto" && rule.require_user_confirmation === false
          ? "queued"
          : "pending";

      const inserted = await supabaseInsert(
        "transaction_allocations",
        {
          user_id: userId,
          transaction_id: tx.id,
          rule_id: rule.id,
          debt_id: rule.target_debt_id,
          source_account_id: rule.source_account_id,
          allocation_type: rule.rule_type,
          base_transaction_amount: moneyNumber(tx.amount),
          calculated_amount: calculated,
          capped_amount: calculated,
          status,
          status_reason:
            status === "queued"
              ? "Asignación creada y lista para ejecución automática."
              : "Asignación creada pendiente de revisión.",
          updated_at: toIsoNow(),
        },
        req
      );

      if (inserted[0]) createdAllocations.push(inserted[0]);
    }
  }

  return createdAllocations;
}

async function buildPaymentIntentsInternal(req, userId, executionMode = "safe", debtId = null) {
  let query = `select=*&user_id=eq.${userId}&status=in.(pending,queued)&order=created_at.asc`;
  if (debtId) {
    query = `select=*&user_id=eq.${userId}&status=in.(pending,queued)&debt_id=eq.${debtId}&order=created_at.asc`;
  }

  const allocations = await supabaseSelect("transaction_allocations", query, req);
  if (!allocations.length) return [];

  const grouped = allocations.reduce((acc, item) => {
    const key = `${item.debt_id}__${item.source_account_id || "no_account"}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const createdIntents = [];

  for (const key of Object.keys(grouped)) {
    const items = grouped[key];
    const first = items[0];
    const totalAmount = moneyNumber(items.reduce((sum, item) => sum + Number(item.capped_amount || 0), 0));
    const approvalRequired = executionMode === "safe";

    const insertedIntent = await supabaseInsert(
      "payment_intents",
      {
        user_id: userId,
        debt_id: first.debt_id,
        source_account_id: first.source_account_id,
        execution_mode: executionMode,
        execution_frequency: "daily",
        scheduled_for: toIsoNow(),
        total_amount: totalAmount,
        status: approvalRequired ? "pending_review" : "queued",
        approval_required: approvalRequired,
        metadata: {
          grouped_from_allocations: items.map((x) => x.id),
        },
        updated_at: toIsoNow(),
      },
      req
    );

    const intent = insertedIntent[0];
    if (!intent) continue;

    for (const item of items) {
      await supabaseInsert(
        "payment_intent_allocations",
        {
          payment_intent_id: intent.id,
          allocation_id: item.id,
          amount: moneyNumber(item.capped_amount || 0),
        },
        req
      );

      await supabasePatch(
        "transaction_allocations",
        `id=eq.${item.id}&user_id=eq.${userId}`,
        {
          status: "converted_to_payment",
          status_reason: "Asignación agregada a payment_intent.",
          updated_at: toIsoNow(),
        },
        req
      );
    }

    createdIntents.push(intent);
  }

  return createdIntents;
}

async function executePaymentIntentInternal(req, userId, intentId) {
  const intents = await supabaseSelect(
    "payment_intents",
    `select=*&id=eq.${intentId}&user_id=eq.${userId}`,
    req
  );

  const intent = intents[0];
  if (!intent) {
    const error = new Error("Payment intent no encontrado");
    error.status = 404;
    throw error;
  }

  const debts = await supabaseSelect(
    "debts",
    `select=*&id=eq.${intent.debt_id}&user_id=eq.${userId}`,
    req
  );

  const debt = debts[0];
  if (!debt) {
    const error = new Error("Deuda no encontrada");
    error.status = 404;
    throw error;
  }

  const currentBalance = moneyNumber(debt.balance || 0);
  const executionAmount = moneyNumber(intent.total_amount || 0);
  const appliedAmount = moneyNumber(Math.min(executionAmount, currentBalance));
  const newBalance = moneyNumber(Math.max(currentBalance - appliedAmount, 0));
  const shouldDeactivate = newBalance <= 0;

  const insertedExecution = await supabaseInsert(
    "payment_executions",
    {
      payment_intent_id: intent.id,
      user_id: userId,
      debt_id: intent.debt_id,
      source_account_id: intent.source_account_id,
      provider: "manual",
      execution_amount: appliedAmount,
      status: "submitted",
      submitted_at: toIsoNow(),
      raw_response: {
        note: "Ejecución simulada manual para DebtYa Fase 3.",
        previous_balance: currentBalance,
        new_balance: newBalance,
      },
      updated_at: toIsoNow(),
    },
    req
  );

  await supabasePatch(
    "payment_intents",
    `id=eq.${intent.id}&user_id=eq.${userId}`,
    {
      status: "executed",
      executed_at: toIsoNow(),
      updated_at: toIsoNow(),
    },
    req
  );

  const updatedDebt = await supabasePatch(
    "debts",
    `id=eq.${intent.debt_id}&user_id=eq.${userId}`,
    {
      balance: newBalance,
      is_active: shouldDeactivate ? false : debt.is_active !== false,
      updated_at: toIsoNow(),
    },
    req
  );

  return {
    execution: insertedExecution[0] || null,
    updated_debt: updatedDebt[0] || null,
    message: shouldDeactivate
      ? "Payment intent ejecutado y deuda pagada por completo."
      : "Payment intent ejecutado y balance de la deuda actualizado.",
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

app.post("/automation/full-auto/run", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const createdAllocations = await runRulesInternal(req, user.id);
    const createdIntents = await buildPaymentIntentsInternal(req, user.id, "full_auto", null);

    const autoExecuted = [];
    for (const intent of createdIntents) {
      if (String(intent.execution_mode || "").toLowerCase() === "full_auto") {
        const executed = await executePaymentIntentInternal(req, user.id, intent.id);
        autoExecuted.push({
          intent_id: intent.id,
          ...executed,
        });
      }
    }

    res.json({
      ok: true,
      message: "Ciclo full auto ejecutado.",
      created_allocations_count: createdAllocations.length,
      created_intents_count: createdIntents.length,
      auto_executed_count: autoExecuted.length,
      data: {
        created_allocations: createdAllocations,
        created_intents: createdIntents,
        auto_executed: autoExecuted,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const user = await getUserFromToken(req);

    const response = await axios.post(
      "https://sandbox.plaid.com/link/token/create",
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        client_name: "DebtYa",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["auth", "transactions"],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
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

    const response = await axios.post(
      "https://sandbox.plaid.com/link/token/create",
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        client_name: "DebtYa",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["auth", "transactions"],
      },
      {
        headers: { "Content-Type": "application/json" },
      }
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

    const plaidResponse = await axios.post(
      "https://sandbox.plaid.com/item/public_token/exchange",
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        public_token,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const item_id = plaidResponse.data.item_id;
    const access_token = plaidResponse.data.access_token;

    const saved = await supabaseInsert(
      "plaid_items",
      {
        user_id: user.id,
        plaid_item_id: item_id,
        plaid_access_token: access_token,
        institution_name: institution_name || "Plaid Sandbox",
      },
      req
    );

    res.json({
      ok: true,
      message: "public_token cambiado y guardado en Supabase",
      plaid: plaidResponse.data,
      saved,
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
      `select=id,user_id,plaid_item_id,institution_name,created_at&user_id=eq.${user.id}&order=created_at.desc`,
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
    const lastItem = await getLatestPlaidItemForUser(req, user.id);

    if (!lastItem) {
      return res.status(404).json({
        ok: false,
        error: "No hay plaid_items guardados para este usuario",
      });
    }

    const accessToken = lastItem.plaid_access_token;

    const plaidAccountsResponse = await axios.post(
      "https://sandbox.plaid.com/accounts/get",
      {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const accounts = plaidAccountsResponse.data.accounts || [];
    const savedAccounts = [];

    for (const account of accounts) {
      const existing = await supabaseSelect(
        "accounts",
        `select=*&user_id=eq.${user.id}&account_id=eq.${encodeURIComponent(account.account_id)}&plaid_item_id=eq.${encodeURIComponent(lastItem.plaid_item_id)}`,
        req
      );

      const payload = {
        user_id: user.id,
        plaid_item_id: lastItem.plaid_item_id,
        account_id: account.account_id,
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        balance_current: account.balances?.current,
        balance_available: account.balances?.available,
        mask: account.mask,
      };

      if (existing.length > 0) {
        const updated = await supabasePatch(
          "accounts",
          `id=eq.${existing[0].id}&user_id=eq.${user.id}`,
          payload,
          req
        );
        savedAccounts.push(updated[0]);
      } else {
        const inserted = await supabaseInsert("accounts", payload, req);
        savedAccounts.push(inserted[0]);
      }
    }

    res.json({
      ok: true,
      imported_count: accounts.length,
      saved_accounts: savedAccounts,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/plaid/transactions/import-last", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const lastItem = await getLatestPlaidItemForUser(req, user.id);

    if (!lastItem) {
      return res.status(404).json({
        ok: false,
        error: "No hay plaid_items guardados para este usuario",
      });
    }

    const accessToken = lastItem.plaid_access_token;
    let hasMore = true;
    let cursor = null;
    let added = [];
    let modified = [];
    let removed = [];

    while (hasMore) {
      const plaidResponse = await axios.post(
        "https://sandbox.plaid.com/transactions/sync",
        {
          client_id: process.env.PLAID_CLIENT_ID,
          secret: process.env.PLAID_SECRET,
          access_token: accessToken,
          cursor,
          count: 100,
        },
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      const data = plaidResponse.data;
      added = added.concat(data.added || []);
      modified = modified.concat(data.modified || []);
      removed = removed.concat(data.removed || []);
      hasMore = data.has_more;
      cursor = data.next_cursor;
    }

    const saved = [];

    for (const tx of added) {
      const payload = normalizePlaidTransaction(tx, user.id, lastItem);
      const row = await upsertTransactionByExternalId(req, payload);
      if (row) saved.push(row);
    }

    for (const tx of modified) {
      const payload = normalizePlaidTransaction(tx, user.id, lastItem);
      const row = await upsertTransactionByExternalId(req, payload);
      if (row) saved.push(row);
    }

    for (const tx of removed) {
      const existing = await supabaseSelect(
        "transactions_raw",
        `select=*&user_id=eq.${user.id}&external_transaction_id=eq.${encodeURIComponent(tx.transaction_id)}`,
        req
      );

      if (existing.length > 0) {
        await supabaseDelete(
          "transactions_raw",
          `id=eq.${existing[0].id}&user_id=eq.${user.id}`,
          req
        );
      }
    }

    res.json({
      ok: true,
      imported_added_count: added.length,
      imported_modified_count: modified.length,
      imported_removed_count: removed.length,
      saved_count: saved.length,
      next_cursor: cursor,
      message: "Transacciones reales importadas desde Plaid a transactions_raw.",
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/debts", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const onlyActive = req.query.active === "true";

    const query = onlyActive
      ? `select=*&user_id=eq.${user.id}&is_active=eq.true&order=created_at.desc`
      : `select=*&user_id=eq.${user.id}&order=created_at.desc`;

    const data = await supabaseSelect("debts", query, req);
    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/debts", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { name, balance, apr, minimum_payment, due_day, type } = req.body;

    const data = await supabaseInsert(
      "debts",
      {
        user_id: user.id,
        name,
        balance,
        apr,
        minimum_payment,
        due_day,
        type,
        is_active: true,
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/debts/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    const { name, balance, apr, minimum_payment, due_day, type, is_active } = req.body;

    const payload = { updated_at: toIsoNow() };
    if (name !== undefined) payload.name = name;
    if (balance !== undefined) payload.balance = balance;
    if (apr !== undefined) payload.apr = apr;
    if (minimum_payment !== undefined) payload.minimum_payment = minimum_payment;
    if (due_day !== undefined) payload.due_day = due_day;
    if (type !== undefined) payload.type = type;
    if (is_active !== undefined) payload.is_active = is_active;

    const data = await supabasePatch(
      "debts",
      `id=eq.${id}&user_id=eq.${user.id}`,
      payload,
      req
    );

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/debts/:id/deactivate", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const data = await supabasePatch(
      "debts",
      `id=eq.${id}&user_id=eq.${user.id}`,
      { is_active: false, updated_at: toIsoNow() },
      req
    );

    res.json({ ok: true, message: "Deuda desactivada", data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/debts/:id/activate", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    const data = await supabasePatch(
      "debts",
      `id=eq.${id}&user_id=eq.${user.id}`,
      { is_active: true, updated_at: toIsoNow() },
      req
    );

    res.json({ ok: true, message: "Deuda reactivada", data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/debts/:id/apply-payment", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    const amount = moneyNumber(req.body.amount || 0);

    if (amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "El monto debe ser mayor que cero",
      });
    }

    const debts = await supabaseSelect(
      "debts",
      `select=*&id=eq.${id}&user_id=eq.${user.id}`,
      req
    );

    const debt = debts[0];
    if (!debt) {
      return res.status(404).json({ ok: false, error: "Deuda no encontrada" });
    }

    const currentBalance = moneyNumber(debt.balance || 0);
    const appliedAmount = moneyNumber(Math.min(amount, currentBalance));
    const newBalance = moneyNumber(Math.max(currentBalance - appliedAmount, 0));
    const shouldDeactivate = newBalance <= 0;

    const updatedDebt = await supabasePatch(
      "debts",
      `id=eq.${id}&user_id=eq.${user.id}`,
      {
        balance: newBalance,
        is_active: shouldDeactivate ? false : debt.is_active !== false,
        updated_at: toIsoNow(),
      },
      req
    );

    const execution = await supabaseInsert(
      "payment_executions",
      {
        payment_intent_id: null,
        user_id: user.id,
        debt_id: id,
        source_account_id: null,
        provider: "manual_adjustment",
        execution_amount: appliedAmount,
        status: "submitted",
        submitted_at: toIsoNow(),
        raw_response: {
          note: "Ajuste manual de balance desde fase 3.",
          previous_balance: currentBalance,
          new_balance: newBalance,
        },
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({
      ok: true,
      message: shouldDeactivate
        ? "Pago manual aplicado y deuda pagada por completo."
        : "Pago manual aplicado y balance actualizado.",
      applied_amount: appliedAmount,
      updated_debt: updatedDebt[0] || null,
      execution: execution[0] || null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/debts/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    await supabaseDelete("debts", `id=eq.${id}&user_id=eq.${user.id}`, req);
    res.json({ ok: true, message: "Deuda eliminada" });
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

app.get("/preferences", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const data = await supabaseSelect(
      "profiles",
      `select=*&id=eq.${user.id}`,
      req
    );

    res.json({ ok: true, data: data[0] || null });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/preferences", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const {
      preferred_strategy = "avalanche",
      default_extra_payment = 200,
      default_monthly_budget = 430,
      full_name = null,
    } = req.body;

    const data = await supabasePatch(
      "profiles",
      `id=eq.${user.id}`,
      {
        email: user.email,
        full_name,
        preferred_strategy,
        default_extra_payment,
        default_monthly_budget,
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation/settings", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const {
      auto_mode = "safe",
      reminder_days = "none",
      purchase_sweep_percent = 0,
      purchase_sweep_fixed = 0,
    } = req.body;

    const data = await supabasePatch(
      "profiles",
      `id=eq.${user.id}`,
      {
        updated_at: toIsoNow(),
        auto_mode,
        reminder_days,
        purchase_sweep_percent,
        purchase_sweep_fixed,
      },
      req
    );

    res.json({
      ok: true,
      message: "Configuración de automatización guardada.",
      data,
    });
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
    const {
      strategy = "avalanche",
      extra_payment = 0,
      monthly_budget = 0,
    } = req.body;

    const debts = await getActiveDebtsForUser(req, user.id);
    const result = simulateStrategy(debts, strategy, extra_payment);

    const data = await supabaseInsert(
      "payment_plans",
      {
        user_id: user.id,
        strategy,
        monthly_budget,
        payload_json: result,
      },
      req
    );

    res.json({
      ok: true,
      saved: data,
      plan: result,
      data: result,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/strategy/compare", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { extra_payment = 0 } = req.body;
    const debts = await getActiveDebtsForUser(req, user.id);

    const avalanche = simulateStrategy(debts, "avalanche", extra_payment);
    const snowball = simulateStrategy(debts, "snowball", extra_payment);
    const comparison = compareStrategies(avalanche, snowball);

    res.json({
      ok: true,
      data: {
        strategy: comparison.recommended_strategy,
        extra_payment: moneyNumber(extra_payment),
        avalanche,
        snowball,
        recommended_strategy: comparison.recommended_strategy,
        reason: comparison.reason,
        comparison,
      },
      avalanche,
      snowball,
      comparison,
      recommended_strategy: comparison.recommended_strategy,
      reason: comparison.reason,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/strategy/:strategy", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { strategy } = req.params;
    const { extra_payment = 0 } = req.body;

    const debts = await getActiveDebtsForUser(req, user.id);
    const result = simulateStrategy(debts, strategy, extra_payment);

    res.json({
      ok: true,
      data: result,
      ...result,
    });
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

app.post("/automation-rules", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const {
      source_account_id = null,
      target_debt_id,
      rule_name,
      rule_type,
      rule_value = 0,
      execution_mode = "safe",
      execution_frequency = "daily",
      apply_to_transaction_type = "debit_only",
      min_transaction_amount = 0,
      max_per_transaction = null,
      max_per_day = null,
      max_per_month = null,
      require_user_confirmation = true,
      allow_partial_execution = true,
      active = true,
      starts_at = null,
      ends_at = null,
    } = req.body;

    const data = await supabaseInsert(
      "automation_rules",
      {
        user_id: user.id,
        source_account_id,
        target_debt_id,
        rule_name,
        rule_type,
        rule_value,
        execution_mode,
        execution_frequency,
        apply_to_transaction_type,
        min_transaction_amount,
        max_per_transaction,
        max_per_day,
        max_per_month,
        require_user_confirmation,
        allow_partial_execution,
        active,
        starts_at,
        ends_at,
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/automation-rules/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;
    const payload = {
      ...req.body,
      updated_at: toIsoNow(),
    };

    const data = await supabasePatch(
      "automation_rules",
      `id=eq.${id}&user_id=eq.${user.id}`,
      payload,
      req
    );

    res.json({ ok: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete("/automation-rules/:id", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const { id } = req.params;

    await supabaseDelete(
      "automation_rules",
      `id=eq.${id}&user_id=eq.${user.id}`,
      req
    );

    res.json({ ok: true, message: "Regla eliminada" });
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

app.post("/transactions-raw", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const transactions = Array.isArray(req.body.transactions) ? req.body.transactions : [req.body];

    const payload = transactions.map((tx) => ({
      user_id: user.id,
      plaid_item_id: tx.plaid_item_id || null,
      account_id: tx.account_id || null,
      external_transaction_id: tx.external_transaction_id,
      transaction_date: tx.transaction_date || null,
      authorized_date: tx.authorized_date || null,
      merchant_name: tx.merchant_name || null,
      description: tx.description || null,
      category: tx.category || null,
      subcategory: tx.subcategory || null,
      amount: moneyNumber(tx.amount || 0),
      iso_currency_code: tx.iso_currency_code || "USD",
      direction: tx.direction || "debit",
      raw_payload: tx.raw_payload || {},
    }));

    const data = await supabaseInsert("transactions_raw", payload, req);

    res.json({
      ok: true,
      inserted_count: data.length,
      data,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/automation-rules/run", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const createdAllocations = await runRulesInternal(req, user.id);

    res.json({
      ok: true,
      created_count: createdAllocations.length,
      data: createdAllocations,
    });
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

app.post("/payment-intents/build", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const {
      execution_mode = "safe",
      debt_id = null,
    } = req.body;

    const createdIntents = await buildPaymentIntentsInternal(req, user.id, execution_mode, debt_id);

    if (!createdIntents.length) {
      return res.json({
        ok: true,
        message: "No hay asignaciones pendientes para convertir.",
        data: [],
      });
    }

    res.json({
      ok: true,
      created_count: createdIntents.length,
      data: createdIntents,
      message: `Payment intents creados: ${createdIntents.length}`,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/payment-intents/build-single", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    const {
      execution_mode = "safe",
      debt_id = null,
    } = req.body;

    if (!debt_id) {
      return res.status(400).json({
        ok: false,
        error: "Falta debt_id",
      });
    }

    const createdIntents = await buildPaymentIntentsInternal(req, user.id, execution_mode, debt_id);

    if (!createdIntents.length) {
      return res.json({
        ok: true,
        message: "No hay asignaciones pendientes para esa deuda.",
        data: [],
      });
    }

    res.json({
      ok: true,
      created_count: createdIntents.length,
      data: createdIntents,
      message: `Payment intents individuales creados: ${createdIntents.length}`,
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

    const data = await supabasePatch(
      "payment_intents",
      `id=eq.${id}&user_id=eq.${user.id}`,
      {
        status: "queued",
        approved_at: toIsoNow(),
        updated_at: toIsoNow(),
      },
      req
    );

    res.json({ ok: true, data });
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
      ...result,
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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});