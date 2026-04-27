require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { registerAllRoutes } = require("./routes");
const { attachStripeWebhook } = require("./routes/stripe-webhook-routes");
const { isUuid } = require("./lib/validation");
const { requestIdMiddleware } = require("./lib/request-id");
const { jsonError } = require("./lib/json-error");
const { readMethodKeyStatus, readMethodEnv, readMethodApiVersion } = require("./lib/method-env");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const SERVER_VERSION = "debtya-2026-04-26-v31-fix-mobile-step-order";

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

/** Misma clave anon publica que public/index.html (Supabase). Si Render no tiene SUPABASE_ANON_KEY, el login no debe romperse. */
const DEBTYA_EMBEDDED_SUPABASE_ANON_FALLBACK =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNweWJlamx0c2d6Znhsd3pvYmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMzg3MDAsImV4cCI6MjA4NzcxNDcwMH0.gNcD19qAbc4fO0HnE7fK3yFLBq2NWlcyBq8LnokbmOs";

const SUPABASE_ANON_KEY_EFFECTIVE =
  String(SUPABASE_ANON_KEY || "").trim() || DEBTYA_EMBEDDED_SUPABASE_ANON_FALLBACK;

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
    },
    exposedHeaders: ["Debtya-Api-Base", "X-Debtya-Server-Version"]
  })
);

app.use((req, res, next) => {
  res.setHeader("X-Debtya-Server-Version", SERVER_VERSION);
  next();
});

app.use(requestIdMiddleware);

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

const PUBLIC_INDEX_HTML = path.join(__dirname, "public", "index.html");
const PUBLIC_PASSWORD_RESET_HTML = path.join(__dirname, "public", "password-reset.html");
const PUBLIC_BANK_STRIP_JS = path.join(__dirname, "public", "debtya-bank-strip.js");

/**
 * Si DEBTYA_PUBLIC_API_URL o PASSWORD_RESET_LINK_BASE estan definidos, inyecta window.__DEBTYA_API_BASE__
 * para que fetch() no use solo location.origin (www estatico sin /auth/* en Node).
 */
function injectDebtyaApiBaseIntoHtml(html) {
  const base = String(process.env.DEBTYA_PUBLIC_API_URL || process.env.PASSWORD_RESET_LINK_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return html;
  const s = String(html || "");
  if (/\b__DEBTYA_API_BASE__\b/.test(s)) return s;
  const script = `    <script>window.__DEBTYA_API_BASE__=${JSON.stringify(base)};<\/script>\n`;
  return s.replace(/<head(\s[^>]*)?>/i, (full) => `${full}\n${script}`);
}

function injectIntoIndexHtml(html) {
  return injectDebtyaApiBaseIntoHtml(html);
}

function sendNoCacheIndexHtml(res) {
  res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  try {
    const html = injectIntoIndexHtml(fs.readFileSync(PUBLIC_INDEX_HTML, "utf8"));
    res.type("html");
    return res.send(html);
  } catch (e) {
    appError("sendNoCacheIndexHtml:", e?.message || e);
    return res.sendFile(PUBLIC_INDEX_HTML);
  }
}

function sendSpaFallbackIndexHtml(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  try {
    const html = injectIntoIndexHtml(fs.readFileSync(PUBLIC_INDEX_HTML, "utf8"));
    res.type("html");
    return res.send(html);
  } catch (e) {
    appError("sendSpaFallbackIndexHtml:", e?.message || e);
    return res.sendFile(PUBLIC_INDEX_HTML);
  }
}

app.get("/", (_req, res) => sendNoCacheIndexHtml(res));
app.get("/index.html", (_req, res) => sendNoCacheIndexHtml(res));

app.get("/debtya-version.txt", (_req, res) => {
  res.type("text/plain");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  res.setHeader("Surrogate-Control", "no-store");
  return res.send(`${SERVER_VERSION}\n`);
});

function sendPlaidManageDisconnectHtml(res) {
  try {
    const htmlPath = path.join(__dirname, "public", "plaid-manage-disconnect.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("Surrogate-Control", "no-store");
    res.type("html");
    return res.status(200).send(html);
  } catch (e) {
    appError("plaid/manage-disconnect:", e?.message || e);
    return res
      .status(500)
      .type("html")
      .send(
        "<!DOCTYPE html><html><body><p>No se pudo cargar la página (falta public/plaid-manage-disconnect.html en el servidor).</p></body></html>"
      );
  }
}

app.get("/plaid/manage-disconnect", (_req, res) => sendPlaidManageDisconnectHtml(res));
app.get("/disconnect-bank.html", (_req, res) => sendPlaidManageDisconnectHtml(res));
app.get("/bank-disconnect", (_req, res) => sendPlaidManageDisconnectHtml(res));
app.get("/api/bank-disconnect", (_req, res) => sendPlaidManageDisconnectHtml(res));
app.get("/api/plaid/manage-disconnect", (_req, res) => sendPlaidManageDisconnectHtml(res));
// Trailing slash (Render / enlaces a veces piden …/bank-disconnect/)
app.get("/plaid/manage-disconnect/", (_req, res) => res.redirect(308, "/plaid/manage-disconnect"));
app.get("/disconnect-bank.html/", (_req, res) => res.redirect(308, "/disconnect-bank.html"));
app.get("/bank-disconnect/", (_req, res) => res.redirect(308, "/bank-disconnect"));
app.get("/api/bank-disconnect/", (_req, res) => res.redirect(308, "/api/bank-disconnect"));
app.get("/api/plaid/manage-disconnect/", (_req, res) => res.redirect(308, "/api/plaid/manage-disconnect"));

function sendPasswordResetStandaloneHtml(res) {
  res.setHeader("Cache-Control", "private, no-store, no-cache, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  try {
    const html = injectDebtyaApiBaseIntoHtml(fs.readFileSync(PUBLIC_PASSWORD_RESET_HTML, "utf8"));
    res.type("html");
    return res.send(html);
  } catch (e) {
    appError("sendPasswordResetStandaloneHtml:", e?.message || e);
    return res.sendFile(PUBLIC_PASSWORD_RESET_HTML);
  }
}

app.get("/password-reset.html", (_req, res) => sendPasswordResetStandaloneHtml(res));

app.get("/debtya-bank-strip.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  res.setHeader("Surrogate-Control", "no-store");
  res.type("application/javascript");
  try {
    return res.send(fs.readFileSync(PUBLIC_BANK_STRIP_JS, "utf8"));
  } catch (e) {
    appError("debtya-bank-strip.js:", e?.message || e);
    return res.status(404).type("text/plain").send("// debtya-bank-strip.js missing on server");
  }
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      const normalized = String(filePath || "").replace(/\\/g, "/");
      if (normalized.endsWith("/index.html") || normalized.endsWith("/legal.html")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
        res.setHeader("CDN-Cache-Control", "no-store");
      }
      if (normalized.endsWith("debtya-bank-strip.js")) {
        res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
        res.setHeader("Surrogate-Control", "no-store");
      }
    }
  })
);

const supabaseAnon =
  SUPABASE_URL && SUPABASE_ANON_KEY_EFFECTIVE
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY_EFFECTIVE)
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

function stripInvisible(s) {
  return String(s || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/** Codigos separados por coma en DEBTYA_COMP_PROMO_CODES o uno solo en DEBTYA_COMP_PROMO_CODE. */
function parseCompPromoCodes() {
  let raw = stripInvisible(String(process.env.DEBTYA_COMP_PROMO_CODES || "").trim());
  const single = stripInvisible(String(process.env.DEBTYA_COMP_PROMO_CODE || "").trim());
  if (!raw && single) raw = single;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw
    .split(",")
    .map((s) =>
      stripInvisible(String(s).trim())
        .replace(/\r$/, "")
        .replace(/^["']|["']$/g, "")
        .trim()
    )
    .filter((s) => s.length > 0);
}

/** UUID v4 estable por usuario (valido si stripe_subscription_id es tipo uuid en Postgres). */
function getSyntheticCompSubscriptionId(userId) {
  const digest = crypto.createHash("sha256").update(`debtya_comp_promo|${userId}`).digest();
  const buf = Buffer.alloc(16);
  digest.copy(buf, 0, 0, 16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function rawJsonSource(row) {
  const r = row?.raw_json;
  if (!r) return null;
  const obj =
    typeof r === "string"
      ? (() => {
          try {
            return JSON.parse(r);
          } catch {
            return null;
          }
        })()
      : r;
  return obj && typeof obj === "object" ? obj.source || null : null;
}

function isCompSubscriptionRow(row) {
  if (!row) return false;
  if (rawJsonSource(row) === "debtya_comp_promo") return true;
  if (row.stripe_price_id === "comp") return true;
  if (String(row.stripe_subscription_id || "").startsWith("debtya_promo_")) return true;
  return false;
}

function getCompPromoMeta() {
  const list = parseCompPromoCodes();
  return { configured: list.length > 0, count: list.length };
}

function promoCodeMatchesConfigured(input, codes) {
  const clean = stripInvisible(String(input || "").trim()).toLowerCase();
  if (!clean) return false;
  return codes.some((c) => stripInvisible(c).toLowerCase() === clean);
}

/**
 * Activa plan complementario en billing_subscriptions (sin Stripe).
 * @returns {Promise<{ ok: boolean, status?: number, message?: string, already?: boolean }>}
 */
async function redeemCompPromoForUser(userId, code) {
  if (!supabaseAdmin) {
    return { ok: false, status: 500, message: "Supabase no configurado" };
  }

  const codes = parseCompPromoCodes();
  if (!codes.length) {
    return {
      ok: false,
      status: 503,
      message: "Canje de codigos no configurado en el servidor"
    };
  }

  const normalized = stripInvisible(String(code || "").trim());
  if (!normalized) {
    return { ok: false, status: 400, message: "Ingresa un codigo" };
  }

  if (!promoCodeMatchesConfigured(normalized, codes)) {
    return { ok: false, status: 400, message: "Codigo invalido" };
  }

  const row = await getLatestBillingSubscriptionForUser(userId);
  if (row?.active && row.stripe_subscription_id && String(row.stripe_subscription_id).startsWith("sub_")) {
    return {
      ok: false,
      status: 409,
      message: "Ya tienes una suscripcion de pago activa"
    };
  }

  if (row?.active && isCompSubscriptionRow(row)) {
    return { ok: true, already: true };
  }

  const syntheticId = getSyntheticCompSubscriptionId(userId);
  const farEnd = new Date();
  farEnd.setUTCFullYear(farEnd.getUTCFullYear() + 100);

  const payload = {
    user_id: userId,
    stripe_customer_id: row?.stripe_customer_id || null,
    stripe_subscription_id: syntheticId,
    stripe_price_id: null,
    status: "active",
    active: true,
    current_period_end: farEnd.toISOString(),
    cancel_at_period_end: false,
    last_event_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_json: { source: "debtya_comp_promo", redeemed_at: new Date().toISOString() }
  };

  const persistResult = await persistCompPromoSubscriptionRow(payload, syntheticId);
  if (!persistResult.ok) {
    const hint =
      persistResult.error?.message ||
      persistResult.error?.details ||
      String(persistResult.error || "");
    return {
      ok: false,
      status: 500,
      message: hint ? `No se pudo activar el acceso: ${hint}` : "No se pudo activar el acceso"
    };
  }

  return { ok: true, already: false };
}

/** Insert o update sin depender de onConflict (evita errores si el indice unico difiere). */
async function persistCompPromoSubscriptionRow(payload, syntheticId) {
  try {
    const { data: existing, error: selErr } = await supabaseAdmin
      .from("billing_subscriptions")
      .select("stripe_subscription_id")
      .eq("stripe_subscription_id", syntheticId)
      .maybeSingle();

    if (selErr) throw selErr;

    const updateFields = {
      user_id: payload.user_id,
      stripe_customer_id: payload.stripe_customer_id,
      stripe_price_id: payload.stripe_price_id,
      status: payload.status,
      active: payload.active,
      current_period_end: payload.current_period_end,
      cancel_at_period_end: payload.cancel_at_period_end,
      last_event_at: payload.last_event_at,
      updated_at: payload.updated_at,
      raw_json: payload.raw_json
    };

    if (existing?.stripe_subscription_id) {
      const { error: upErr } = await supabaseAdmin
        .from("billing_subscriptions")
        .update(updateFields)
        .eq("stripe_subscription_id", syntheticId);
      if (upErr) throw upErr;
      return { ok: true, error: null };
    }

    const { error: insErr } = await supabaseAdmin.from("billing_subscriptions").insert(payload);
    if (insErr) {
      const dup =
        insErr.code === "23505" ||
        String(insErr.message || "")
          .toLowerCase()
          .includes("duplicate");
      if (dup) {
        const { data: rows, error: listErr } = await supabaseAdmin
          .from("billing_subscriptions")
          .select("id, stripe_subscription_id, raw_json")
          .eq("user_id", payload.user_id)
          .order("updated_at", { ascending: false })
          .limit(3);
        if (listErr) throw listErr;
        const target =
          (rows || []).find((r) => isCompSubscriptionRow(r)) ||
          (rows || []).find((r) => !String(r.stripe_subscription_id || "").startsWith("sub_")) ||
          (rows || [])[0];
        if (!target?.id) throw insErr;
        const { error: up2 } = await supabaseAdmin
          .from("billing_subscriptions")
          .update({
            ...updateFields,
            stripe_subscription_id: syntheticId
          })
          .eq("id", target.id);
        if (up2) throw up2;
        return { ok: true, error: null };
      }
      throw insErr;
    }
    return { ok: true, error: null };
  } catch (e) {
    stripeError("[COMP_PROMO] persist billing_subscriptions", {
      message: e.message,
      details: e.details || null,
      code: e.code || null
    });
    return { ok: false, error: e };
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
    return { ok: true, data, error: null };
  } catch (e) {
    stripeError("No se pudo guardar billing_subscriptions:", {
      message: e.message,
      details: e.details || null,
      hint: e.hint || null,
      code: e.code || null,
      stripe_subscription_id: payload?.stripe_subscription_id || null,
      user_id: payload?.user_id || null
    });
    return { ok: false, data: null, error: e };
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

  const upsertOut = await upsertBillingSubscriptionRow(payload);
  const saved = upsertOut.ok ? upsertOut.data : null;

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

function normalizePlaidConnectionRole(value) {
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  if (s === "funding" || s === "pay_from" || s === "origin" || s === "origen") return "funding";
  if (
    s === "liabilities" ||
    s === "debts" ||
    s === "paydown" ||
    s === "destino" ||
    s === "deudas"
  ) {
    return "liabilities";
  }
  if (s === "both" || s === "ambos") return "both";
  return "unspecified";
}

function isMissingTableColumnError(error, table, column) {
  const msg = String(error?.message || error?.details || error || "").toLowerCase();
  const t = String(table || "").toLowerCase();
  const c = String(column || "").toLowerCase();
  if (!t || !c) return false;
  if (!msg.includes(c) || !msg.includes(t)) return false;
  const code = String(error?.code || "");
  return (
    code === "42703" ||
    msg.includes("schema cache") ||
    msg.includes("could not find") ||
    msg.includes("does not exist") ||
    msg.includes("undefined column")
  );
}

async function disconnectPlaidItemForUser(userId, plaidItemId) {
  const itemId = String(plaidItemId || "").trim();
  if (!itemId) {
    const err = new Error("plaid_item_id invalido");
    err.status = 400;
    throw err;
  }

  const [itemRes, acctRes, txProbeRes] = await Promise.all([
    supabaseAdmin
      .from("plaid_items")
      .select("id,access_token,plaid_item_id")
      .eq("user_id", userId)
      .eq("plaid_item_id", itemId)
      .maybeSingle(),
    supabaseAdmin
      .from("accounts")
      .select("plaid_account_id")
      .eq("user_id", userId)
      .eq("plaid_item_id", itemId),
    supabaseAdmin
      .from("transactions_raw")
      .select("id")
      .eq("user_id", userId)
      .eq("plaid_item_id", itemId)
      .limit(1)
  ]);

  const itemRow = itemRes.data;
  if (itemRes.error) throw itemRes.error;

  const acctRows = acctRes.data || [];
  if (acctRes.error) throw acctRes.error;

  const txProbe = txProbeRes.data || [];
  if (txProbeRes.error) throw txProbeRes.error;

  const hasOrphanLocal = acctRows.length > 0 || txProbe.length > 0;

  if (!itemRow?.id && !hasOrphanLocal) {
    const err = new Error("Conexion bancaria no encontrada");
    err.status = 404;
    throw err;
  }

  if (plaidClient && itemRow?.access_token) {
    try {
      await plaidClient.itemRemove({ access_token: itemRow.access_token });
    } catch (e) {
      appDebug("itemRemove (continuando limpieza local):", e?.response?.data || e?.message || e);
    }
  }

  const plaidAccountIds = (acctRows || [])
    .map((r) => String(r.plaid_account_id || "").trim())
    .filter(Boolean);

  const now = new Date().toISOString();

  if (plaidAccountIds.length) {
    const uuidAccountIds = plaidAccountIds.filter((id) => isUuid(id));
    const plaidStyleAccountIds = plaidAccountIds.filter((id) => !isUuid(id));

    if (uuidAccountIds.length) {
      const { error: debtErr } = await supabaseAdmin
        .from("debts")
        .update({ linked_plaid_account_id: null, updated_at: now })
        .eq("user_id", userId)
        .in("linked_plaid_account_id", uuidAccountIds);

      if (debtErr) {
        if (isMissingTableColumnError(debtErr, "debts", "linked_plaid_account_id")) {
          appDebug(
            "disconnectPlaidItemForUser: columna debts.linked_plaid_account_id ausente; omitiendo limpieza de vinculos. Ejecutar sql/add_debts_linked_plaid_account_id.sql en Supabase."
          );
        } else {
          throw debtErr;
        }
      }
    }

    if (plaidStyleAccountIds.length) {
      const plaidSet = new Set(plaidStyleAccountIds);
      const { data: debtsForClear, error: debtSelErr } = await supabaseAdmin
        .from("debts")
        .select("id,linked_plaid_account_id")
        .eq("user_id", userId);

      if (debtSelErr) {
        if (isMissingTableColumnError(debtSelErr, "debts", "linked_plaid_account_id")) {
          appDebug(
            "disconnectPlaidItemForUser: columna debts.linked_plaid_account_id ausente; omitiendo limpieza de vinculos (select)."
          );
        } else {
          throw debtSelErr;
        }
      } else {
        const debtIdsToClear = (debtsForClear || [])
          .filter((row) => {
            if (!row?.id) return false;
            const lid =
              row.linked_plaid_account_id != null
                ? String(row.linked_plaid_account_id).trim()
                : "";
            return lid && plaidSet.has(lid);
          })
          .map((row) => row.id)
          .filter((id) => isUuid(id));

        const chunkD = 80;
        for (let i = 0; i < debtIdsToClear.length; i += chunkD) {
          const slice = debtIdsToClear.slice(i, i + chunkD);
          const { error: debtBulkErr } = await supabaseAdmin
            .from("debts")
            .update({ linked_plaid_account_id: null, updated_at: now })
            .eq("user_id", userId)
            .in("id", slice);

          if (debtBulkErr) {
            if (isMissingTableColumnError(debtBulkErr, "debts", "linked_plaid_account_id")) {
              appDebug(
                "disconnectPlaidItemForUser: columna debts.linked_plaid_account_id ausente; omitiendo limpieza de vinculos (bulk)."
              );
              break;
            }
            throw debtBulkErr;
          }
        }
      }
    }

    if (uuidAccountIds.length) {
      const { error: intentErr } = await supabaseAdmin
        .from("payment_intents")
        .update({ source_account_id: null, updated_at: now })
        .eq("user_id", userId)
        .in("source_account_id", uuidAccountIds);

      if (intentErr) throw intentErr;
    }

    if (plaidStyleAccountIds.length) {
      const plaidSet = new Set(plaidStyleAccountIds);
      const { data: intentsForClear, error: intentSelErr } = await supabaseAdmin
        .from("payment_intents")
        .select("id,source_account_id")
        .eq("user_id", userId);

      if (intentSelErr) throw intentSelErr;

      const intentIdsToClear = (intentsForClear || [])
        .filter((row) => {
          if (!row?.id) return false;
          const sid =
            row.source_account_id != null ? String(row.source_account_id).trim() : "";
          return sid && plaidSet.has(sid);
        })
        .map((row) => row.id)
        .filter((id) => isUuid(id));

      const chunk = 80;
      for (let i = 0; i < intentIdsToClear.length; i += chunk) {
        const slice = intentIdsToClear.slice(i, i + chunk);
        const { error: intentBulkErr } = await supabaseAdmin
          .from("payment_intents")
          .update({ source_account_id: null, updated_at: now })
          .eq("user_id", userId)
          .in("id", slice);

        if (intentBulkErr) throw intentBulkErr;
      }
    }
  }

  const { data: planRows, error: planErr } = await supabaseAdmin
    .from("payment_plans")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (planErr) throw planErr;

  const latestPlan = planRows?.[0];
  if (latestPlan?.id) {
    const payload =
      latestPlan.payload_json && typeof latestPlan.payload_json === "object"
        ? { ...latestPlan.payload_json }
        : {};
    const fund = String(payload.funding_plaid_account_id || "").trim();
    if (fund && plaidAccountIds.includes(fund)) {
      payload.funding_plaid_account_id = null;
      const { error: planUpErr } = await supabaseAdmin
        .from("payment_plans")
        .update({ payload_json: payload, updated_at: now })
        .eq("id", latestPlan.id)
        .eq("user_id", userId);

      if (planUpErr) throw planUpErr;
    }
  }

  const { error: txDelErr } = await supabaseAdmin
    .from("transactions_raw")
    .delete()
    .eq("user_id", userId)
    .eq("plaid_item_id", itemId);

  if (txDelErr) throw txDelErr;

  const { error: accDelErr } = await supabaseAdmin
    .from("accounts")
    .delete()
    .eq("user_id", userId)
    .eq("plaid_item_id", itemId);

  if (accDelErr) throw accDelErr;

  const { error: itemDelErr } = await supabaseAdmin
    .from("plaid_items")
    .delete()
    .eq("user_id", userId)
    .eq("plaid_item_id", itemId);

  if (itemDelErr) throw itemDelErr;

  return { ok: true, plaid_item_id: itemId };
}

async function upsertPlaidItem({
  userId,
  itemId,
  accessToken,
  institutionId = null,
  institutionName = null,
  connectionRole = null
}) {
  const payload = {
    user_id: userId,
    plaid_item_id: itemId,
    access_token: accessToken,
    institution_id: institutionId,
    institution_name: institutionName,
    connection_role: normalizePlaidConnectionRole(connectionRole),
    updated_at: new Date().toISOString()
  };

  let { data, error } = await supabaseAdmin
    .from("plaid_items")
    .upsert(payload, { onConflict: "plaid_item_id" })
    .select()
    .single();

  if (error && isMissingTableColumnError(error, "plaid_items", "connection_role")) {
    appDebug(
      "upsertPlaidItem: columna connection_role ausente; reintentando sin ella. Ejecutar sql/add_plaid_items_connection_role.sql en Supabase."
    );
    const { connection_role: _roleOmit, ...fallbackPayload } = payload;
    const retry = await supabaseAdmin
      .from("plaid_items")
      .upsert(fallbackPayload, { onConflict: "plaid_item_id" })
      .select()
      .single();
    data = retry.data;
    error = retry.error;
  }

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

  if (String(freshIntent.source || "").toLowerCase() === "spinwheel") {
    const err = new Error(
      "Intent Spinwheel: solo planificacion por ahora; no hay ejecucion de pago real hasta integrar el rail."
    );
    err.status = 400;
    throw err;
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
  SUPABASE_ANON_KEY: SUPABASE_ANON_KEY_EFFECTIVE,
  SUPABASE_SERVICE_ROLE_KEY,
  APP_BASE_URL,
  FRONTEND_URL,
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
  redeemCompPromoForUser,
  getCompPromoMeta,
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
  disconnectPlaidItemForUser,
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
  compareStrategiesForUser,
  normalizePlaidConnectionRole,
  isMissingTableColumnError
});

app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    req.path !== "/debtya-version.txt" &&
    req.path !== "/debtya-bank-strip.js" &&
    req.path !== "/disconnect-bank.html" &&
    req.path !== "/bank-disconnect" &&
    req.path !== "/bank-disconnect/" &&
    req.path !== "/api/bank-disconnect" &&
    req.path !== "/api/bank-disconnect/" &&
    req.path !== "/api/plaid/manage-disconnect" &&
    !req.path.startsWith("/health") &&
    !req.path.startsWith("/billing") &&
    !req.path.startsWith("/stripe") &&
    !req.path.startsWith("/supabase") &&
    !req.path.startsWith("/plaid") &&
    !req.path.startsWith("/method") &&
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
    !req.path.startsWith("/cron") &&
    !req.path.startsWith("/auth")
  ) {
    return sendSpaFallbackIndexHtml(res);
  }
  next();
});

app.use((err, req, res, _next) => {
  appError("ERROR NO CONTROLADO:", req.requestId || null, err);
  return jsonError(res, 500, "Error interno del servidor", {
    details: err.message
  });
});

try {
  const _probe = fs.readFileSync(
    path.join(__dirname, "public", "plaid-manage-disconnect.html"),
    "utf8"
  );
  if (!_probe || !_probe.trim()) {
    throw new Error("empty file");
  }
} catch (e) {
  console.error(
    "[DebtYa] AVISO: no se pudo leer public/plaid-manage-disconnect.html — /bank-disconnect devolverá error hasta que exista el archivo en el deploy."
  );
}

app.listen(PORT, () => {
  const methodStatus = readMethodKeyStatus();
  console.log(`DebtYa API escuchando en puerto ${PORT}`);
  console.log(`Server version: ${SERVER_VERSION}`);
  console.log(
    `[DebtYa] Method config: configured=${methodStatus.configured} key_source=${methodStatus.key_source || "none"} env=${readMethodEnv()} api_version=${readMethodApiVersion()}`
  );
  console.log(
    "[DebtYa] Quitar banco (abrir en el navegador con sesion): /bank-disconnect | /disconnect-bank.html | /plaid/manage-disconnect | /api/bank-disconnect"
  );
});
