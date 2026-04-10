require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_VERSION = "cron-safe-v19-payment-trace-safe";

const DEBUG_STRIPE = false;

function stripeDebug(...args) {
  if (DEBUG_STRIPE) {
    console.log(...args);
  }
}

function stripeInfo(...args) {
  console.log(...args);
}

function stripeError(...args) {
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

app.use(cors());

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      stripeDebug("[STRIPE_WEBHOOK] hit", {
        hasStripe: !!stripe,
        hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET,
        contentType: req.headers["content-type"] || null
      });

      if (!stripe) {
        stripeError("[STRIPE_WEBHOOK] Stripe no configurado");
        return jsonError(res, 500, "Stripe no configurado");
      }

      if (!STRIPE_WEBHOOK_SECRET) {
        stripeError("[STRIPE_WEBHOOK] STRIPE_WEBHOOK_SECRET no configurado");
        return jsonError(res, 500, "STRIPE_WEBHOOK_SECRET no configurado");
      }

      const signature = req.headers["stripe-signature"];
      if (!signature) {
        stripeError("[STRIPE_WEBHOOK] falta stripe-signature");
        return jsonError(res, 400, "Falta Stripe-Signature");
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        stripeError("[STRIPE_WEBHOOK] firma inválida", err.message);
        return jsonError(res, 400, "Firma webhook inválida", {
          details: err.message
        });
      }

      const eventType = event.type;
      const obj = event.data?.object || null;

      stripeInfo("[stripe] webhook recibido:", eventType);

      if (eventType === "checkout.session.completed") {
        const session = obj;
        const subscriptionId =
          typeof session?.subscription === "string"
            ? session.subscription
            : session?.subscription?.id || null;

        stripeDebug("[STRIPE_WEBHOOK] checkout.session.completed", {
          sessionId: session?.id || null,
          client_reference_id: session?.client_reference_id || null,
          customerId:
            typeof session?.customer === "string"
              ? session.customer
              : session?.customer?.id || null,
          subscriptionId
        });

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const customerId =
            typeof subscription?.customer === "string"
              ? subscription.customer
              : subscription?.customer?.id || null;

          const userId = await resolveStripeUserId({
            session,
            subscription,
            customerId,
            fallbackUserId: session?.client_reference_id || null
          });

          stripeDebug("[STRIPE_WEBHOOK] subscription recuperada desde checkout", {
            subscriptionId: subscription?.id || null,
            userId,
            stripeCustomerId: customerId,
            status: subscription?.status || null
          });

          const saved = await upsertBillingSubscriptionFromStripe(subscription, userId);

          if (!saved) {
            throw new Error("No se pudo persistir billing_subscriptions para checkout.session.completed");
          }

          stripeInfo("[stripe] checkout persistido", {
            saved: !!saved,
            stripeSubscriptionId: saved?.stripe_subscription_id || null
          });
        } else {
          stripeDebug("[STRIPE_WEBHOOK] checkout.session.completed sin subscriptionId");
        }
      }

      if (
        eventType === "customer.subscription.created" ||
        eventType === "customer.subscription.updated" ||
        eventType === "customer.subscription.deleted"
      ) {
        const subscription = obj;
        const customerId =
          typeof subscription?.customer === "string"
            ? subscription.customer
            : subscription?.customer?.id || null;

        const userId = await resolveStripeUserId({
          subscription,
          customerId,
          fallbackUserId: subscription?.metadata?.supabase_user_id || null
        });

        stripeDebug("[STRIPE_WEBHOOK] customer.subscription event", {
          type: eventType,
          subscriptionId: subscription?.id || null,
          userId,
          stripeCustomerId: customerId,
          status: subscription?.status || null
        });

        const saved = await upsertBillingSubscriptionFromStripe(subscription, userId);

        if (!saved) {
          throw new Error(`No se pudo persistir billing_subscriptions para ${eventType}`);
        }

        stripeInfo("[stripe] subscription persistida", {
          type: eventType,
          saved: !!saved,
          stripeSubscriptionId: saved?.stripe_subscription_id || null
        });
      }

      if (
        eventType === "invoice.paid" ||
        eventType === "invoice.payment_failed" ||
        eventType === "invoice.payment_succeeded"
      ) {
        const invoice = obj;
        const subscriptionId =
          typeof invoice?.subscription === "string"
            ? invoice.subscription
            : invoice?.subscription?.id || null;

        stripeDebug("[STRIPE_WEBHOOK] invoice event", {
          type: eventType,
          invoiceId: invoice?.id || null,
          invoiceStatus: invoice?.status || null,
          subscriptionId
        });

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const customerId =
            typeof subscription?.customer === "string"
              ? subscription.customer
              : subscription?.customer?.id || null;

          const userId = await resolveStripeUserId({
            subscription,
            customerId,
            fallbackUserId: subscription?.metadata?.supabase_user_id || null
          });

          const saved = await upsertBillingSubscriptionFromStripe(subscription, userId, {
            last_invoice_id: invoice?.id || null,
            last_invoice_status: invoice?.status || null
          });

          if (!saved) {
            throw new Error(`No se pudo persistir billing_subscriptions para ${eventType}`);
          }

          stripeInfo("[stripe] invoice sincronizada", {
            type: eventType,
            saved: !!saved,
            stripeSubscriptionId: saved?.stripe_subscription_id || null
          });
        } else {
          stripeDebug("[STRIPE_WEBHOOK] invoice event sin subscriptionId");
        }
      }

      return res.json({ ok: true, received: true, type: eventType });
    } catch (error) {
      stripeError("[STRIPE_WEBHOOK] error general", error.message);
      stripeDebug("[STRIPE_WEBHOOK] error stack", error.stack);

      return jsonError(res, 500, "Error procesando webhook Stripe", {
        details: error.message
      });
    }
  }
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

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
  return res.status(status).json({
    ok: false,
    error: message,
    ...extra
  });
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
    console.warn("No se pudo asegurar profile:", e.message);
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
    console.warn("No se pudo leer billing_subscriptions:", e.message);
    return null;
  }
}

async function getStripeCustomerById(customerId) {
  try {
    if (!stripe || !customerId) return null;
    return await stripe.customers.retrieve(customerId);
  } catch (e) {
    console.warn("No se pudo leer customer de Stripe:", e.message);
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
    console.warn("No se pudo obtener institución:", e.message);
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

function buildMicroRulePayload(userId, body = {}) {
  const mode = body.mode || body.rule_type || "roundup_percent";
  const config = body.config_json || body.config || {};

  const percent =
    body.percent !== undefined
      ? safeNumber(body.percent)
      : config.percent !== undefined
      ? safeNumber(config.percent)
      : mode === "roundup_percent"
      ? 10
      : 0;

  const fixedAmount =
    body.fixed_amount !== undefined
      ? safeNumber(body.fixed_amount)
      : config.fixed_amount !== undefined
      ? safeNumber(config.fixed_amount)
      : config.amount !== undefined
      ? safeNumber(config.amount)
      : 0;

  const roundupTo =
    body.roundup_to !== undefined
      ? safeNumber(body.roundup_to)
      : config.roundup_to !== undefined
      ? safeNumber(config.roundup_to)
      : 1;

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
      auto_mode: "manual"
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

  return {
    ...row,
    monthly_budget: safeNumber(row.monthly_budget),
    monthly_budget_default: monthlyBudgetDefault,
    extra_payment_default: extraPaymentDefault,
    automation_mode: automationMode,
    auto_mode: automationMode
  };
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
    console.warn("No se pudo registrar payment_execution:", executionError.message);
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

app.get("/health", async (_req, res) => {
  return res.json({
    ok: true,
    message: "DebtYa API funcionando",
    server_version: SERVER_VERSION,
    now: new Date().toISOString(),
    env_debug: {
      has_supabase_url: !!SUPABASE_URL,
      has_anon_key: !!SUPABASE_ANON_KEY,
      has_service_role_key: !!SUPABASE_SERVICE_ROLE_KEY,
      has_cron_secret: !!CRON_SECRET,
      has_stripe_secret_key: !!STRIPE_SECRET_KEY,
      has_stripe_price_id_beta_monthly: !!STRIPE_PRICE_ID_BETA_MONTHLY,
      has_stripe_webhook_secret: !!STRIPE_WEBHOOK_SECRET
    }
  });
});

app.get("/billing/subscription-status", requireUser, async (req, res) => {
  try {
    const row = await getLatestBillingSubscriptionForUser(req.user.id);

    if (!row) {
      return res.json({
        ok: true,
        data: {
          status: "inactive",
          active: false,
          current_period_end: null,
          stripe_customer_id: null,
          stripe_subscription_id: null,
          cancel_at_period_end: false
        }
      });
    }

    return res.json({
      ok: true,
      data: {
        status: row.status || "inactive",
        active: !!row.active,
        current_period_end: row.current_period_end || null,
        stripe_customer_id: row.stripe_customer_id || null,
        stripe_subscription_id: row.stripe_subscription_id || null,
        cancel_at_period_end: !!row.cancel_at_period_end
      }
    });
  } catch (error) {
    return jsonError(res, 500, "Error cargando suscripción", {
      details: error.message
    });
  }
});

app.post("/stripe/create-checkout-session", requireUser, async (req, res) => {
  try {
    if (!stripe) {
      return jsonError(res, 500, "Stripe no configurado");
    }

    if (!STRIPE_PRICE_ID_BETA_MONTHLY) {
      return jsonError(res, 500, "STRIPE_PRICE_ID_BETA_MONTHLY no configurado");
    }

    await ensureProfile(req.user.id);

    const customerId = await getOrCreateStripeCustomerForUser(req.user);
    const baseUrl = getBaseUrl(req);

    const successUrl =
      req.body?.success_url ||
      `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      req.body?.cancel_url ||
      `${baseUrl}/?checkout=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: STRIPE_PRICE_ID_BETA_MONTHLY,
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: req.user.id,
      allow_promotion_codes: true,
      metadata: {
        supabase_user_id: req.user.id,
        plan_code: "debtya_beta_monthly"
      },
      subscription_data: {
        metadata: {
          supabase_user_id: req.user.id,
          plan_code: "debtya_beta_monthly"
        }
      }
    });

    stripeDebug("[STRIPE_CHECKOUT] session creada", {
      userId: req.user.id,
      customerId,
      sessionId: session.id,
      checkoutUrl: !!session.url
    });

    return res.json({
      ok: true,
      session_id: session.id,
      url: session.url
    });
  } catch (error) {
    return jsonError(res, 500, "Error creando checkout Stripe", {
      details: error.message
    });
  }
});

app.post("/stripe/create-portal-session", requireUser, async (req, res) => {
  try {
    if (!stripe) {
      return jsonError(res, 500, "Stripe no configurado");
    }

    const row = await getLatestBillingSubscriptionForUser(req.user.id);
    if (!row?.stripe_customer_id) {
      return jsonError(res, 400, "Este usuario no tiene customer de Stripe todavía");
    }

    const baseUrl = getBaseUrl(req);
    const returnUrl = req.body?.return_url || `${baseUrl}/`;

    const payload = {
      customer: row.stripe_customer_id,
      return_url: returnUrl
    };

    if (STRIPE_PORTAL_CONFIG_ID) {
      payload.configuration = STRIPE_PORTAL_CONFIG_ID;
    }

    const session = await stripe.billingPortal.sessions.create(payload);

    return res.json({
      ok: true,
      url: session.url
    });
  } catch (error) {
    return jsonError(res, 500, "Error creando portal Stripe", {
      details: error.message
    });
  }
});

app.get("/supabase/ping", async (_req, res) => {
  try {
    if (!supabaseAdmin) {
      return jsonError(res, 500, "Supabase no configurado");
    }

    const payload = {
      ping_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from("debug_pings")
      .insert(payload)
      .select()
      .single();

    if (error) {
      return jsonError(res, 500, "Error insertando en Supabase", {
        details: error.message
      });
    }

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, error.message);
  }
});

app.get("/plaid/web", (req, res) => {
  const baseUrl = getBaseUrl(req);
  return res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DebtYa Plaid Web</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: Arial, sans-serif; background:#f7f7fb; padding:40px; }
    .card { max-width:560px; margin:auto; background:#fff; border-radius:16px; padding:24px; box-shadow:0 10px 30px rgba(0,0,0,.08); }
    button { background:#111827; color:white; border:0; border-radius:10px; padding:12px 18px; cursor:pointer; }
    pre { white-space:pre-wrap; background:#f3f4f6; padding:12px; border-radius:10px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>DebtYa - Conectar banco</h2>
    <p>Esta página usa Plaid Link Web.</p>
    <button id="connectBtn">Conectar banco</button>
    <pre id="output"></pre>
  </div>
  <script>
    const output = document.getElementById("output");
    const btn = document.getElementById("connectBtn");

    btn.onclick = async () => {
      const token = localStorage.getItem("debtya_access_token");
      if (!token) {
        output.textContent = "Falta debtya_access_token en localStorage.";
        return;
      }

      const r = await fetch("${baseUrl}/plaid/create_link_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        }
      });

      const data = await r.json();
      output.textContent = JSON.stringify(data, null, 2);

      if (!data.ok || !data.link_token) return;

      const handler = Plaid.create({
        token: data.link_token,
        onSuccess: async (public_token, metadata) => {
          const rr = await fetch("${baseUrl}/plaid/exchange_public_token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + token
            },
            body: JSON.stringify({ public_token, metadata })
          });
          const dd = await rr.json();
          output.textContent = JSON.stringify(dd, null, 2);
        },
        onExit: (err, metadata) => {
          output.textContent = JSON.stringify({ err, metadata }, null, 2);
        }
      });

      handler.open();
    };
  </script>
</body>
</html>
  `);
});

app.post("/plaid/create_link_token", requireUser, async (req, res) => {
  try {
    if (!plaidClient) {
      return jsonError(res, 500, "Plaid no configurado");
    }

    await ensureProfile(req.user.id);

    const request = {
      user: {
        client_user_id: req.user.id
      },
      client_name: "DebtYa",
      products: PLAID_PRODUCTS.split(",").map((x) => x.trim()),
      country_codes: PLAID_COUNTRY_CODES.split(",").map((x) => x.trim()),
      language: "es"
    };

    if (PLAID_REDIRECT_URI) {
      request.redirect_uri = PLAID_REDIRECT_URI;
    }

    if (PLAID_ANDROID_PACKAGE_NAME) {
      request.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
    }

    const response = await plaidClient.linkTokenCreate(request);

    return res.json({
      ok: true,
      link_token: response.data.link_token,
      expiration: response.data.expiration
    });
  } catch (error) {
    return jsonError(res, 500, "Error creando link token", {
      details: error.response?.data || error.message
    });
  }
});

app.post("/plaid/exchange_public_token", requireUser, async (req, res) => {
  try {
    if (!plaidClient) {
      return jsonError(res, 500, "Plaid no configurado");
    }

    const publicToken = req.body?.public_token || null;
    const metadata = req.body?.metadata || {};

    if (!publicToken) {
      return jsonError(res, 400, "Falta public_token");
    }

    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    const accessToken = exchange?.data?.access_token || null;
    const itemId = exchange?.data?.item_id || null;

    if (!accessToken || !itemId) {
      return jsonError(res, 500, "Plaid no devolvió access_token o item_id", {
        details: exchange?.data || null
      });
    }

    const institutionId = metadata?.institution?.institution_id || null;

    let institutionName = metadata?.institution?.name || null;

    if (!institutionName && institutionId) {
      try {
        institutionName = await getInstitutionName(institutionId);
      } catch (institutionError) {
        console.error(
          "getInstitutionName ERROR:",
          institutionError?.response?.data || institutionError?.message || institutionError
        );
        institutionName = null;
      }
    }

    const plaidItem = await upsertPlaidItem({
      userId: req.user.id,
      itemId,
      accessToken,
      institutionId,
      institutionName
    });

    return res.json({
      ok: true,
      item: {
        id: plaidItem?.id || null,
        plaid_item_id: plaidItem?.plaid_item_id || itemId,
        institution_id: plaidItem?.institution_id || institutionId,
        institution_name: plaidItem?.institution_name || institutionName
      }
    });
  } catch (error) {
    const raw =
      error?.response?.data ||
      error?.data ||
      error?.message ||
      null;

    const detailedMessage =
      raw?.error_message ||
      raw?.message ||
      raw?.error_code ||
      raw?.error_type ||
      (typeof raw === "string" ? raw : null) ||
      "Error intercambiando public_token";

    console.error("exchange_public_token ERROR RAW:", raw);

    return res.status(500).json({
      ok: false,
      error: detailedMessage,
      details: raw
    });
  }
});

app.get("/plaid/items", requireUser, async (req, res) => {
  try {
    const items = await getPlaidItemsForUser(req.user.id);
    return res.json({ ok: true, data: items });
  } catch (error) {
    return jsonError(res, 500, "Error cargando plaid items", {
      details: error.message
    });
  }
});

app.get("/plaid/accounts", requireUser, async (req, res) => {
  try {
    if (!plaidClient) {
      return jsonError(res, 500, "Plaid no configurado");
    }

    const result = await importPlaidAccountsForUser(req.user.id);

    return res.json({
      ok: true,
      item_id: result.item.plaid_item_id,
      total_accounts: result.response.data.accounts.length,
      data: result.saved
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error importando cuentas", {
      details: error.response?.data || error.message
    });
  }
});

app.post("/plaid/accounts/import", requireUser, async (req, res) => {
  try {
    const result = await importPlaidAccountsForUser(req.user.id);

    return res.json({
      ok: true,
      item_id: result.item.plaid_item_id,
      total_accounts: result.response.data.accounts.length,
      count: result.saved.length,
      data: result.saved
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error importando cuentas", {
      details: error.response?.data || error.message
    });
  }
});

app.post("/plaid/transactions/sync", requireUser, async (req, res) => {
  try {
    if (!plaidClient) {
      return jsonError(res, 500, "Plaid no configurado");
    }

    const item = await getLatestPlaidItemForUser(req.user.id);
    if (!item?.access_token) {
      return jsonError(res, 400, "No hay cuenta bancaria conectada");
    }

    let cursor = req.body.cursor || item.sync_cursor || null;
    let added = [];
    let hasMore = true;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: item.access_token,
        cursor
      });

      const data = response.data;
      added = added.concat(data.added || []);
      cursor = data.next_cursor;
      hasMore = !!data.has_more;
    }

    const syncResult = await insertTransactionsRaw(
      req.user.id,
      item.plaid_item_id,
      added
    );

    await supabaseAdmin
      .from("plaid_items")
      .update({
        sync_cursor: cursor,
        updated_at: new Date().toISOString()
      })
      .eq("id", item.id);

    return res.json({
      ok: true,
      plaid_item_id: item.plaid_item_id,
      imported: syncResult.inserted,
      added: syncResult.inserted,
      next_cursor: cursor
    });
  } catch (error) {
    return jsonError(res, 500, "Error importando transacciones", {
      details: error.response?.data || error.message
    });
  }
});

app.get("/accounts", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return res.json({ ok: true, data: data || [] });
  } catch (error) {
    return jsonError(res, 500, "Error cargando cuentas", {
      details: error.message
    });
  }
});

app.get("/debts", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("debts")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("is_active", true)
      .order("apr", { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      data: data || []
    });
  } catch (error) {
    return jsonError(res, 500, "Error cargando deudas", {
      details: error.message
    });
  }
});

app.post("/debts", requireUser, async (req, res) => {
  try {
    const payload = {
      user_id: req.user.id,
      name: req.body.name || "Deuda",
      balance: safeNumber(req.body.balance),
      apr: safeNumber(req.body.apr),
      minimum_payment: safeNumber(req.body.minimum_payment),
      due_day: req.body.due_day ? Number(req.body.due_day) : null,
      type: req.body.type || "credit_card",
      goal_note: req.body.goal_note || null,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from("debts")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error creando deuda", {
      details: error.message
    });
  }
});

app.patch("/debts/:id", requireUser, async (req, res) => {
  try {
    const debtId = req.params.id;
    if (!isUuid(debtId)) {
      return jsonError(res, 400, "ID inválido");
    }

    const patch = {
      updated_at: new Date().toISOString()
    };

    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.balance !== undefined) patch.balance = safeNumber(req.body.balance);
    if (req.body.apr !== undefined) patch.apr = safeNumber(req.body.apr);
    if (req.body.minimum_payment !== undefined) patch.minimum_payment = safeNumber(req.body.minimum_payment);
    if (req.body.due_day !== undefined) patch.due_day = req.body.due_day ? Number(req.body.due_day) : null;
    if (req.body.type !== undefined) patch.type = req.body.type;
    if (req.body.goal_note !== undefined) patch.goal_note = req.body.goal_note || null;
    if (req.body.is_active !== undefined) patch.is_active = !!req.body.is_active;

    const { data, error } = await supabaseAdmin
      .from("debts")
      .update(patch)
      .eq("id", debtId)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error actualizando deuda", {
      details: error.message
    });
  }
});

app.delete("/debts/:id", requireUser, async (req, res) => {
  try {
    const debtId = req.params.id;
    if (!isUuid(debtId)) {
      return jsonError(res, 400, "ID inválido");
    }

    const { error } = await supabaseAdmin
      .from("debts")
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", debtId)
      .eq("user_id", req.user.id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (error) {
    return jsonError(res, 500, "Error eliminando deuda", {
      details: error.message
    });
  }
});

app.get("/payment-plans", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("payment_plans")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return res.json({
      ok: true,
      data: (data || []).map(normalizePaymentPlan)
    });
  } catch (error) {
    return jsonError(res, 500, "Error cargando planes", {
      details: error.message
    });
  }
});

app.post("/payment-plans", requireUser, async (req, res) => {
  try {
    const data = await savePaymentPlanForUser(req.user.id, req.body);
    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error guardando plan", {
      details: error.message
    });
  }
});

app.get("/payment-plan", requireUser, async (req, res) => {
  try {
    const data = await getCurrentPaymentPlan(req.user.id);
    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error cargando plan", {
      details: error.message
    });
  }
});

app.post("/payment-plan", requireUser, async (req, res) => {
  try {
    const data = await savePaymentPlanForUser(req.user.id, req.body);
    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error guardando plan", {
      details: error.message
    });
  }
});

app.get("/rules", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("micro_rules")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({ ok: true, data: data || [] });
  } catch (error) {
    return jsonError(res, 500, "Error cargando reglas", {
      details: error.message
    });
  }
});

app.post("/rules", requireUser, async (req, res) => {
  try {
    const payload = buildMicroRulePayload(req.user.id, req.body);

    const { data, error } = await supabaseAdmin
      .from("micro_rules")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error creando regla", {
      details: error.message
    });
  }
});

app.patch("/rules/:id", requireUser, async (req, res) => {
  try {
    const ruleId = req.params.id;
    if (!isUuid(ruleId)) {
      return jsonError(res, 400, "ID inválido");
    }

    const config = req.body.config_json || req.body.config || {};
    const patch = {
      updated_at: new Date().toISOString()
    };

    if (req.body.enabled !== undefined) patch.enabled = safeBoolean(req.body.enabled, true);
    if (req.body.is_active !== undefined) patch.enabled = safeBoolean(req.body.is_active, true);
    if (req.body.mode !== undefined) patch.mode = req.body.mode;
    if (req.body.rule_type !== undefined) patch.mode = req.body.rule_type;

    if (req.body.fixed_amount !== undefined) patch.fixed_amount = safeNumber(req.body.fixed_amount);
    else if (config.fixed_amount !== undefined) patch.fixed_amount = safeNumber(config.fixed_amount);
    else if (config.amount !== undefined) patch.fixed_amount = safeNumber(config.amount);

    if (req.body.percent !== undefined) patch.percent = safeNumber(req.body.percent);
    else if (config.percent !== undefined) patch.percent = safeNumber(config.percent);

    if (req.body.roundup_to !== undefined) patch.roundup_to = safeNumber(req.body.roundup_to);
    else if (config.roundup_to !== undefined) patch.roundup_to = safeNumber(config.roundup_to);

    if (req.body.min_purchase_amount !== undefined) patch.min_purchase_amount = safeNumber(req.body.min_purchase_amount);
    else if (config.min_purchase_amount !== undefined) patch.min_purchase_amount = safeNumber(config.min_purchase_amount);

    if (req.body.cap_daily !== undefined) patch.cap_daily = safeNullableNumber(req.body.cap_daily);
    else if (config.cap_daily !== undefined) patch.cap_daily = safeNullableNumber(config.cap_daily);

    if (req.body.cap_weekly !== undefined) patch.cap_weekly = safeNullableNumber(req.body.cap_weekly);
    else if (config.cap_weekly !== undefined) patch.cap_weekly = safeNullableNumber(config.cap_weekly);

    const targetDebtId =
      req.body.target_debt_id !== undefined
        ? req.body.target_debt_id
        : config.target_debt_id !== undefined
        ? config.target_debt_id
        : req.body.debt_id !== undefined
        ? req.body.debt_id
        : undefined;

    if (targetDebtId !== undefined) {
      patch.target_debt_id = isUuid(targetDebtId) ? targetDebtId : null;
    }

    if (req.body.auto_run !== undefined) patch.auto_run = safeBoolean(req.body.auto_run, false);
    else if (config.auto_run !== undefined) patch.auto_run = safeBoolean(config.auto_run, false);

    if (req.body.payout_enabled !== undefined) patch.payout_enabled = safeBoolean(req.body.payout_enabled, false);
    else if (config.payout_enabled !== undefined) patch.payout_enabled = safeBoolean(config.payout_enabled, false);

    if (req.body.payout_min_threshold !== undefined) patch.payout_min_threshold = safeNumber(req.body.payout_min_threshold);
    else if (config.payout_min_threshold !== undefined) patch.payout_min_threshold = safeNumber(config.payout_min_threshold);

    const { data, error } = await supabaseAdmin
      .from("micro_rules")
      .update(patch)
      .eq("id", ruleId)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error actualizando regla", {
      details: error.message
    });
  }
});

app.delete("/rules/:id", requireUser, async (req, res) => {
  try {
    const ruleId = req.params.id;
    if (!isUuid(ruleId)) {
      return jsonError(res, 400, "ID inválido");
    }

    const { error } = await supabaseAdmin
      .from("micro_rules")
      .delete()
      .eq("id", ruleId)
      .eq("user_id", req.user.id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (error) {
    return jsonError(res, 500, "Error eliminando regla", {
      details: error.message
    });
  }
});

app.post("/apply_rules_v2", requireUser, async (req, res) => {
  try {
    const result = await callRpc("apply_rules_v2", {
      p_user_id: req.user.id
    });

    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error ejecutando apply_rules_v2", {
      details: error.message
    });
  }
});

app.post("/rules/apply", requireUser, async (req, res) => {
  try {
    const result = await callRpc("apply_rules_v2", {
      p_user_id: req.user.id
    });

    const created =
      safeNumber(result?.allocations_created) ||
      safeNumber(result?.count) ||
      safeNumber(result?.created) ||
      0;

    return res.json({
      ok: true,
      created,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error aplicando reglas", {
      details: error.message
    });
  }
});

app.post("/build_intents_v2", requireUser, async (req, res) => {
  try {
    const result = await callRpc("build_intents_v2", {
      p_user_id: req.user.id
    });

    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error ejecutando build_intents_v2", {
      details: error.message
    });
  }
});

app.post("/payment-intents/build", requireUser, async (req, res) => {
  try {
    const result = await callRpc("build_intents_v2", {
      p_user_id: req.user.id
    });

    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error construyendo intents", {
      details: error.message
    });
  }
});

app.post("/approve_intent_v2", requireUser, async (req, res) => {
  try {
    const intentId = req.body.intent_id;
    const data = await approveIntentDirect(req.user.id, intentId);

    return res.json({
      ok: true,
      bypass_sql_function: true,
      data
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error ejecutando approve_intent_v2", {
      details: error.message
    });
  }
});

app.post("/execute_intent_v2", requireUser, async (req, res) => {
  try {
    const intentId = req.body.intent_id;
    const result = await executeIntentDirect(req.user.id, intentId);

    return res.json({
      ok: true,
      bypass_sql_function: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error ejecutando execute_intent_v2", {
      details: error.message
    });
  }
});

app.post("/auto_sweep_v2", requireUser, async (req, res) => {
  try {
    const result = await callRpc("auto_sweep_v2", {
      p_user_id: req.user.id
    });

    return res.json({
      ok: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error ejecutando auto_sweep_v2", {
      details: error.message
    });
  }
});

app.get("/payment-intents", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({ ok: true, data: data || [] });
  } catch (error) {
    return jsonError(res, 500, "Error cargando intents", {
      details: error.message
    });
  }
});

app.post("/payment-intents", requireUser, async (req, res) => {
  try {
    const payload = {
      user_id: req.user.id,
      debt_id: req.body.debt_id || null,
      source_account_id: req.body.source_account_id || null,
      strategy: req.body.strategy || "avalanche",
      amount: safeNumber(req.body.amount),
      status: req.body.status || "draft",
      scheduled_for: req.body.scheduled_for || null,
      notes: req.body.notes || null
    };

    const { data, error } = await supabaseAdmin
      .from("payment_intents")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return jsonError(res, 500, "Error creando intent", {
      details: error.message
    });
  }
});

app.post("/payment-intents/:id/approve", requireUser, async (req, res) => {
  try {
    const intentId = req.params.id;
    const data = await approveIntentDirect(req.user.id, intentId);

    return res.json({
      ok: true,
      bypass_sql_function: true,
      data
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error aprobando intent", {
      details: error.message
    });
  }
});

app.post("/payment-intents/:id/execute", requireUser, async (req, res) => {
  try {
    const intentId = req.params.id;
    const result = await executeIntentDirect(req.user.id, intentId);

    return res.json({
      ok: true,
      bypass_sql_function: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, error.status || 500, "Error ejecutando intent", {
      details: error.message
    });
  }
});

app.post("/payment-intents/approve-visible", requireUser, async (req, res) => {
  try {
    const { data: intents, error } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("user_id", req.user.id)
      .in("status", ["draft", "pending", "built", "proposed", "ready", "pending_review"])
      .order("created_at", { ascending: false });

    if (error) throw error;

    const results = [];

    for (const intent of intents || []) {
      try {
        const approved = await approveIntentDirect(req.user.id, intent.id);
        results.push({
          id: intent.id,
          ok: true,
          data: approved
        });
      } catch (e) {
        results.push({
          id: intent.id,
          ok: false,
          error: e.message
        });
      }
    }

    return res.json({
      ok: true,
      bypass_sql_function: true,
      total_visible: (intents || []).length,
      approved_count: results.filter((x) => x.ok).length,
      failed_count: results.filter((x) => !x.ok).length,
      results
    });
  } catch (error) {
    return jsonError(res, 500, "Error aprobando visibles", {
      details: error.message
    });
  }
});

app.post("/payment-intents/execute-visible", requireUser, async (req, res) => {
  try {
    const { data: intents, error } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("user_id", req.user.id)
      .in("status", ["approved"])
      .order("created_at", { ascending: false });

    if (error) throw error;

    const results = [];

    for (const intent of intents || []) {
      try {
        const executed = await executeIntentDirect(req.user.id, intent.id);
        results.push({
          id: intent.id,
          ok: true,
          data: executed
        });
      } catch (e) {
        results.push({
          id: intent.id,
          ok: false,
          error: e.message
        });
      }
    }

    return res.json({
      ok: true,
      bypass_sql_function: true,
      total_visible: (intents || []).length,
      executed_count: results.filter((x) => x.ok).length,
      failed_count: results.filter((x) => !x.ok).length,
      results
    });
  } catch (error) {
    return jsonError(res, 500, "Error ejecutando visibles", {
      details: error.message
    });
  }
});

app.post("/payment-intents/reconcile-recent", requireUser, async (req, res) => {
  try {
    const days = Math.max(0, safeNumber(req.body?.days, 2));
    const limit = Math.min(50, Math.max(1, safeNumber(req.body?.limit, 10)));
    const sinceIso = req.body?.since_iso || isoDaysAgo(days);

    const result = await reconcileRecentExecutedIntents(req.user.id, {
      days,
      limit,
      since_iso: sinceIso
    });

    return res.json({
      ok: true,
      safe_mode: true,
      data: result
    });
  } catch (error) {
    return jsonError(res, 500, "Error reconciliando intents recientes", {
      details: error.message
    });
  }
});

app.get("/payment-trace", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("v_payment_trace")
      .select("*")
      .eq("user_id", req.user.id);

    if (!error) {
      return res.json({
        ok: true,
        source: "v_payment_trace",
        data: sortTraceRows(data || [])
      });
    }

    console.warn("Fallback payment-trace por error en vista:", error.message);

    const { data: intents, error: fallbackError } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (fallbackError) throw fallbackError;

    const normalized = (intents || []).map((x) => ({
      id: x.id,
      user_id: x.user_id,
      debt_id: x.debt_id,
      status: x.status,
      total_amount: getIntentAmount(x),
      scheduled_for: x.scheduled_for,
      approved_at: x.approved_at,
      executed_at: x.executed_at,
      created_at: x.created_at,
      updated_at: x.updated_at,
      metadata: x.metadata || null
    }));

    return res.json({
      ok: true,
      source: "payment_intents_fallback",
      data: sortTraceRows(normalized)
    });
  } catch (error) {
    return jsonError(res, 500, "Error cargando trace", {
      details: error.message
    });
  }
});

app.get("/strategy/compare", requireUser, async (req, res) => {
  try {
    const monthlyBudget = safeNumber(req.query.monthly_budget, 0);
    const extraPayment = safeNumber(req.query.extra_payment, 0);

    const data = await compareStrategiesForUser(
      req.user.id,
      monthlyBudget,
      extraPayment
    );

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return jsonError(res, 500, "Error comparando estrategias", {
      details: error.message
    });
  }
});

app.post("/strategy/compare", requireUser, async (req, res) => {
  try {
    const monthlyBudget =
      req.body.monthly_budget_default !== undefined
        ? safeNumber(req.body.monthly_budget_default, 0)
        : safeNumber(req.body.monthly_budget, 0);

    const extraPayment =
      req.body.extra_payment_default !== undefined
        ? safeNumber(req.body.extra_payment_default, 0)
        : safeNumber(req.body.extra_payment, 0);

    const data = await compareStrategiesForUser(
      req.user.id,
      monthlyBudget,
      extraPayment
    );

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return jsonError(res, 500, "Error comparando estrategias", {
      details: error.message
    });
  }
});

app.post("/cron/full-auto", requireCronSecret, async (_req, res) => {
  try {
    if (!supabaseAdmin) {
      return jsonError(res, 500, "Supabase no configurado");
    }

    const { data: users, error } = await supabaseAdmin
      .from("profiles")
      .select("id");

    if (error) throw error;

    const results = [];
    let successUsers = 0;
    let failedUsers = 0;
    let allocationsCreated = 0;
    let intentsCreated = 0;
    let intentsExecuted = 0;
    let totalExecutedAmount = 0;

    for (const user of users || []) {
      try {
        const userId = user.id;

        const applyResult = await callRpc("apply_rules_v2", {
          p_user_id: userId
        }).catch(() => null);

        const buildResult = await callRpc("build_intents_v2", {
          p_user_id: userId
        }).catch(() => null);

        let buildItems = [];
        if (Array.isArray(buildResult)) buildItems = buildResult;
        if (buildResult?.intents && Array.isArray(buildResult.intents)) {
          buildItems = buildResult.intents;
        }

        let createdForUser = 0;
        let executedForUser = 0;
        let totalExecutedForUser = 0;

        for (const item of buildItems) {
          const intentId =
            item?.intent_id || item?.id || item?.payment_intent_id || null;
          if (!intentId || !isUuid(intentId)) continue;

          createdForUser += 1;

          await approveIntentDirect(userId, intentId).catch(() => null);

          const executeResult = await executeIntentDirect(userId, intentId).catch(() => null);

          if (executeResult && !executeResult.already_executed) {
            executedForUser += 1;
            totalExecutedForUser += getIntentAmount(executeResult.data);
          }
        }

        const allocationsForUser =
          safeNumber(applyResult?.allocations_created) ||
          safeNumber(applyResult?.count) ||
          0;

        allocationsCreated += allocationsForUser;
        intentsCreated += createdForUser;
        intentsExecuted += executedForUser;
        totalExecutedAmount += totalExecutedForUser;
        successUsers += 1;

        results.push({
          user_id: userId,
          ok: true,
          allocations_created: allocationsForUser,
          intents_created: createdForUser,
          intents_executed: executedForUser,
          total_executed: Number(totalExecutedForUser.toFixed(2))
        });
      } catch (error) {
        failedUsers += 1;
        results.push({
          user_id: user.id,
          ok: false,
          error: error.message
        });
      }
    }

    return res.json({
      ok: true,
      server_version: SERVER_VERSION,
      ran_at: new Date().toISOString(),
      total_users: (users || []).length,
      success_users: successUsers,
      failed_users: failedUsers,
      allocations_created: allocationsCreated,
      intents_created: intentsCreated,
      intents_executed: intentsExecuted,
      total_executed_amount: Number(totalExecutedAmount.toFixed(2)),
      results,
      env_debug: {
        has_supabase_url: !!SUPABASE_URL,
        has_anon_key: !!SUPABASE_ANON_KEY,
        has_service_role_key: !!SUPABASE_SERVICE_ROLE_KEY,
        has_cron_secret: !!CRON_SECRET
      }
    });
  } catch (error) {
    return jsonError(res, 500, "Error ejecutando cron full-auto", {
      details: error.message
    });
  }
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
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

app.use((err, _req, res, _next) => {
  console.error("ERROR NO CONTROLADO:", err);
  return jsonError(res, 500, "Error interno del servidor", {
    details: err.message
  });
});

app.listen(PORT, () => {
  console.log(`DebtYa API escuchando en puerto ${PORT}`);
  console.log(`Server version: ${SERVER_VERSION}`);
});