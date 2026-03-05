"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const API_BASE_URL = process.env.API_BASE_URL || "https://debtya-api.onrender.com";
const CRON_SECRET = process.env.CRON_SECRET || "";

// -------------------- Supabase --------------------
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || ""; // para el cliente (opcional), backend usa service_role

const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
    : null;

// -------------------- Plaid --------------------
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const basePath =
  PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PLAID_ENV === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

const plaidConfig = new Configuration({
  basePath,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// -------------------- Crypto token encryption (AES-256-GCM) --------------------
function getKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!key || key.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY falta o es muy corta (mínimo 32 caracteres)");
  return crypto.createHash("sha256").update(key).digest();
}
function encryptToken(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
function decryptToken(payload) {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = String(payload).split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Formato de token encriptado inválido");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}
function unwrapAccessToken(maybeEncrypted) {
  const s = String(maybeEncrypted || "");
  const parts = s.split(".");
  if (parts.length === 3) return decryptToken(s);
  return s;
}
function looksLikePlaidAccessToken(s) {
  return typeof s === "string" && s.startsWith("access-");
}

// -------------------- Utils --------------------
function toNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function clampInt(x, min, max) {
  const n = Math.floor(toNumber(x, NaN));
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}
function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function todayISO() {
  return isoDate(new Date());
}
function startOfWeekISO(dateObj = new Date()) {
  const d = new Date(dateObj);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}
function ceilToNearest(amount, step) {
  const s = Math.max(0.01, toNumber(step, 1));
  return Math.ceil(amount / s) * s;
}
function money(n) {
  const x = Number(n || 0);
  return `$${x.toFixed(2)}`;
}

// =========================
// AUTH MIDDLEWARE (Supabase JWT)
// =========================
async function requireAuth(req, res, next) {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase no configurado" });

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Falta Authorization Bearer token" });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: "Token inválido" });

    req.user = data.user; // { id: uuid, email, ... }
    req.jwt = token;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Auth error" });
  }
}

function requireCron(req, res, next) {
  const secret = req.headers["x-cron-secret"] || "";
  if (!CRON_SECRET || String(secret) !== String(CRON_SECRET)) {
    return res.status(401).json({ ok: false, error: "Cron no autorizado" });
  }
  next();
}

// =========================
// NOTIFICATIONS + PUSH
// =========================
async function createNotification(user_id, type, title, body) {
  try {
    await supabase.from("notifications").insert({
      user_id,
      type: String(type),
      title: String(title),
      body: String(body),
      is_read: false,
    });
  } catch (e) {
    console.error("NOTIF INSERT ERROR:", e);
  }
}

async function getUserPushTokens(user_id) {
  const { data } = await supabase
    .from("push_tokens")
    .select("expo_push_token,enabled")
    .eq("user_id", user_id)
    .eq("enabled", true);

  return (data || []).map((x) => x.expo_push_token).filter(Boolean);
}

async function sendExpoPush(tokens, title, body) {
  try {
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    // Expo push endpoint
    const messages = tokens.map((to) => ({
      to,
      sound: "default",
      title: String(title),
      body: String(body),
      data: { source: "debtya" },
    }));

    // node fetch (Node 18+ trae fetch)
    const r = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    await r.text(); // no necesitamos parsear
  } catch (e) {
    console.error("PUSH ERROR:", e);
  }
}

async function notifyAndPush(user_id, type, title, body) {
  await createNotification(user_id, type, title, body);
  const tokens = await getUserPushTokens(user_id);
  await sendExpoPush(tokens, title, body);
}

// =========================
// PLAID ITEMS HELPERS
// =========================
async function findLatestItemByUser(user_id) {
  const { data, error } = await supabase
    .from("plaid_items")
    .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
    .eq("user_id", String(user_id))
    .not("plaid_item_id", "like", "ping_item_%")
    .order("id", { ascending: false })
    .limit(1);

  if (error) return { row: null, error };
  return { row: Array.isArray(data) ? data[0] : null, error: null };
}

async function findItemById(plaid_item_id) {
  const { data, error } = await supabase
    .from("plaid_items")
    .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
    .eq("plaid_item_id", String(plaid_item_id))
    .limit(1)
    .maybeSingle();

  if (error) return { row: null, error };
  return { row: data || null, error: null };
}

// =========================
// CURSOR + TRANSACTIONS (ya lo tienes, lo dejamos compatible)
// =========================
async function getStoredCursor(plaid_item_id) {
  const { data } = await supabase
    .from("plaid_sync_state")
    .select("next_cursor")
    .eq("plaid_item_id", String(plaid_item_id))
    .limit(1)
    .maybeSingle();
  return data?.next_cursor || null;
}

async function saveCursor({ user_id, plaid_item_id, next_cursor }) {
  await supabase.from("plaid_sync_state").upsert(
    {
      user_id: String(user_id),
      plaid_item_id: String(plaid_item_id),
      next_cursor: String(next_cursor),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "plaid_item_id" }
  );
}

async function deleteCursor(plaid_item_id) {
  await supabase.from("plaid_sync_state").delete().eq("plaid_item_id", String(plaid_item_id));
}

async function upsertTransactions({ user_id, plaid_item_id, added = [], modified = [] }) {
  const rows = []
    .concat(added || [])
    .concat(modified || [])
    .filter((t) => t && t.transaction_id)
    .map((tx) => {
      const pfc = tx?.personal_finance_category || {};
      return {
        transaction_id: String(tx.transaction_id),
        user_id: String(user_id),
        plaid_item_id: String(plaid_item_id),
        account_id: String(tx.account_id),
        date: tx.date || null,
        authorized_date: tx.authorized_date || null,
        name: tx.name || null,
        merchant_name: tx.merchant_name || null,
        amount: typeof tx.amount === "number" ? tx.amount : tx.amount ?? null,
        iso_currency_code: tx.iso_currency_code || null,
        unofficial_currency_code: tx.unofficial_currency_code || null,
        payment_channel: tx.payment_channel || null,
        pending: typeof tx.pending === "boolean" ? tx.pending : null,
        personal_finance_primary: pfc?.primary || null,
        personal_finance_detailed: pfc?.detailed || null,
        raw: tx || null,
        is_removed: false,
        removed_at: null,
        updated_at: new Date().toISOString(),
      };
    });

  if (!rows.length) return;
  await supabase.from("plaid_transactions").upsert(rows, { onConflict: "transaction_id" });
}

async function markRemovedTransactions({ removed = [] }) {
  if (!Array.isArray(removed) || removed.length === 0) return;
  const ids = removed.map((r) => r?.transaction_id).filter(Boolean);
  if (!ids.length) return;
  await supabase
    .from("plaid_transactions")
    .update({ is_removed: true, removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("transaction_id", ids);
}

async function runTransactionsSyncAndSave({ row, cursorOverride = null }) {
  const access_token = unwrapAccessToken(row.plaid_access_token);
  if (!looksLikePlaidAccessToken(access_token)) throw new Error("access_token inválido");

  let useCursor = cursorOverride ? String(cursorOverride) : null;
  if (!useCursor) useCursor = await getStoredCursor(row.plaid_item_id);

  const resp = await plaidClient.transactionsSync({
    access_token,
    cursor: useCursor || undefined,
  });

  const added = resp.data.added || [];
  const modified = resp.data.modified || [];
  const removed = resp.data.removed || [];
  const next_cursor = resp.data.next_cursor;
  const has_more = resp.data.has_more;

  await upsertTransactions({ user_id: row.user_id, plaid_item_id: row.plaid_item_id, added, modified });
  await markRemovedTransactions({ removed });
  await saveCursor({ user_id: row.user_id, plaid_item_id: row.plaid_item_id, next_cursor });

  return {
    used_cursor: useCursor || null,
    added_count: added.length,
    modified_count: modified.length,
    removed_count: removed.length,
    next_cursor,
    has_more,
    request_id: resp.data.request_id,
  };
}

// =========================
// MICRO ENGINE v2
// =========================
async function getMicroRuleV2(user_id) {
  const { data } = await supabase.from("micro_rules_v2").select("*").eq("user_id", user_id).maybeSingle();
  return data || null;
}
async function getLedgerV2(user_id) {
  const { data } = await supabase.from("micro_ledger_v2").select("*").eq("user_id", user_id).maybeSingle();
  return data || null;
}
async function upsertLedgerV2(user_id, patch) {
  const current = (await getLedgerV2(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
  const payload = {
    user_id,
    pending_total: patch.pending_total !== undefined ? patch.pending_total : current.pending_total,
    processed_total: patch.processed_total !== undefined ? patch.processed_total : current.processed_total,
    last_run_at: patch.last_run_at !== undefined ? patch.last_run_at : current.last_run_at,
    last_payout_at: patch.last_payout_at !== undefined ? patch.last_payout_at : current.last_payout_at,
    updated_at: new Date().toISOString(),
  };
  await supabase.from("micro_ledger_v2").upsert(payload, { onConflict: "user_id" });
  return payload;
}
async function sumPendingForDayV2(user_id, dayISO) {
  const { data } = await supabase
    .from("micro_contributions_v2")
    .select("contribution_amount,created_at")
    .eq("user_id", user_id)
    .eq("status", "pending");

  let sum = 0;
  for (const r of data || []) if (isoDate(r.created_at) === dayISO) sum += toNumber(r.contribution_amount, 0);
  return sum;
}
async function sumPendingForWeekV2(user_id, weekStartISO) {
  const { data } = await supabase
    .from("micro_contributions_v2")
    .select("contribution_amount,created_at")
    .eq("user_id", user_id)
    .eq("status", "pending");

  let sum = 0;
  for (const r of data || []) if (isoDate(r.created_at) >= weekStartISO) sum += toNumber(r.contribution_amount, 0);
  return sum;
}
function calcContribution(rule, purchaseAmount) {
  const amt = Math.max(0, toNumber(purchaseAmount, 0));
  if (amt <= 0) return 0;

  const mode = String(rule.mode || "fixed").toLowerCase();
  let c = 0;

  if (mode === "percent") c = amt * (Math.max(0, toNumber(rule.percent, 2)) / 100);
  else if (mode === "roundup") {
    const step = Math.max(0.01, toNumber(rule.roundup_to, 1));
    const rounded = ceilToNearest(amt, step);
    c = Math.max(0, rounded - amt);
  } else c = Math.max(0, toNumber(rule.fixed_amount, 1));

  return Math.round(c * 100) / 100;
}

async function runMicroEngineV2({ user_id, days_back = 120, source = "manual" }) {
  const rule = await getMicroRuleV2(user_id);
  if (!rule || !rule.enabled) return { ok: true, created: 0, skipped: 0, created_total: 0, message: "Micro desactivado" };

  const foundItem = await findLatestItemByUser(user_id);
  const plaid_item_id = foundItem?.row?.plaid_item_id || "unknown_item";

  const since = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: tx, error } = await supabase
    .from("plaid_transactions")
    .select("transaction_id,date,amount,pending,is_removed")
    .eq("user_id", String(user_id))
    .eq("is_removed", false)
    .eq("pending", false)
    .gte("date", since);

  if (error) throw error;

  const today = todayISO();
  const weekStart = startOfWeekISO(new Date());

  let dailyUsed = await sumPendingForDayV2(user_id, today);
  let weeklyUsed = await sumPendingForWeekV2(user_id, weekStart);

  const capDaily = rule.cap_daily === null || rule.cap_daily === undefined ? null : Math.max(0, toNumber(rule.cap_daily, 0));
  const capWeekly = rule.cap_weekly === null || rule.cap_weekly === undefined ? null : Math.max(0, toNumber(rule.cap_weekly, 0));
  const minPurchase = Math.max(0, toNumber(rule.min_purchase_amount, 1));

  let created = 0;
  let skipped = 0;
  let createdTotal = 0;

  for (const t of tx || []) {
    const tid = String(t.transaction_id || "");
    if (!tid) { skipped++; continue; }

    const purchaseAmount = Math.max(0, toNumber(t.amount, 0));
    if (purchaseAmount < minPurchase) { skipped++; continue; }

    let c = calcContribution(rule, purchaseAmount);
    if (c <= 0) { skipped++; continue; }

    if (capDaily !== null) {
      const rem = capDaily - dailyUsed;
      if (rem <= 0) { skipped++; continue; }
      c = Math.min(c, rem);
    }
    if (capWeekly !== null) {
      const rem = capWeekly - weeklyUsed;
      if (rem <= 0) { skipped++; continue; }
      c = Math.min(c, rem);
    }

    c = Math.round(c * 100) / 100;
    if (c <= 0) { skipped++; continue; }

    const row = {
      user_id,
      plaid_item_id,
      transaction_id: tid,
      transaction_date: t.date || null,
      purchase_amount: purchaseAmount,
      contribution_amount: c,
      target_debt_id: rule.target_debt_id || null,
      status: "pending",
    };

    const { error: insErr } = await supabase.from("micro_contributions_v2").insert(row);
    if (insErr) { skipped++; continue; }

    created++;
    createdTotal += c;
    dailyUsed += c;
    weeklyUsed += c;
  }

  const ledger = (await getLedgerV2(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
  const newPending = Math.round((toNumber(ledger.pending_total, 0) + createdTotal) * 100) / 100;
  await upsertLedgerV2(user_id, { pending_total: newPending, last_run_at: new Date().toISOString() });

  if (createdTotal > 0) {
    await notifyAndPush(
      user_id,
      "micro_run",
      "Micro-pagos acumulados",
      `Se agregaron ${money(createdTotal)} (${source}). Total pendiente: ${money(newPending)}.`
    );
  }

  return { ok: true, created, skipped, created_total: Number(createdTotal.toFixed(2)), pending_total: newPending };
}

async function simulatePayoutV2({ user_id, thresholdOverride = null }) {
  const rule = await getMicroRuleV2(user_id);
  if (!rule || !rule.payout_enabled) return { ok: true, paid: 0, message: "Payout desactivado" };

  const ledger = (await getLedgerV2(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
  const threshold = thresholdOverride !== null ? Math.max(0, toNumber(thresholdOverride, 0)) : Math.max(0, toNumber(rule.payout_min_threshold, 20));

  const pending = Math.max(0, toNumber(ledger.pending_total, 0));
  if (pending < threshold) return { ok: true, paid: 0, pending_total: pending, message: `Pendiente ${money(pending)} < umbral ${money(threshold)}` };

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("micro_contributions_v2")
    .update({ status: "processed", processed_at: now })
    .eq("user_id", user_id)
    .eq("status", "pending");

  if (updErr) throw updErr;

  const newProcessed = Math.round((toNumber(ledger.processed_total, 0) + pending) * 100) / 100;
  await upsertLedgerV2(user_id, { pending_total: 0, processed_total: newProcessed, last_payout_at: now });

  await notifyAndPush(
    user_id,
    "payout",
    "Payout semanal (simulado)",
    `Se “pagaron” ${money(pending)}. Total procesado: ${money(newProcessed)}.`
  );

  return { ok: true, paid: Number(pending.toFixed(2)), pending_total: 0, processed_total: newProcessed };
}

// =========================
// ROUTES
// =========================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "debtya-api",
    env: PLAID_ENV,
    supabase_configured: Boolean(supabase),
    time: new Date().toISOString(),
  });
});

// -------- AUTH TEST (para confirmar login) --------
app.get("/me", requireAuth, async (req, res) => {
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email } });
});

// -------- PUSH REGISTER --------
app.post("/push/register", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { expo_push_token, platform, device_name } = req.body || {};
    if (!expo_push_token) return res.status(400).json({ ok: false, error: "expo_push_token requerido" });

    const payload = {
      user_id,
      expo_push_token: String(expo_push_token),
      platform: platform ? String(platform) : null,
      device_name: device_name ? String(device_name) : null,
      enabled: true,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("push_tokens").upsert(payload, { onConflict: "expo_push_token" });
    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------- NOTIFICATIONS --------
app.get("/notifications", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const limit = Math.min(100, Math.max(1, Math.floor(toNumber(req.query.limit, 30))));
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  return res.json({ ok: true, notifications: data || [] });
});

app.post("/notifications/mark_read", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { error } = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user_id).eq("is_read", false);
  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  return res.json({ ok: true });
});

// -------- DEBTS v2 CRUD --------
app.get("/debts", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { data, error } = await supabase.from("debts_v2").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  return res.json({ ok: true, debts: data || [] });
});

app.post("/debts", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { name, balance, apr, min_payment, due_day } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: "name requerido" });

  const row = {
    user_id,
    name: String(name),
    balance: Math.max(0, toNumber(balance, 0)),
    apr: Math.max(0, toNumber(apr, 0)),
    min_payment: Math.max(0, toNumber(min_payment, 0)),
    due_day: clampInt(due_day, 1, 28),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("debts_v2").insert(row).select("*");
  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  return res.json({ ok: true, debt: data?.[0] || null });
});

app.put("/debts/:id", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const id = String(req.params.id || "");
  const { name, balance, apr, min_payment, due_day } = req.body || {};

  const patch = {
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(balance !== undefined ? { balance: Math.max(0, toNumber(balance, 0)) } : {}),
    ...(apr !== undefined ? { apr: Math.max(0, toNumber(apr, 0)) } : {}),
    ...(min_payment !== undefined ? { min_payment: Math.max(0, toNumber(min_payment, 0)) } : {}),
    ...(due_day !== undefined ? { due_day: clampInt(due_day, 1, 28) } : {}),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("debts_v2").update(patch).eq("id", id).eq("user_id", user_id).select("*");
  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  if (!data || data.length === 0) return res.status(404).json({ ok: false, error: "No encontrado" });
  return res.json({ ok: true, debt: data[0] });
});

app.delete("/debts/:id", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const id = String(req.params.id || "");
  const { error } = await supabase.from("debts_v2").delete().eq("id", id).eq("user_id", user_id);
  if (error) return res.status(500).json({ ok: false, supabase_error: error });
  return res.json({ ok: true });
});

// -------- MICRO v2 --------
app.get("/micro/status", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const rule = await getMicroRuleV2(user_id);
  const ledger = await getLedgerV2(user_id);

  const { data: recent } = await supabase
    .from("micro_contributions_v2")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(20);

  return res.json({ ok: true, rule: rule || null, ledger: ledger || null, recent: recent || [] });
});

app.post("/micro/rule", requireAuth, async (req, res) => {
  const user_id = req.user.id;

  const payload = {
    user_id,
    enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true,
    auto_run: req.body?.auto_run !== undefined ? Boolean(req.body.auto_run) : true,
    payout_enabled: req.body?.payout_enabled !== undefined ? Boolean(req.body.payout_enabled) : true,
    payout_min_threshold: Math.max(0, toNumber(req.body?.payout_min_threshold, 20)),

    mode: String(req.body?.mode || "fixed"),
    fixed_amount: Math.max(0, toNumber(req.body?.fixed_amount, 1)),
    percent: Math.max(0, toNumber(req.body?.percent, 2)),
    roundup_to: Math.max(0.01, toNumber(req.body?.roundup_to, 1)),
    min_purchase_amount: Math.max(0, toNumber(req.body?.min_purchase_amount, 1)),
    cap_daily: req.body?.cap_daily === null || req.body?.cap_daily === undefined ? null : Math.max(0, toNumber(req.body?.cap_daily, 0)),
    cap_weekly: req.body?.cap_weekly === null || req.body?.cap_weekly === undefined ? null : Math.max(0, toNumber(req.body?.cap_weekly, 0)),
    target_debt_id: req.body?.target_debt_id || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("micro_rules_v2").upsert(payload, { onConflict: "user_id" }).select("*");
  if (error) return res.status(500).json({ ok: false, supabase_error: error });

  return res.json({ ok: true, rule: data?.[0] || null });
});

app.post("/micro/run", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const days_back = Math.min(3650, Math.max(1, Math.floor(toNumber(req.body?.days_back, 120))));
  const out = await runMicroEngineV2({ user_id, days_back, source: "manual_run" });
  return res.json(out);
});

app.post("/micro/payout/simulate", requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const threshold = req.body?.threshold !== undefined ? toNumber(req.body.threshold, 0) : null;
  const out = await simulatePayoutV2({ user_id, thresholdOverride: threshold });
  return res.json(out);
});

// -------- JOBS (CRON) --------
// Diario: sync + micro-run (para TODOS los usuarios que tengan auto_run enabled)
// Semanal: payout simulado si supera umbral

app.post("/jobs/daily", requireCron, async (req, res) => {
  try {
    // 1) buscar reglas activas y auto_run
    const { data: rules } = await supabase
      .from("micro_rules_v2")
      .select("user_id")
      .eq("enabled", true)
      .eq("auto_run", true);

    let ran = 0;
    for (const r of rules || []) {
      // solo micro-run (lo de sync Plaid depende de que el usuario haya linkeado, lo hacemos si existe item)
      try {
        await runMicroEngineV2({ user_id: r.user_id, days_back: 7, source: "cron(daily)" });
        ran++;
      } catch {}
    }

    await createNotification(
      (rules && rules[0] && rules[0].user_id) ? rules[0].user_id : crypto.randomUUID(),
      "info",
      "Job diario ejecutado",
      `Se ejecutó cron diario. Usuarios procesados: ${ran}.`
    );

    return res.json({ ok: true, ran });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/jobs/weekly", requireCron, async (req, res) => {
  try {
    const { data: rules } = await supabase
      .from("micro_rules_v2")
      .select("user_id,payout_min_threshold")
      .eq("enabled", true)
      .eq("payout_enabled", true);

    let paid = 0;
    for (const r of rules || []) {
      try {
        const out = await simulatePayoutV2({ user_id: r.user_id, thresholdOverride: r.payout_min_threshold });
        if (out?.paid > 0) paid++;
      } catch {}
    }

    return res.json({ ok: true, paid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Debtya API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
  console.log(`✅ SUPABASE configured: ${Boolean(supabase)}`);
});
