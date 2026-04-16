require("dotenv").config();

const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { registerAllRoutes } = require("./routes");
const { attachStripeWebhook } = require("./routes/stripe-webhook-routes");

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_VERSION = "cron-safe-v20-backend-cleanup-safe";

const DEBUG_STRIPE = false;
const DEBUG_APP = false;

function stripeDebug(...args) {
  if (DEBUG_STRIPE) {
    console.log(...args);
  }
}

function appDebug(...args) {
  if (DEBUG_APP) {
    console.log(...args);
  }
}

function stripeInfo(...args) {
  console.log(...args);
}

function stripeError(...args) {
  console.error(...args);
}

function appError(...args) {
  console.error(...args);
}

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV = "sandbox",
  PLAID_PRODUCTS = "auth,transactions",
  PLAID_COUNTRY_CODES = "US",
  PLAID_REDIRECT_URI,
  PLAID_ANDROID_PACKAGE_NAME,
  CRON_SECRET,
  APP_BASE_URL,
  FRONTEND_URL,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_ID_BETA_MONTHLY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PORTAL_CONFIG_ID
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const DEFAULT_CORS_ORIGINS = [
  "https://www.debtya.com",
  "https://debtya.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

function getAllowedCorsOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_CORS_ORIGINS;
}

const allowedCorsOrigins = getAllowedCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedCorsOrigins.includes(origin)) {
        return callback(null, true);
      }
      appError("[cors] origen no permitido:", origin);
      return callback(null, false);
    }
  })
);

attachStripeWebhook(app, express, () => ({
  stripe,
  STRIPE_WEBHOOK_SECRET,
  stripeDebug,
  stripeError,
  stripeInfo,
  jsonError,
  resolveStripeUserId,
  upsertBillingSubscriptionFromStripe
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const incoming = req.headers["x-request-id"];
  req.requestId =
    typeof incoming === "string" && incoming.trim()
      ? incoming.trim().slice(0, 128)
      : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      const normalized = String(filePath || "").replace(/\\/g, "/");
      if (normalized.endsWith("/index.html") || normalized.endsWith("/legal.html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    }
  })
);

const supabaseAnon =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const plaidConfig =
  PLAID_CLIENT_ID && PLAID_SECRET
    ? new Configuration({
        basePath: PlaidEnvironments[PLAID_ENV] || PlaidEnvironments.sandbox,
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
            "PLAID-SECRET": PLAID_SECRET
          }
        }
      })
    : null;

const plaidClient = plaidConfig ? new PlaidApi(plaidConfig) : null;

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeNullableNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeBoolean(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function safeDateMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function traceSortValue(row) {
  return Math.max(
    safeDateMs(row?.created_at),
    safeDateMs(row?.executed_at),
    safeDateMs(row?.approved_at),
    safeDateMs(row?.updated_at),
    safeDateMs(row?.inserted_at),
    safeDateMs(row?.event_at),
    safeDateMs(row?.payment_created_at)
  );
}

function sortTraceRows(rows = []) {
  return [...rows].sort((a, b) => traceSortValue(b) - traceSortValue(a));
}

function jsonError(res, status, message, extra = {}) {
  const requestId = res.req?.requestId;
  return res.status(status).json({
    ok: false,
    error: message,
    ...(requestId ? { request_id: requestId } : {}),
    ...extra
  });
}

async function assertLinkedPlaidAccountForUser(userId, plaidAccountId) {
  const id = String(plaidAccountId || "").trim();
  if (!id) return;
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("plaid_account_id")
    .eq("user_id", userId)
    .eq("plaid_account_id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error("Invalid linked Plaid account for this user.");
  }
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function getBaseUrl(req) {
  return APP_BASE_URL || FRONTEND_URL || `${req.protocol}://${req.get("host")}`;
}

function getIntentAmount(intent) {
  return safeNumber(
    intent?.total_amount ??
      intent?.amount ??
      intent?.executed_amount ??
      intent?.suggested_amount ??
      intent?.payment_amount ??
      0
  );
}

function getIntentMetadata(intent) {
  if (!intent?.metadata || typeof intent.metadata !== "object") return {};
  return intent.metadata;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function normalizeStripeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (
    [
      "active",
      "trialing",
      "past_due",
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused"
    ].includes(s)
  ) {
    return s;
  }
  return "inactive";
}

function isSubscriptionActive(status) {
  return ["active", "trialing"].includes(String(status || "").toLowerCase());
}

async function callRpc(name, params = {}) {
  const { data, error } = await supabaseAdmin.rpc(name, params);
  if (error) throw error;
  return data;
}

async function getUserFromRequest(req) {
  if (!supabaseAdmin) {
    throw new Error("Supabase no configurado");
  }

  const token = getBearerToken(req);
  if (!token) {
    const err = new Error("Falta Authorization Bearer token");
    err.status = 401;
    throw err;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    const err = new Error("Token inválido o sesión expirada");
    err.status = 401;
    throw err;
  }

  return data.user;
}

async function requireUser(req, res, next) {
  try {
    req.user = await getUserFromRequest(req);
    next();
  } catch (error) {
    return jsonError(res, error.status || 401, error.message);
  }
}

function requireCronSecret(req, res, next) {
  const provided = req.headers["x-cron-secret"];
  if (!CRON_SECRET) {
    return jsonError(res, 500, "CRON_SECRET no configurado");
  }
  if (!provided || provided !== CRON_SECRET) {
    return jsonError(res, 401, "Unauthorized");
  }
  next();
}

async function ensureProfile(userId) {
  if (!supabaseAdmin || !userId) return;
  try {
    await supabaseAdmin
      .from("profiles")
      .upsert(
        {
          id: userId,
          updated_at: new Date().toISOString()
        },
        { onConflict: "id" }
      );
  } catch (e) {
    appDebug("No se pudo asegurar profile:", e.message);
  }
}

async function getLatestBillingSubscriptionForUser(userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    return data?.[0] || null;
  } catch (e) {
    appDebug("No se pudo leer billing_subscriptions:", e.message);
    return null;
  }
}

async function getStripeCustomerById(customerId) {
  try {
    if (!stripe || !customerId) return null;
    return await stripe.customers.retrieve(customerId);
  } catch (e) {
    appDebug("No se pudo leer customer de Stripe:", e.message);
    return null;
  }
}

async function resolveStripeUserId({
  session = null,
  subscription = null,
  customerId = null,
  fallbackUserId = null
} = {}) {
  const fromSession =
    session?.client_reference_id ||
    session?.metadata?.supabase_user_id ||
    null;

  if (fromSession) return fromSession;

  const fromSubscription =
    subscription?.metadata?.supabase_user_id ||
    fallbackUserId ||
    null;

  if (fromSubscription) return fromSubscription;

  const customer = await getStripeCustomerById(customerId);
  const fromCustomer = customer?.metadata?.supabase_user_id || null;

  return fromCustomer || null;
}

async function upsertBillingSubscriptionRow(payload) {
  try {
    const { data, error } = await supabaseAdmin
      .from("billing_subscriptions")
      .upsert(payload, { onConflict: "stripe_subscription_id" })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (e) {
    stripeError("No se pudo guardar billing_subscriptions:", {
      message: e.message,
      details: e.details || null,
      hint: e.hint || null,
      code: e.code || null,
      stripe_subscription_id: payload?.stripe_subscription_id || null,
      user_id: payload?.user_id || null
    });
    return null;
  }
}

async function getOrCreateStripeCustomerForUser(user) {
  if (!stripe) {
    throw new Error("Stripe no configurado");
  }

  const existing = await getLatestBillingSubscriptionForUser(user.id);
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    metadata: {
      supabase_user_id: user.id
    }
  });

  stripeDebug("[STRIPE_CHECKOUT] customer creado", {
    userId: user.id,
    email: user.email || null,
    customerId: customer.id
  });

  return customer.id;
}

async function upsertBillingSubscriptionFromStripe(subscription, fallbackUserId = null, extra = {}) {
  const customerId =
    typeof subscription?.customer === "string"
      ? subscription.customer
      : subscription?.customer?.id || null;

  const userId = await resolveStripeUserId({
    subscription,
    customerId,
    fallbackUserId
  });

  const item = subscription?.items?.data?.[0] || null;
  const priceId = item?.price?.id || null;

  const rawCurrentPeriodEnd =
    subscription?.current_period_end ??
    item?.current_period_end ??
    subscription?.cancel_at ??
    null;

  let currentPeriodEndIso = null;
  if (rawCurrentPeriodEnd) {
    currentPeriodEndIso = new Date(rawCurrentPeriodEnd * 1000).toISOString();
  }

  const inferredCancelAtPeriodEnd =
    subscription?.cancel_at_period_end === true ||
    (!!subscription?.cancel_at &&
      String(subscription?.status || "").toLowerCase() === "active");

  const payload = {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription?.id || null,
    stripe_price_id: priceId,
    status: normalizeStripeStatus(subscription?.status),
    active: isSubscriptionActive(subscription?.status),
    current_period_end: currentPeriodEndIso,
    cancel_at_period_end: inferredCancelAtPeriodEnd,
    last_event_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_json: subscription,
    ...extra
  };

  stripeDebug("[BILLING_UPSERT] payload", {
    user_id: payload.user_id,
    stripe_customer_id: payload.stripe_customer_id,
    stripe_subscription_id: payload.stripe_subscription_id,
    stripe_price_id: payload.stripe_price_id,
    status: payload.status,
    active: payload.active,
    current_period_end: payload.current_period_end,
    cancel_at_period_end: payload.cancel_at_period_end,
    last_invoice_id: payload.last_invoice_id || null,
    last_invoice_status: payload.last_invoice_status || null,
    source_subscription_current_period_end: subscription?.current_period_end ?? null,
    source_item_current_period_end: item?.current_period_end ?? null,
    source_cancel_at: subscription?.cancel_at ?? null
  });

  if (!payload.stripe_subscription_id) {
    throw new Error("stripe_subscription_id faltante al intentar guardar billing_subscriptions");
  }

  const saved = await upsertBillingSubscriptionRow(payload);

  stripeInfo("[stripe] billing_subscriptions actualizado", {
    ok: !!saved,
    stripe_subscription_id: saved?.stripe_subscription_id || null
  });

  return saved;
}

async function getPlaidItemsForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from("plaid_items")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getLatestPlaidItemForUser(userId) {
  const items = await getPlaidItemsForUser(userId);
  return items[0] || null;
}

async function upsertPlaidItem({
  userId,
  itemId,
  accessToken,
  institutionId = null,
  institutionName = null
}) {
  const payload = {
    user_id: userId,
    plaid_item_id: itemId,
    access_token: accessToken,
    institution_id: institutionId,
    institution_name: institutionName,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabaseAdmin
    .from("plaid_items")
    .upsert(payload, { onConflict: "plaid_item_id" })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getInstitutionName(institutionId) {
  if (!plaidClient || !institutionId) return null;
  try {
    const response = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: PLAID_COUNTRY_CODES.split(",").map((x) => x.trim())
    });
    return response?.data?.institution?.name || null;
  } catch (e) {
    appDebug("No se pudo obtener institución:", e.message);
    return null;
  }
}

const institutionLogoCache = new Map();

function stripPlaidItemSecretsForClient(row) {
  if (!row || typeof row !== "object") return row;
  const { access_token: _accessToken, ...safe } = row;
  return safe;
}

async function fetchInstitutionLogoDataUrl(institutionId) {
  if (!plaidClient || !institutionId) return null;
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (institutionLogoCache.has(institutionId)) {
    const hit = institutionLogoCache.get(institutionId);
    if (now - hit.ts < ttlMs) return hit.dataUrl;
  }
  try {
    const response = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: PLAID_COUNTRY_CODES.split(",").map((x) => x.trim()),
      options: { include_display_data: true }
    });
    const logo = response?.data?.institution?.logo;
    const dataUrl =
      logo && typeof logo === "string" && logo.length > 2
        ? `data:image/png;base64,${logo}`
        : null;
    institutionLogoCache.set(institutionId, { dataUrl, ts: now });
    return dataUrl;
  } catch (e) {
    appDebug("No se pudo obtener logo de institución:", e.message);
    institutionLogoCache.set(institutionId, { dataUrl: null, ts: now });
    return null;
  }
}

async function insertAccountsFromPlaid(userId, accounts, item) {
  if (!accounts?.length) return [];

  const rows = accounts.map((acc) => ({
    user_id: userId,
    plaid_account_id: acc.account_id,
    plaid_item_id: item?.plaid_item_id || item?.item_id || null,
    name: acc.name || acc.official_name || "Cuenta",
    mask: acc.mask || null,
    type: acc.type || null,
    subtype: acc.subtype || null,
    current_balance: safeNumber(acc.balances?.current),
    available_balance: safeNumber(acc.balances?.available),
    limit_balance: safeNumber(acc.balances?.limit),
    currency_code: acc.balances?.iso_currency_code || "USD",
    updated_at: new Date().toISOString()
  }));

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .upsert(rows, { onConflict: "plaid_account_id" })
    .select();

  if (error) throw error;
  return data || [];
}

async function insertTransactionsRaw(userId, plaidItemId, transactions) {
  if (!transactions?.length) return { inserted: 0 };

  const rows = transactions.map((tx) => ({
    user_id: userId,
    plaid_item_id: plaidItemId,
    plaid_transaction_id: tx.transaction_id,
    plaid_account_id: tx.account_id,
    name: tx.name || tx.merchant_name || "Movimiento",
    merchant_name: tx.merchant_name || null,
    amount: safeNumber(tx.amount),
    iso_currency_code: tx.iso_currency_code || "USD",
    category: Array.isArray(tx.category) ? tx.category.join(" > ") : null,
    category_id: tx.category_id || null,
    authorized_date: tx.authorized_date || null,
    date: tx.date || null,
    pending: !!tx.pending,
    payment_channel: tx.payment_channel || null,
    raw_json: tx
  }));

  const { error } = await supabaseAdmin
    .from("transactions_raw")
    .upsert(rows, { onConflict: "plaid_transaction_id" });

  if (error) throw error;
  return { inserted: rows.length };
}

function normalizeMicroRuleModeInput(mode) {
  const m = String(mode || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (["monthly_fixed", "fixed_amount", "fixed"].includes(m)) return "fixed_amount";
  if (
    [
      "purchase_percent",
      "spend_percent",
      "percent_of_spend",
      "roundup_percent"
    ].includes(m)
  ) {
    return "roundup_percent";
  }
  if (
    [
      "spare_change",
      "roundup_change",
      "roundup_next",
      "round_up",
      "roundup_dollar"
    ].includes(m)
  ) {
    return "roundup_change";
  }
  if (["fixed_amount", "roundup_percent", "roundup_change"].includes(m)) return m;
  return "fixed_amount";
}

function buildMicroRulePayload(userId, body = {}) {
  const mode = normalizeMicroRuleModeInput(body.mode || body.rule_type);
  const config = body.config_json || body.config || {};

  let percent =
    body.percent !== undefined
      ? safeNumber(body.percent)
      : config.percent !== undefined
      ? safeNumber(config.percent)
      : mode === "roundup_percent"
      ? 10
      : 0;

  let fixedAmount =
    body.fixed_amount !== undefined
      ? safeNumber(body.fixed_amount)
      : config.fixed_amount !== undefined
      ? safeNumber(config.fixed_amount)
      : config.amount !== undefined
      ? safeNumber(config.amount)
      : 0;

  let roundupTo =
    body.roundup_to !== undefined
      ? safeNumber(body.roundup_to)
      : config.roundup_to !== undefined
      ? safeNumber(config.roundup_to)
      : 1;

  if (mode === "fixed_amount") {
    percent = body.percent !== undefined || config.percent !== undefined ? percent : 0;
  }

  if (mode === "roundup_percent") {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
  }

  if (mode === "roundup_change") {
    percent = body.percent !== undefined || config.percent !== undefined ? percent : 0;
    if (!roundupTo || roundupTo <= 0) roundupTo = 1;
  }

  const minPurchaseAmount =
    body.min_purchase_amount !== undefined
      ? safeNumber(body.min_purchase_amount)
      : config.min_purchase_amount !== undefined
      ? safeNumber(config.min_purchase_amount)
      : 0;

  const capDaily =
    body.cap_daily !== undefined
      ? safeNullableNumber(body.cap_daily)
      : config.cap_daily !== undefined
      ? safeNullableNumber(config.cap_daily)
      : null;

  const capWeekly =
    body.cap_weekly !== undefined
      ? safeNullableNumber(body.cap_weekly)
      : config.cap_weekly !== undefined
      ? safeNullableNumber(config.cap_weekly)
      : null;

  const targetDebtId =
    body.target_debt_id !== undefined
      ? body.target_debt_id || null
      : config.target_debt_id !== undefined
      ? config.target_debt_id || null
      : body.debt_id !== undefined
      ? body.debt_id || null
      : null;

  return {
    user_id: userId,
    enabled:
      body.enabled !== undefined
        ? safeBoolean(body.enabled, true)
        : body.is_active !== undefined
        ? safeBoolean(body.is_active, true)
        : true,
    mode,
    fixed_amount: fixedAmount,
    percent,
    roundup_to: roundupTo,
    min_purchase_amount: minPurchaseAmount,
    cap_daily: capDaily,
    cap_weekly: capWeekly,
    target_debt_id: isUuid(targetDebtId) ? targetDebtId : null,
    auto_run:
      body.auto_run !== undefined
        ? safeBoolean(body.auto_run, false)
        : config.auto_run !== undefined
        ? safeBoolean(config.auto_run, false)
        : false,
    payout_enabled:
      body.payout_enabled !== undefined
        ? safeBoolean(body.payout_enabled, false)
        : config.payout_enabled !== undefined
        ? safeBoolean(config.payout_enabled, false)
        : false,
    payout_min_threshold:
      body.payout_min_threshold !== undefined
        ? safeNumber(body.payout_min_threshold)
        : config.payout_min_threshold !== undefined
        ? safeNumber(config.payout_min_threshold)
        : 0,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
}

function normalizePaymentPlan(row) {
  if (!row) {
    return {
      strategy: "avalanche",
      monthly_budget: 0,
      monthly_budget_default: 0,
      extra_payment_default: 0,
      automation_mode: "manual",
      auto_mode: "manual",
      funding_plaid_account_id: null,
      payment_target_debt_id: null
    };
  }

  const payload = row.payload_json && typeof row.payload_json === "object" ? row.payload_json : {};
  const automationMode = payload.automation_mode || "manual";
  const monthlyBudgetDefault =
    row.monthly_budget_default !== undefined && row.monthly_budget_default !== null
      ? safeNumber(row.monthly_budget_default)
      : payload.monthly_budget_default !== undefined
      ? safeNumber(payload.monthly_budget_default)
      : safeNumber(row.monthly_budget);

  const extraPaymentDefault =
    row.extra_payment_default !== undefined && row.extra_payment_default !== null
      ? safeNumber(row.extra_payment_default)
      : payload.extra_payment_default !== undefined
      ? safeNumber(payload.extra_payment_default)
      : 0;

  const fundingPlaid =
    typeof payload.funding_plaid_account_id === "string" &&
    payload.funding_plaid_account_id.trim()
      ? payload.funding_plaid_account_id.trim()
      : null;
  const targetDebtId =
    payload.payment_target_debt_id && isUuid(String(payload.payment_target_debt_id).trim())
      ? String(payload.payment_target_debt_id).trim()
      : null;

  return {
    ...row,
    monthly_budget: safeNumber(row.monthly_budget),
    monthly_budget_default: monthlyBudgetDefault,
    extra_payment_default: extraPaymentDefault,
    automation_mode: automationMode,
    auto_mode: automationMode,
    funding_plaid_account_id: fundingPlaid,
    payment_target_debt_id: targetDebtId
  };
}

async function assertUserOwnsDepositoryPlaidAccount(userId, plaidAccountId) {
  const id = String(plaidAccountId || "").trim();
  if (!id) return;

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("plaid_account_id,type")
    .eq("user_id", userId)
    .eq("plaid_account_id", id)
    .maybeSingle();

  if (error) throw error;

  if (!data?.plaid_account_id) {
    const err = new Error(
      "Cuenta de origen no encontrada entre tus cuentas importadas."
    );
    err.status = 400;
    throw err;
  }

  if (String(data.type || "").toLowerCase() !== "depository") {
    const err = new Error(
      "La cuenta de origen debe ser de deposito (por ejemplo cheques o ahorros)."
    );
    err.status = 400;
    throw err;
  }
}

async function assertUserOwnsDebt(userId, debtId) {
  const id = String(debtId || "").trim();
  if (!id || !isUuid(id)) {
    const err = new Error("Deuda destino no valida.");
    err.status = 400;
    throw err;
  }

  const { data, error } = await supabaseAdmin
    .from("debts")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;

  if (!data?.id) {
    const err = new Error("Deuda destino no encontrada.");
    err.status = 400;
    throw err;
  }
}

async function stampRecentIntentsFundingFromPlan(userId) {
  const plan = await getCurrentPaymentPlan(userId);
  const funding = plan?.funding_plaid_account_id || null;
  if (!funding) return;

  const since = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: intents, error } = await supabaseAdmin
    .from("payment_intents")
    .select("id,source_account_id")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error) throw error;

  const now = new Date().toISOString();
  for (const intent of intents || []) {
    if (intent.source_account_id) continue;
    await supabaseAdmin
      .from("payment_intents")
      .update({ source_account_id: funding, updated_at: now })
      .eq("id", intent.id)
      .eq("user_id", userId);
  }
}

async function getCurrentPaymentPlan(userId) {
  const { data, error } = await supabaseAdmin
    .from("payment_plans")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return normalizePaymentPlan(data?.[0] || null);
}

async function savePaymentPlanForUser(userId, body = {}) {
  const now = new Date().toISOString();
  const automationMode = body.automation_mode || body.auto_mode || "manual";
  const monthlyBudget =
    body.monthly_budget !== undefined
      ? safeNumber(body.monthly_budget)
      : safeNumber(body.monthly_budget_default);
  const monthlyBudgetDefault =
    body.monthly_budget_default !== undefined
      ? safeNumber(body.monthly_budget_default)
      : safeNumber(body.monthly_budget);
  const extraPaymentDefault =
    body.extra_payment_default !== undefined
      ? safeNumber(body.extra_payment_default)
      : 0;

  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from("payment_plans")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (existingError) throw existingError;

  const existing = existingRows?.[0] || null;
  const existingPayload =
    existing?.payload_json && typeof existing.payload_json === "object"
      ? existing.payload_json
      : {};

  const mergedPayloadJson = {
    ...existingPayload,
    automation_mode: automationMode,
    monthly_budget_default: monthlyBudgetDefault,
    extra_payment_default: extraPaymentDefault
  };

  if (body.funding_plaid_account_id !== undefined) {
    const raw = body.funding_plaid_account_id;
    mergedPayloadJson.funding_plaid_account_id =
      raw && String(raw).trim() ? String(raw).trim() : null;
  }

  if (body.payment_target_debt_id !== undefined) {
    const raw = body.payment_target_debt_id;
    const s = raw && String(raw).trim() ? String(raw).trim() : "";
    mergedPayloadJson.payment_target_debt_id = s && isUuid(s) ? s : null;
  }

  if (mergedPayloadJson.funding_plaid_account_id) {
    await assertUserOwnsDepositoryPlaidAccount(
      userId,
      mergedPayloadJson.funding_plaid_account_id
    );
  }

  if (mergedPayloadJson.payment_target_debt_id) {
    await assertUserOwnsDebt(userId, mergedPayloadJson.payment_target_debt_id);
  }

  const payload = {
    user_id: userId,
    strategy: body.strategy || existing?.strategy || "avalanche",
    monthly_budget: monthlyBudget,
    budget: monthlyBudget,
    payload_json: mergedPayloadJson,
    updated_at: now
  };

  if (existing?.id) {
    const { data, error } = await supabaseAdmin
      .from("payment_plans")
      .update(payload)
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) throw error;
    return normalizePaymentPlan(data);
  }

  const insertPayload = {
    ...payload,
    name: "Plan principal",
    plan_type: "monthly",
    is_active: true,
    created_at: now
  };

  const { data, error } = await supabaseAdmin
    .from("payment_plans")
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;
  return normalizePaymentPlan(data);
}

async function importPlaidAccountsForUser(userId) {
  if (!plaidClient) {
    throw new Error("Plaid no configurado");
  }

  const item = await getLatestPlaidItemForUser(userId);
  if (!item?.access_token) {
    const err = new Error("No hay cuenta bancaria conectada");
    err.status = 400;
    throw err;
  }

  const response = await plaidClient.accountsGet({
    access_token: item.access_token
  });

  const saved = await insertAccountsFromPlaid(userId, response.data.accounts, item);

  return {
    item,
    response,
    saved
  };
}

async function compareStrategiesForUser(userId, monthlyBudget = 0, extraPayment = 0) {
  const { data: debts, error } = await supabaseAdmin
    .from("debts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) throw error;

  const normalizedDebts = (debts || []).map((d) => ({
    id: d.id,
    name: d.name,
    balance: safeNumber(d.balance),
    apr: safeNumber(d.apr),
    minimum_payment: safeNumber(d.minimum_payment)
  }));

  const compare = (strategyName) => {
    let items = normalizedDebts.map((d) => ({ ...d }));
    let month = 0;
    let totalInterest = 0;
    const timeline = [];

    while (items.some((d) => d.balance > 0.009) && month < 600) {
      month += 1;

      const active = items.filter((d) => d.balance > 0.009);
      const minimums = active.reduce((sum, d) => sum + d.minimum_payment, 0);
      const extra = Math.max(0, monthlyBudget + extraPayment - minimums);

      active.forEach((d) => {
        const monthlyRate = d.apr / 100 / 12;
        const interest = d.balance * monthlyRate;
        totalInterest += interest;
        d.balance += interest;
      });

      let ordered = [...active];
      if (strategyName === "avalanche") {
        ordered.sort((a, b) => b.apr - a.apr || a.balance - b.balance);
      } else {
        ordered.sort((a, b) => a.balance - b.balance || b.apr - a.apr);
      }

      ordered.forEach((d, index) => {
        let payment = d.minimum_payment;
        if (index === 0) payment += extra;
        payment = Math.min(payment, d.balance);
        d.balance = Math.max(0, d.balance - payment);
      });

      timeline.push({
        month,
        remaining_balance: Number(
          items.reduce((sum, d) => sum + d.balance, 0).toFixed(2)
        )
      });
    }

    return {
      strategy: strategyName,
      months: month,
      months_to_payoff: month,
      total_interest: Number(totalInterest.toFixed(2)),
      total_paid: Number(
        (
          normalizedDebts.reduce((sum, d) => sum + d.balance, 0) +
          totalInterest
        ).toFixed(2)
      ),
      timeline
    };
  };

  const avalanche = compare("avalanche");
  const snowball = compare("snowball");

  return {
    inputs: {
      debts: normalizedDebts,
      monthly_budget: monthlyBudget,
      extra_payment: extraPayment
    },
    avalanche,
    snowball
  };
}

async function markIntentMetadata(intentId, userId, patch = {}) {
  const { data: current, error: currentError } = await supabaseAdmin
    .from("payment_intents")
    .select("metadata")
    .eq("id", intentId)
    .eq("user_id", userId)
    .single();

  if (currentError) throw currentError;

  const metadata = {
    ...(current?.metadata || {}),
    ...patch
  };

  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .update({
      metadata,
      updated_at: new Date().toISOString()
    })
    .eq("id", intentId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function applyExecutedIntentToDebt(userId, intentInput) {
  const intent = intentInput;
  const intentId = intent?.id || null;
  const debtId = intent?.debt_id || intent?.target_debt_id || null;
  const amount = getIntentAmount(intent);
  const metadata = getIntentMetadata(intent);

  if (!intentId || !isUuid(intentId)) {
    return { ok: false, skipped: true, reason: "intent_id inválido" };
  }

  if (!debtId || !isUuid(debtId)) {
    await markIntentMetadata(intentId, userId, {
      debt_balance_apply_skipped_at: new Date().toISOString(),
      debt_balance_apply_reason: "sin_debt_id_valido"
    }).catch(() => null);

    return { ok: false, skipped: true, reason: "sin debt_id válido" };
  }

  if (amount <= 0) {
    await markIntentMetadata(intentId, userId, {
      debt_balance_apply_skipped_at: new Date().toISOString(),
      debt_balance_apply_reason: "monto_no_valido"
    }).catch(() => null);

    return { ok: false, skipped: true, reason: "monto no válido" };
  }

  if (metadata.debt_balance_applied_at) {
    return { ok: true, skipped: true, reason: "ya_aplicado", debt_id: debtId, amount };
  }

  const { data: debt, error: debtError } = await supabaseAdmin
    .from("debts")
    .select("*")
    .eq("id", debtId)
    .eq("user_id", userId)
    .single();

  if (debtError || !debt) {
    await markIntentMetadata(intentId, userId, {
      debt_balance_apply_skipped_at: new Date().toISOString(),
      debt_balance_apply_reason: "deuda_no_encontrada",
      debt_balance_apply_attempted_amount: amount
    }).catch(() => null);

    return { ok: false, skipped: true, reason: "deuda no encontrada", debt_id: debtId, amount };
  }

  const now = new Date().toISOString();
  const currentBalance = safeNumber(debt.balance);
  const nextBalance = Math.max(0, Number((currentBalance - amount).toFixed(2)));

  const { error: debtUpdateError } = await supabaseAdmin
    .from("debts")
    .update({
      balance: nextBalance,
      updated_at: now
    })
    .eq("id", debtId)
    .eq("user_id", userId);

  if (debtUpdateError) {
    throw debtUpdateError;
  }

  await markIntentMetadata(intentId, userId, {
    debt_balance_applied_at: now,
    debt_balance_applied_amount: amount,
    debt_balance_previous: currentBalance,
    debt_balance_next: nextBalance
  });

  return {
    ok: true,
    skipped: false,
    debt_id: debtId,
    amount,
    previous_balance: currentBalance,
    next_balance: nextBalance
  };
}

async function reconcileRecentExecutedIntents(userId, options = {}) {
  const days = Math.max(0, safeNumber(options.days, 2));
  const limit = Math.min(50, Math.max(1, safeNumber(options.limit, 10)));
  const sinceIso = options.since_iso || isoDaysAgo(days);

  const { data: intents, error } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "executed")
    .gte("created_at", sinceIso)
    .order("executed_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const pending = (intents || []).filter((intent) => {
    const metadata = getIntentMetadata(intent);
    return !metadata.debt_balance_applied_at;
  });

  const results = [];

  for (const intent of pending) {
    try {
      const applied = await applyExecutedIntentToDebt(userId, intent);
      results.push({ id: intent.id, ok: true, ...applied });
    } catch (e) {
      results.push({ id: intent.id, ok: false, error: e.message });
    }
  }

  return {
    since_iso: sinceIso,
    checked: (intents || []).length,
    pending: pending.length,
    applied_count: results.filter((x) => x.ok && !x.skipped).length,
    skipped_count: results.filter((x) => x.ok && x.skipped).length,
    failed_count: results.filter((x) => !x.ok).length,
    results
  };
}

async function approveIntentDirect(userId, intentId) {
  if (!isUuid(intentId)) {
    const err = new Error("intent_id inválido");
    err.status = 400;
    throw err;
  }

  const { data: intent, error: intentError } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("id", intentId)
    .eq("user_id", userId)
    .single();

  if (intentError || !intent) {
    const err = new Error("Intent no encontrado");
    err.status = 404;
    throw err;
  }

  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .update({
      status: "approved",
      approved_at: now,
      updated_at: now
    })
    .eq("id", intentId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function executeIntentDirect(userId, intentId) {
  if (!isUuid(intentId)) {
    const err = new Error("intent_id inválido");
    err.status = 400;
    throw err;
  }

  const { data: intent, error: intentError } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("id", intentId)
    .eq("user_id", userId)
    .single();

  if (intentError || !intent) {
    const err = new Error("Intent no encontrado");
    err.status = 404;
    throw err;
  }

  if (intent.status !== "approved" && intent.status !== "executed") {
    await approveIntentDirect(userId, intentId);
  }

  const { data: freshIntent, error: freshError } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("id", intentId)
    .eq("user_id", userId)
    .single();

  if (freshError || !freshIntent) {
    throw new Error("No se pudo recargar el intent");
  }

  if (freshIntent.status === "executed") {
    return {
      already_executed: true,
      data: freshIntent,
      debt_apply: {
        ok: true,
        skipped: true,
        reason: "ya_ejecutado"
      }
    };
  }

  const amount = getIntentAmount(freshIntent);
  const now = new Date().toISOString();

  const { data: updatedIntent, error: updateIntentError } = await supabaseAdmin
    .from("payment_intents")
    .update({
      status: "executed",
      executed_at: now,
      updated_at: now
    })
    .eq("id", intentId)
    .eq("user_id", userId)
    .select()
    .single();

  if (updateIntentError) throw updateIntentError;

  const executionPayload = {
    user_id: userId,
    payment_intent_id: updatedIntent.id,
    amount,
    status: "executed",
    executed_at: now,
    created_at: now,
    updated_at: now
  };

  const { error: executionError } = await supabaseAdmin
    .from("payment_executions")
    .upsert(executionPayload, { onConflict: "payment_intent_id" });

  if (executionError) {
    appDebug("No se pudo registrar payment_execution:", executionError.message);
  }

  const debtApply = await applyExecutedIntentToDebt(userId, updatedIntent).catch((e) => ({
    ok: false,
    error: e.message
  }));

  return {
    already_executed: false,
    data: updatedIntent,
    debt_apply: debtApply
  };
}

registerAllRoutes(app, {
  SERVER_VERSION,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_ID_BETA_MONTHLY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PORTAL_CONFIG_ID,
  requireUser,
  requireCronSecret,
  supabaseAdmin,
  sortTraceRows,
  getIntentAmount,
  appDebug,
  appError,
  jsonError,
  callRpc,
  safeNumber,
  safeBoolean,
  safeNullableNumber,
  stampRecentIntentsFundingFromPlan,
  approveIntentDirect,
  executeIntentDirect,
  reconcileRecentExecutedIntents,
  isoDaysAgo,
  stripe,
  stripeDebug,
  getLatestBillingSubscriptionForUser,
  ensureProfile,
  getOrCreateStripeCustomerForUser,
  getBaseUrl,
  plaidClient,
  PLAID_PRODUCTS,
  PLAID_COUNTRY_CODES,
  PLAID_REDIRECT_URI,
  PLAID_ANDROID_PACKAGE_NAME,
  getInstitutionName,
  upsertPlaidItem,
  getPlaidItemsForUser,
  stripPlaidItemSecretsForClient,
  fetchInstitutionLogoDataUrl,
  importPlaidAccountsForUser,
  getLatestPlaidItemForUser,
  insertTransactionsRaw,
  isUuid,
  assertLinkedPlaidAccountForUser,
  normalizePaymentPlan,
  savePaymentPlanForUser,
  getCurrentPaymentPlan,
  buildMicroRulePayload,
  normalizeMicroRuleModeInput,
  compareStrategiesForUser
});

app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/health") &&
    !req.path.startsWith("/billing") &&
    !req.path.startsWith("/stripe") &&
    !req.path.startsWith("/supabase") &&
    !req.path.startsWith("/plaid") &&
    !req.path.startsWith("/accounts") &&
    !req.path.startsWith("/debts") &&
    !req.path.startsWith("/payment-plan") &&
    !req.path.startsWith("/payment-plans") &&
    !req.path.startsWith("/rules") &&
    !req.path.startsWith("/apply_rules_v2") &&
    !req.path.startsWith("/build_intents_v2") &&
    !req.path.startsWith("/approve_intent_v2") &&
    !req.path.startsWith("/execute_intent_v2") &&
    !req.path.startsWith("/auto_sweep_v2") &&
    !req.path.startsWith("/payment-intents") &&
    !req.path.startsWith("/payment-trace") &&
    !req.path.startsWith("/strategy") &&
    !req.path.startsWith("/cron")
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

app.use((err, req, res, _next) => {
  appError("ERROR NO CONTROLADO:", req.requestId || null, err);
  return jsonError(res, 500, "Error interno del servidor", {
    details: err.message
  });
});

app.listen(PORT, () => {
  console.log(`DebtYa API escuchando en puerto ${PORT}`);
  console.log(`Server version: ${SERVER_VERSION}`);
});
