require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   CONFIG
========================= */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const PLAID_SECRET = process.env.PLAID_SECRET || "";
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions").split(",").map(s => s.trim()).filter(Boolean);
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || "US").split(",").map(s => s.trim()).filter(Boolean);
const CRON_SECRET = process.env.CRON_SECRET || "";

const IS_RENDER = !!process.env.RENDER;

const PLAID_BASE_URL =
  PLAID_ENV === "production"
    ? "https://production.plaid.com"
    : PLAID_ENV === "development"
    ? "https://development.plaid.com"
    : "https://sandbox.plaid.com";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   APP SETUP
========================= */

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   HELPERS
========================= */

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

async function getAuthedUser(req) {
  const token = getBearerToken(req);
  if (!token) return { user: null, error: "Falta Authorization Bearer token" };

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, error: error?.message || "Token inválido" };
  }

  return { user: data.user, error: null };
}

async function requireAuth(req, res, next) {
  try {
    const { user, error } = await getAuthedUser(req);
    if (error || !user) {
      return res.status(401).json({ ok: false, error: error || "No autenticado" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message || "No autenticado" });
  }
}

function isCronAuthorized(req) {
  const received = req.headers["x-cron-secret"] || "";
  return !!CRON_SECRET && received === CRON_SECRET;
}

async function plaidRequest(endpoint, body) {
  const { data } = await axios.post(`${PLAID_BASE_URL}${endpoint}`, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });
  return data;
}

async function getUserPreferencesRow(userId) {
  const { data, error } = await supabaseAdmin
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;

  return {
    user_id: userId,
    strategy: data?.strategy || "avalanche",
    execution_mode: data?.execution_mode || "safe",
    extra_payment_default: safeNumber(data?.extra_payment_default, 0),
    monthly_budget_default: safeNumber(data?.monthly_budget_default, 0),
    updated_at: data?.updated_at || new Date().toISOString(),
  };
}

async function getCurrentPaymentPlanRow(userId) {
  const { data, error } = await supabaseAdmin
    .from("payment_plans")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

async function getUserPlaidAccessToken(userId) {
  const { data, error } = await supabaseAdmin
    .from("plaid_items")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  if (!data?.access_token) throw new Error("Usuario sin access_token de Plaid");

  return data.access_token;
}

async function tryRpcVariants(name, variants) {
  let lastError = null;

  for (const args of variants) {
    const { data, error } = await supabaseAdmin.rpc(name, args);
    if (!error) return { ok: true, data, args };
    lastError = error;
  }

  return { ok: false, error: lastError };
}

async function tryBuildIntentsForUser(userId) {
  return tryRpcVariants("build_intents_v2", [
    { p_user_id: userId },
    { user_id: userId },
    { p_user: userId },
  ]);
}

async function tryApproveIntent(intentId, userId) {
  return tryRpcVariants("approve_intent_v2", [
    { p_intent_id: intentId, p_user_id: userId },
    { intent_id: intentId, user_id: userId },
    { p_payment_intent_id: intentId, p_user_id: userId },
  ]);
}

async function tryExecuteIntent(intentId, userId) {
  return tryRpcVariants("execute_intent_v2", [
    { p_intent_id: intentId, p_user_id: userId },
    { intent_id: intentId, user_id: userId },
    { p_payment_intent_id: intentId, p_user_id: userId },
  ]);
}

async function tryApplyRules(userId) {
  return tryRpcVariants("apply_rules_v2", [
    { p_user_id: userId },
    { user_id: userId },
    { p_user: userId },
  ]);
}

async function tryAutoSweep(userId) {
  return tryRpcVariants("auto_sweep_v2", [
    { p_user_id: userId },
    { user_id: userId },
    { p_user: userId },
  ]);
}

async function getPendingOrApprovedIntents(userId) {
  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["pending", "built", "created", "ready", "draft", "approved"])
    .order("created_at", { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/* =========================
   HEALTH
========================= */

app.get("/health", async (_req, res) => {
  return res.json({
    ok: true,
    message: "DebtYa API funcionando",
    now: new Date().toISOString(),
    env_debug: {
      has_supabase_url: !!SUPABASE_URL,
      has_anon_key: !!SUPABASE_ANON_KEY,
      has_service_role_key: !!SUPABASE_SERVICE_ROLE_KEY,
      has_plaid_client_id: !!PLAID_CLIENT_ID,
      has_plaid_secret: !!PLAID_SECRET,
      has_cron_secret: !!CRON_SECRET,
      plaid_env: PLAID_ENV,
      is_render: IS_RENDER,
    },
  });
});

/* =========================
   AUTH TEST
========================= */

app.get("/me", requireAuth, async (req, res) => {
  return res.json({
    ok: true,
    data: {
      id: req.user.id,
      email: req.user.email,
    },
  });
});

/* =========================
   PREFERENCES
========================= */

app.get("/preferences", requireAuth, async (req, res) => {
  try {
    const row = await getUserPreferencesRow(req.user.id);
    return res.json({ ok: true, data: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando preferencias" });
  }
});

app.post("/preferences", requireAuth, async (req, res) => {
  try {
    const payload = {
      user_id: req.user.id,
      strategy: ["avalanche", "snowball"].includes(String(req.body.strategy || "").toLowerCase())
        ? String(req.body.strategy).toLowerCase()
        : "avalanche",
      execution_mode: ["safe", "full_auto"].includes(String(req.body.execution_mode || "").toLowerCase())
        ? String(req.body.execution_mode).toLowerCase()
        : "safe",
      extra_payment_default: safeNumber(req.body.extra_payment_default, 0),
      monthly_budget_default: safeNumber(req.body.monthly_budget_default, 0),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("user_preferences")
      .upsert(payload, { onConflict: "user_id" })
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error guardando preferencias" });
  }
});

/* =========================
   PAYMENT PLANS
========================= */

app.get("/payment-plans/current", requireAuth, async (req, res) => {
  try {
    const row = await getCurrentPaymentPlanRow(req.user.id);
    return res.json({ ok: true, data: row });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando payment plan" });
  }
});

app.get("/payment-plans", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("payment_plans")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando payment plans" });
  }
});

app.post("/payment-plans", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    await supabaseAdmin
      .from("payment_plans")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("is_active", true);

    const payload = {
      user_id: userId,
      name: (req.body.name || "Plan principal").trim(),
      plan_type: ["monthly", "weekly"].includes(String(req.body.plan_type || "").toLowerCase())
        ? String(req.body.plan_type).toLowerCase()
        : "monthly",
      budget: safeNumber(req.body.budget, 0),
      target_day: req.body.target_day ? Number(req.body.target_day) : null,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("payment_plans")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error guardando payment plan" });
  }
});

/* =========================
   RULES
========================= */

app.get("/rules", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("micro_rules")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando reglas" });
  }
});

app.post("/rules", requireAuth, async (req, res) => {
  try {
    const payload = {
      user_id: req.user.id,
      name: (req.body.name || "Regla").trim(),
      keyword: (req.body.keyword || "").trim(),
      percent: safeNumber(req.body.percent, 0),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("micro_rules")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error guardando regla" });
  }
});

app.post("/rules/apply", requireAuth, async (req, res) => {
  try {
    const out = await tryApplyRules(req.user.id);
    if (!out.ok) {
      return res.status(500).json({ ok: false, error: out.error?.message || "apply_rules_v2 falló" });
    }
    return res.json({ ok: true, data: out.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error aplicando reglas" });
  }
});

/* =========================
   PLAID
========================= */

app.post("/plaid/create_link_token", requireAuth, async (req, res) => {
  try {
    const baseUrl =
      process.env.APP_BASE_URL ||
      process.env.PUBLIC_APP_URL ||
      `https://${req.headers.host}`;

    const data = await plaidRequest("/link/token/create", {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      client_name: "DebtYa",
      country_codes: PLAID_COUNTRY_CODES,
      language: "es",
      user: { client_user_id: req.user.id },
      products: PLAID_PRODUCTS,
      webhooks: null,
      redirect_uri: process.env.PLAID_REDIRECT_URI || undefined,
      account_filters: undefined,
      android_package_name: undefined,
    });

    return res.json({ ok: true, link_token: data.link_token, base_url: baseUrl });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.response?.data?.error_message || err.message || "Error creando link token",
    });
  }
});

app.post("/plaid/web", requireAuth, async (req, res) => {
  try {
    const data = await plaidRequest("/link/token/create", {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      client_name: "DebtYa",
      country_codes: PLAID_COUNTRY_CODES,
      language: "es",
      user: { client_user_id: req.user.id },
      products: PLAID_PRODUCTS,
    });

    return res.json({ ok: true, link_token: data.link_token });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.response?.data?.error_message || err.message || "Error creando link token",
    });
  }
});

app.post("/plaid/exchange_public_token", requireAuth, async (req, res) => {
  try {
    const publicToken = req.body.public_token;
    if (!publicToken) {
      return res.status(400).json({ ok: false, error: "Falta public_token" });
    }

    const exchange = await plaidRequest("/item/public_token/exchange", {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      public_token: publicToken,
    });

    const itemPayload = {
      user_id: req.user.id,
      plaid_item_id: exchange.item_id,
      access_token: exchange.access_token,
      institution_id: req.body?.metadata?.institution?.institution_id || null,
      institution_name: req.body?.metadata?.institution?.name || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabaseAdmin
      .from("plaid_items")
      .upsert(itemPayload, { onConflict: "plaid_item_id" })
      .select();

    if (error) throw error;

    return res.json({
      ok: true,
      item_id: exchange.item_id,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.response?.data?.error_message || err.message || "Error intercambiando public token",
    });
  }
});

app.get("/plaid/accounts", requireAuth, async (req, res) => {
  try {
    const accessToken = await getUserPlaidAccessToken(req.user.id);

    const data = await plaidRequest("/accounts/get", {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token: accessToken,
    });

    const accounts = Array.isArray(data.accounts)
      ? data.accounts.map((a) => ({
          id: a.account_id,
          account_id: a.account_id,
          name: a.name,
          official_name: a.official_name,
          subtype: a.subtype,
          type: a.type,
          mask: a.mask,
          current_balance: safeNumber(a.balances?.current, 0),
          available_balance: safeNumber(a.balances?.available, 0),
          balances: a.balances || {},
        }))
      : [];

    return res.json({ ok: true, data: accounts });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.response?.data?.error_message || err.message || "Error cargando cuentas de Plaid",
    });
  }
});

app.post("/plaid/accounts", requireAuth, async (req, res) => {
  req.method = "GET";
  return app._router.handle(req, res, () => {});
});

app.post("/plaid/transactions/sync", requireAuth, async (req, res) => {
  try {
    const accessToken = await getUserPlaidAccessToken(req.user.id);

    let cursor = null;
    let added = [];
    let hasMore = true;
    let loops = 0;

    while (hasMore && loops < 20) {
      loops += 1;

      const sync = await plaidRequest("/transactions/sync", {
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token: accessToken,
        cursor,
      });

      added = added.concat(sync.added || []);
      cursor = sync.next_cursor || cursor;
      hasMore = !!sync.has_more;
    }

    const rows = added.map((t) => ({
      user_id: req.user.id,
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount: safeNumber(t.amount, 0),
      date: t.date || null,
      name: t.name || null,
      merchant_name: t.merchant_name || null,
      category_primary: Array.isArray(t.category) && t.category.length ? t.category[0] : null,
      raw_json: t,
      updated_at: new Date().toISOString(),
    }));

    if (rows.length) {
      const { error } = await supabaseAdmin
        .from("transactions_raw")
        .upsert(rows, { onConflict: "transaction_id" });

      if (error) throw error;
    }

    return res.json({
      ok: true,
      added_count: rows.length,
      data: rows,
      next_cursor: cursor,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.response?.data?.error_message || err.message || "Error sincronizando transacciones",
    });
  }
});

app.get("/plaid/transactions", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("transactions_raw")
      .select("*")
      .eq("user_id", req.user.id)
      .order("date", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando transacciones" });
  }
});

app.get("/transactions", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("transactions_raw")
      .select("*")
      .eq("user_id", req.user.id)
      .order("date", { ascending: false })
      .limit(100);

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando transacciones" });
  }
});

/* =========================
   DEBTS / STRATEGY
========================= */

app.get("/debts", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("debts")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando deudas" });
  }
});

app.get("/strategy/compare", requireAuth, async (req, res) => {
  try {
    const { data: debts, error } = await supabaseAdmin
      .from("debts")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("is_active", true);

    if (error) throw error;

    const list = Array.isArray(debts) ? debts : [];
    if (!list.length) {
      return res.json({
        ok: true,
        data: {
          avalanche: { months_to_payoff: 0, total_interest: 0 },
          snowball: { months_to_payoff: 0, total_interest: 0 },
        },
      });
    }

    const totalBalance = list.reduce((s, d) => s + safeNumber(d.balance, 0), 0);
    const avgApr = list.length
      ? list.reduce((s, d) => s + safeNumber(d.apr, 0), 0) / list.length
      : 0;

    const avalancheMonths = Math.max(1, Math.ceil(totalBalance / Math.max(1, list.reduce((s, d) => s + safeNumber(d.minimum_payment || d.minimum, 0), 0))));
    const snowballMonths = Math.max(1, avalancheMonths + (list.length > 1 ? 1 : 0));

    const avalancheInterest = totalBalance * (avgApr / 100) * 0.45;
    const snowballInterest = totalBalance * (avgApr / 100) * 0.52;

    return res.json({
      ok: true,
      data: {
        avalanche: {
          months_to_payoff: avalancheMonths,
          total_interest: Number(avalancheInterest.toFixed(2)),
        },
        snowball: {
          months_to_payoff: snowballMonths,
          total_interest: Number(snowballInterest.toFixed(2)),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error comparando estrategias" });
  }
});

/* =========================
   INTENTS
========================= */

app.get("/payment-intents", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando payment intents" });
  }
});

app.post("/payment-intents/build", requireAuth, async (req, res) => {
  try {
    const out = await tryBuildIntentsForUser(req.user.id);
    if (!out.ok) {
      return res.status(500).json({ ok: false, error: out.error?.message || "build_intents_v2 falló" });
    }
    return res.json({ ok: true, data: out.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error construyendo intents" });
  }
});

app.post("/payment-intents/:intentId/approve", requireAuth, async (req, res) => {
  try {
    const out = await tryApproveIntent(req.params.intentId, req.user.id);
    if (!out.ok) {
      return res.status(500).json({ ok: false, error: out.error?.message || "approve_intent_v2 falló" });
    }
    return res.json({ ok: true, data: out.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error aprobando intent" });
  }
});

app.post("/payment-intents/:intentId/execute", requireAuth, async (req, res) => {
  try {
    const out = await tryExecuteIntent(req.params.intentId, req.user.id);
    if (!out.ok) {
      return res.status(500).json({ ok: false, error: out.error?.message || "execute_intent_v2 falló" });
    }
    return res.json({ ok: true, data: out.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error ejecutando intent" });
  }
});

/* =========================
   HISTORY / TRACE
========================= */

app.get("/payment-executions", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("payment_executions")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (!error) {
      return res.json({ ok: true, data: Array.isArray(data) ? data : [] });
    }

    const trace = await supabaseAdmin
      .from("v_payment_trace")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (trace.error) throw trace.error;

    return res.json({ ok: true, data: Array.isArray(trace.data) ? trace.data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando historial" });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    const trace = await supabaseAdmin
      .from("v_payment_trace")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (trace.error) throw trace.error;

    return res.json({ ok: true, data: Array.isArray(trace.data) ? trace.data : [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error cargando historial" });
  }
});

/* =========================
   CRON SAFE / FULL AUTO
========================= */

async function runFullAutoForUser(userId) {
  const summary = {
    user_id: userId,
    mode: "full_auto",
    skipped: false,
    built: false,
    approved: 0,
    executed: 0,
    notes: [],
  };

  const prefs = await getUserPreferencesRow(userId);

  if (prefs.execution_mode !== "full_auto") {
    summary.skipped = true;
    summary.notes.push("Usuario en modo safe. No se ejecuta automáticamente.");
    return summary;
  }

  const autoSweep = await tryAutoSweep(userId);
  if (autoSweep.ok) {
    summary.notes.push("auto_sweep_v2 ejecutado correctamente.");
    summary.built = true;
    return summary;
  }

  summary.notes.push(
    `auto_sweep_v2 no disponible o falló: ${autoSweep.error?.message || "sin detalle"}`
  );

  const applyRules = await tryApplyRules(userId);
  if (applyRules.ok) {
    summary.notes.push("apply_rules_v2 ejecutado correctamente.");
  } else {
    summary.notes.push(`apply_rules_v2 falló: ${applyRules.error?.message || "sin detalle"}`);
  }

  const build = await tryBuildIntentsForUser(userId);
  if (build.ok) {
    summary.built = true;
    summary.notes.push("build_intents_v2 ejecutado correctamente.");
  } else {
    summary.notes.push(`build_intents_v2 falló: ${build.error?.message || "sin detalle"}`);
  }

  const intents = await getPendingOrApprovedIntents(userId);

  for (const intent of intents) {
    const status = String(intent.status || "").toLowerCase();

    if (["pending", "built", "created", "ready", "draft"].includes(status)) {
      const approve = await tryApproveIntent(intent.id, userId);
      if (approve.ok) {
        summary.approved += 1;
        summary.notes.push(`Intent aprobado: ${intent.id}`);
      } else {
        summary.notes.push(`No se pudo aprobar ${intent.id}: ${approve.error?.message || "sin detalle"}`);
        continue;
      }
    }

    const execute = await tryExecuteIntent(intent.id, userId);
    if (execute.ok) {
      summary.executed += 1;
      summary.notes.push(`Intent ejecutado: ${intent.id}`);
    } else {
      summary.notes.push(`No se pudo ejecutar ${intent.id}: ${execute.error?.message || "sin detalle"}`);
    }
  }

  return summary;
}

app.post("/cron/full-auto", async (req, res) => {
  if (!isCronAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const startedAt = new Date().toISOString();

    const { data: prefsRows, error: prefsError } = await supabaseAdmin
      .from("user_preferences")
      .select("user_id, execution_mode")
      .eq("execution_mode", "full_auto");

    if (prefsError) throw prefsError;

    const users = Array.isArray(prefsRows) ? prefsRows : [];
    const results = [];

    let successUsers = 0;
    let failedUsers = 0;
    let intentsExecuted = 0;

    for (const row of users) {
      try {
        const summary = await runFullAutoForUser(row.user_id);
        results.push(summary);
        successUsers += 1;
        intentsExecuted += safeNumber(summary.executed, 0);
      } catch (err) {
        results.push({
          user_id: row.user_id,
          mode: "full_auto",
          skipped: false,
          built: false,
          approved: 0,
          executed: 0,
          notes: [err.message || "Error ejecutando full auto"],
        });
        failedUsers += 1;
      }
    }

    return res.json({
      ok: true,
      ran_at: startedAt,
      total_users: users.length,
      success_users: successUsers,
      failed_users: failedUsers,
      intents_executed: intentsExecuted,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Error ejecutando cron full-auto",
    });
  }
});

/* =========================
   FALLBACK WEB
========================= */

app.get("*", (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor DebtYa corriendo en puerto ${PORT}`);
});