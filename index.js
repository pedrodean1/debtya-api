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

// -------------------- Supabase --------------------
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
    : null;

// -------------------- Crypto (AES-256-GCM) --------------------
function getKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!key || key.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY falta o es muy corta (mínimo 32 caracteres)");
  return crypto.createHash("sha256").update(key).digest(); // 32 bytes
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
  const day = d.getDay(); // 0 sunday
  const diff = (day === 0 ? -6 : 1) - day; // monday start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}
function ceilToNearest(amount, step) {
  const s = Math.max(0.01, toNumber(step, 1));
  return Math.ceil(amount / s) * s;
}

// -------------------- Notifications --------------------
async function createNotification(user_id, type, title, body) {
  try {
    if (!supabase) return;
    await supabase.from("notifications").insert({
      user_id: String(user_id),
      type: String(type),
      title: String(title),
      body: String(body),
      is_read: false,
    });
  } catch (e) {
    console.error("NOTIFICATION ERROR:", e);
  }
}

// -------------------- Supabase helpers: items --------------------
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

// -------------------- Cursor / Transactions storage --------------------
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
  if (!looksLikePlaidAccessToken(access_token)) throw new Error("access_token inválido (no empieza con 'access-')");

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

// -------------------- Plan helpers --------------------
function sortDebtsByStrategy(debts, strategy) {
  const s = String(strategy || "avalanche").toLowerCase();
  if (s === "snowball") return [...debts].sort((a, b) => (a.balance - b.balance) || (b.apr - a.apr));
  return [...debts].sort((a, b) => (b.apr - a.apr) || (b.balance - a.balance));
}
function simulateStrategy(debtsInput, monthly_extra, strategy, maxMonths = 600) {
  const state = debtsInput
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: Math.max(0, toNumber(d.apr, 0)),
      min_payment: Math.max(0, toNumber(d.min_payment, 0)),
      balance: Math.max(0, toNumber(d.balance, 0)),
      due_day: d.due_day ?? null,
      paid_off_month: null,
    }))
    .filter((d) => d.balance > 0);

  const ordered = sortDebtsByStrategy(state, strategy);

  let month = 0;
  const history = [];

  while (month < maxMonths) {
    month += 1;
    const remaining = ordered.filter((d) => d.balance > 0);
    if (remaining.length === 0) break;

    for (const d of remaining) {
      const r = (d.apr / 100) / 12;
      if (r > 0) d.balance = d.balance * (1 + r);
    }

    let extra = Math.max(0, toNumber(monthly_extra, 0));
    const payments = [];

    for (const d of remaining) {
      const payMin = Math.min(d.balance, d.min_payment);
      d.balance -= payMin;
      payments.push({ debt_id: d.id, name: d.name, type: "min", amount: payMin });
    }

    while (extra > 0.0001) {
      const target = ordered.find((d) => d.balance > 0);
      if (!target) break;
      const pay = Math.min(target.balance, extra);
      target.balance -= pay;
      extra -= pay;
      payments.push({ debt_id: target.id, name: target.name, type: "extra", amount: pay });
    }

    for (const d of ordered) {
      if (d.balance <= 0.0001 && d.paid_off_month == null) d.paid_off_month = month;
      if (d.balance < 0) d.balance = 0;
    }

    history.push({ month, payments });
  }

  const payoff_months = ordered.map((d) => ({ debt_id: d.id, name: d.name, paid_off_month: d.paid_off_month }));
  const total_months = payoff_months.reduce((mx, x) => Math.max(mx, x.paid_off_month || 0), 0);

  const next_month_payments = {};
  const first = history[0] || { payments: [] };
  for (const p of first.payments) next_month_payments[p.name] = (next_month_payments[p.name] || 0) + p.amount;

  return { total_months, payoff_months, next_month_payments };
}
function nextDueDateFromDay(due_day, baseDate = new Date()) {
  const dd = clampInt(due_day, 1, 28);
  if (!dd) return null;

  const now = new Date(baseDate);
  const y = now.getFullYear();
  const m = now.getMonth();

  const candidate = new Date(y, m, dd);
  candidate.setHours(12, 0, 0, 0);

  if (candidate >= now) return candidate;

  const next = new Date(y, m + 1, dd);
  next.setHours(12, 0, 0, 0);
  return next;
}
function buildPaymentCalendar(debts, next_month_payments, baseDate = new Date()) {
  const out = [];
  for (const d of debts) {
    const amount = toNumber(next_month_payments[d.name] || 0, 0);
    if (amount <= 0) continue;

    let due = nextDueDateFromDay(d.due_day, baseDate);
    if (!due) {
      const nd = new Date(baseDate);
      nd.setMonth(nd.getMonth() + 1);
      due = new Date(nd.getFullYear(), nd.getMonth(), 1);
      due.setHours(12, 0, 0, 0);
    }

    const payDate = new Date(due);
    payDate.setDate(payDate.getDate() - 3);
    if (payDate < baseDate) payDate.setTime(baseDate.getTime());

    out.push({
      debt_id: d.id,
      name: d.name,
      due_day: d.due_day,
      suggested_pay_date: isoDate(payDate),
      due_date: isoDate(due),
      amount: Number(amount.toFixed(2)),
    });
  }
  out.sort((a, b) => (a.suggested_pay_date < b.suggested_pay_date ? -1 : 1));
  return out;
}

// -------------------- Micro-pagos helpers --------------------
async function getMicroRule(user_id) {
  const { data } = await supabase.from("micro_rules").select("*").eq("user_id", String(user_id)).maybeSingle();
  return data || null;
}
async function getLedger(user_id) {
  const { data } = await supabase.from("micro_ledger").select("*").eq("user_id", String(user_id)).maybeSingle();
  return data || null;
}
async function upsertLedger(user_id, patch) {
  const current = (await getLedger(user_id)) || { user_id: String(user_id), pending_total: 0, processed_total: 0 };
  const payload = {
    user_id: String(user_id),
    pending_total: patch.pending_total !== undefined ? patch.pending_total : current.pending_total,
    processed_total: patch.processed_total !== undefined ? patch.processed_total : current.processed_total,
    last_run_at: patch.last_run_at !== undefined ? patch.last_run_at : current.last_run_at,
    last_payout_at: patch.last_payout_at !== undefined ? patch.last_payout_at : current.last_payout_at,
    updated_at: new Date().toISOString(),
  };
  await supabase.from("micro_ledger").upsert(payload, { onConflict: "user_id" });
  return payload;
}
async function sumPendingForDay(user_id, dayISO) {
  const { data } = await supabase
    .from("micro_contributions")
    .select("contribution_amount,created_at")
    .eq("user_id", String(user_id))
    .eq("status", "pending");

  let sum = 0;
  for (const r of data || []) {
    if (isoDate(r.created_at) === dayISO) sum += toNumber(r.contribution_amount, 0);
  }
  return sum;
}
async function sumPendingForWeek(user_id, weekStartISO) {
  const { data } = await supabase
    .from("micro_contributions")
    .select("contribution_amount,created_at")
    .eq("user_id", String(user_id))
    .eq("status", "pending");

  let sum = 0;
  for (const r of data || []) {
    if (isoDate(r.created_at) >= weekStartISO) sum += toNumber(r.contribution_amount, 0);
  }
  return sum;
}
function calcContribution(rule, purchaseAmount) {
  const amt = Math.max(0, toNumber(purchaseAmount, 0));
  if (amt <= 0) return 0;

  const mode = String(rule.mode || "fixed").toLowerCase();
  let c = 0;

  if (mode === "percent") {
    c = amt * (Math.max(0, toNumber(rule.percent, 2)) / 100);
  } else if (mode === "roundup") {
    const step = Math.max(0.01, toNumber(rule.roundup_to, 1));
    const rounded = ceilToNearest(amt, step);
    c = Math.max(0, rounded - amt);
  } else {
    c = Math.max(0, toNumber(rule.fixed_amount, 1));
  }

  c = Math.round(c * 100) / 100;
  return c;
}

// Motor de micro-run (reutilizable por endpoint y Auto-Run)
async function runMicroEngine({ user_id, days_back = 120, source = "manual" }) {
  const rule = await getMicroRule(user_id);
  if (!rule || !rule.enabled) {
    return { ok: true, message: "Micro-pagos desactivados o regla no existe.", created: 0, skipped: 0, created_total: 0 };
  }

  const foundItem = await findLatestItemByUser(user_id);
  const plaid_item_id = foundItem?.row?.plaid_item_id || "unknown_item";

  const since = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: tx, error } = await supabase
    .from("plaid_transactions")
    .select("transaction_id,date,amount,pending,is_removed")
    .eq("user_id", user_id)
    .eq("is_removed", false)
    .eq("pending", false)
    .gte("date", since);

  if (error) throw error;

  const today = todayISO();
  const weekStart = startOfWeekISO(new Date());

  let dailyUsed = await sumPendingForDay(user_id, today);
  let weeklyUsed = await sumPendingForWeek(user_id, weekStart);

  const capDaily = rule.cap_daily === null || rule.cap_daily === undefined ? null : Math.max(0, toNumber(rule.cap_daily, 0));
  const capWeekly = rule.cap_weekly === null || rule.cap_weekly === undefined ? null : Math.max(0, toNumber(rule.cap_weekly, 0));
  const minPurchase = Math.max(0, toNumber(rule.min_purchase_amount, 1));

  let created = 0;
  let skipped = 0;
  let createdTotal = 0;

  for (const t of tx || []) {
    const tid = String(t.transaction_id || "");
    if (!tid) {
      skipped += 1;
      continue;
    }

    const purchaseAmount = Math.max(0, toNumber(t.amount, 0));
    if (purchaseAmount < minPurchase) {
      skipped += 1;
      continue;
    }

    let c = calcContribution(rule, purchaseAmount);
    if (c <= 0) {
      skipped += 1;
      continue;
    }

    if (capDaily !== null) {
      const remainingDaily = capDaily - dailyUsed;
      if (remainingDaily <= 0) {
        skipped += 1;
        continue;
      }
      c = Math.min(c, remainingDaily);
    }

    if (capWeekly !== null) {
      const remainingWeekly = capWeekly - weeklyUsed;
      if (remainingWeekly <= 0) {
        skipped += 1;
        continue;
      }
      c = Math.min(c, remainingWeekly);
    }

    c = Math.round(c * 100) / 100;
    if (c <= 0) {
      skipped += 1;
      continue;
    }

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

    const { error: insErr } = await supabase.from("micro_contributions").insert(row);
    if (insErr) {
      skipped += 1;
      continue;
    }

    created += 1;
    createdTotal += c;
    dailyUsed += c;
    weeklyUsed += c;
  }

  const ledger = (await getLedger(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
  const newPending = Math.round((toNumber(ledger.pending_total, 0) + createdTotal) * 100) / 100;

  await upsertLedger(user_id, { pending_total: newPending, last_run_at: new Date().toISOString() });

  if (createdTotal > 0) {
    await createNotification(
      user_id,
      "micro_run",
      "Micro-pagos acumulados",
      `Se agregaron ${money(createdTotal)} en micro-aportes (${source}). Total pendiente: ${money(newPending)}.`
    );
  }

  return {
    ok: true,
    created,
    skipped,
    created_total: Number(createdTotal.toFixed(2)),
    ledger_pending_total: newPending,
  };
}

// Payout simulado (marca pending -> processed)
async function simulatePayout({ user_id, thresholdOverride = null }) {
  const rule = await getMicroRule(user_id);
  if (!rule || !rule.payout_enabled) {
    return { ok: true, message: "Payout desactivado o regla no existe.", paid: 0 };
  }

  const ledger = (await getLedger(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
  const threshold = thresholdOverride !== null ? Math.max(0, toNumber(thresholdOverride, 0)) : Math.max(0, toNumber(rule.payout_min_threshold, 20));

  const pending = Math.max(0, toNumber(ledger.pending_total, 0));
  if (pending < threshold) {
    return { ok: true, message: `Pendiente ${money(pending)} < umbral ${money(threshold)}. No se ejecuta payout.`, paid: 0, pending_total: pending };
  }

  // marcar todas las pending como processed
  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("micro_contributions")
    .update({ status: "processed", processed_at: now })
    .eq("user_id", String(user_id))
    .eq("status", "pending");

  if (updErr) throw updErr;

  const newProcessedTotal = Math.round((toNumber(ledger.processed_total, 0) + pending) * 100) / 100;

  await upsertLedger(user_id, {
    pending_total: 0,
    processed_total: newProcessedTotal,
    last_payout_at: now,
  });

  await createNotification(
    user_id,
    "payout",
    "Payout semanal (simulado) ejecutado",
    `Se “pagaron” ${money(pending)} hacia la deuda destino. Total procesado histórico: ${money(newProcessedTotal)}.`
  );

  return { ok: true, paid: Number(pending.toFixed(2)), pending_total: 0, processed_total: newProcessedTotal };
}

// -------------------- ROUTES --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "debtya-api",
    env: PLAID_ENV,
    supabase_configured: Boolean(supabase),
    encryption_key_configured: Boolean(process.env.TOKEN_ENCRYPTION_KEY),
    time: new Date().toISOString(),
  });
});

app.get("/plaid/redirect", (req, res) => res.status(200).send("OK"));

// Create link_token
app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const user_id = req.body?.user_id || "pedro-dev-1";
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user_id) },
      client_name: "Debtya",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: "https://debtya-api.onrender.com/plaid/redirect",
    });
    return res.json({ ok: true, ...response.data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Exchange public_token -> access_token (encrypted)
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { public_token, user_id, institution_name } = req.body || {};
    if (!public_token) return res.status(400).json({ ok: false, error: "public_token is required" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const encrypted_access_token = encryptToken(access_token);

    const payload = {
      user_id: String(user_id || "pedro-dev-1"),
      plaid_item_id: item_id,
      plaid_access_token: encrypted_access_token,
      institution_name: institution_name || null,
    };

    const { data, error } = await supabase.from("plaid_items").upsert(payload, { onConflict: "plaid_item_id" }).select("*");
    if (error) return res.status(500).json({ ok: false, where: "save_plaid_items", supabase_error: error });

    return res.json({ ok: true, item_id, user_id: payload.user_id, institution_name: payload.institution_name, saved: data });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Web flow
app.get("/plaid/web", async (req, res) => {
  try {
    const user_id = req.query.user_id || "pedro-dev-1";
    const linkResp = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user_id) },
      client_name: "Debtya",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: "https://debtya-api.onrender.com/plaid/redirect",
    });

    const link_token = linkResp.data.link_token;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Debtya • Connect Bank</title>
    <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;padding:24px;max-width:520px;margin:0 auto}
      button{width:100%;padding:14px 16px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:800;font-size:16px}
      .muted{opacity:.75;margin-top:10px}
      .ok{color:#0a7a0a;font-weight:800}
      .err{color:#b00020;font-weight:800}
      pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:12px;border-radius:10px}
    </style>
  </head>
  <body>
    <h2>Debtya</h2>
    <p class="muted">Connect your bank securely with Plaid.</p>
    <button id="btn">Connect Bank</button>
    <p id="status" class="muted"></p>
    <pre id="details" style="display:none"></pre>

    <script>
      const statusEl = document.getElementById("status");
      const detailsEl = document.getElementById("details");
      const btn = document.getElementById("btn");
      const setStatus = (msg, cls) => { statusEl.textContent = msg; statusEl.className = cls ? cls : "muted"; };

      btn.onclick = async () => {
        setStatus("Opening Plaid…");
        const handler = Plaid.create({
          token: "${link_token}",
          onSuccess: async (public_token, metadata) => {
            try {
              setStatus("Link success. Exchanging token…");
              const inst = metadata && metadata.institution ? metadata.institution.name : null;

              const r = await fetch("/plaid/exchange_public_token", {
                method: "POST",
                headers: {"Content-Type":"application/json"},
                body: JSON.stringify({ public_token, user_id: "${user_id}", institution_name: inst })
              });

              const text = await r.text();
              let data = null; try { data = JSON.parse(text); } catch {}
              if (!r.ok) throw new Error((data && (data.error?.error_message || data.error)) || text);

              setStatus("✅ Bank connected + saved!", "ok");
              detailsEl.style.display = "block";
              detailsEl.textContent = "plaid_item_id: " + data.item_id + "\\n(saved in Supabase)";
            } catch (e) {
              setStatus("❌ Exchange failed", "err");
              detailsEl.style.display = "block";
              detailsEl.textContent = String(e);
            }
          }
        });
        handler.open();
      };
    </script>
  </body>
</html>`);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Accounts
app.post("/plaid/accounts", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });
    const { plaid_item_id, user_id } = req.body || {};
    if (!plaid_item_id && !user_id) return res.status(400).json({ ok: false, error: "Envía plaid_item_id o user_id" });

    let found;
    if (plaid_item_id) found = await findItemById(plaid_item_id);
    else found = await findLatestItemByUser(user_id);

    if (found.error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: found.error });
    if (!found.row) return res.status(404).json({ ok: false, error: "No encontré plaid_items" });

    const access_token = unwrapAccessToken(found.row.plaid_access_token);
    if (!looksLikePlaidAccessToken(access_token)) return res.status(400).json({ ok: false, error: "access_token inválido" });

    const resp = await plaidClient.accountsGet({ access_token });
    return res.json({ ok: true, plaid_item_id: found.row.plaid_item_id, user_id: found.row.user_id, institution_name: found.row.institution_name, accounts: resp.data.accounts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Transactions sync + AUTO-RUN micro
app.post("/plaid/transactions/sync", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { plaid_item_id, user_id, cursor } = req.body || {};
    if (!plaid_item_id && !user_id) return res.status(400).json({ ok: false, error: "Envía plaid_item_id o user_id" });

    let found;
    if (plaid_item_id) found = await findItemById(plaid_item_id);
    else found = await findLatestItemByUser(user_id);

    if (found.error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: found.error });
    if (!found.row) return res.status(404).json({ ok: false, error: "No encontré plaid_items" });

    const result = await runTransactionsSyncAndSave({ row: found.row, cursorOverride: cursor || null });

    // AUTO-RUN micro
    let micro_auto = null;
    try {
      const rule = await getMicroRule(found.row.user_id);
      if (rule && rule.enabled && rule.auto_run) {
        micro_auto = await runMicroEngine({ user_id: found.row.user_id, days_back: 120, source: "auto_run(sync)" });
      }
    } catch (e) {
      micro_auto = { ok: false, error: String(e) };
    }

    return res.json({ ok: true, plaid_item_id: found.row.plaid_item_id, user_id: found.row.user_id, institution_name: found.row.institution_name, ...result, micro_auto });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Reset + AUTO-RUN micro
app.post("/plaid/transactions/reset", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { plaid_item_id, user_id } = req.body || {};
    if (!plaid_item_id && !user_id) return res.status(400).json({ ok: false, error: "Envía plaid_item_id o user_id" });

    let found;
    if (plaid_item_id) found = await findItemById(plaid_item_id);
    else found = await findLatestItemByUser(user_id);

    if (found.error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: found.error });
    if (!found.row) return res.status(404).json({ ok: false, error: "No encontré plaid_items" });

    await deleteCursor(found.row.plaid_item_id);
    const result = await runTransactionsSyncAndSave({ row: found.row, cursorOverride: null });

    // AUTO-RUN micro
    let micro_auto = null;
    try {
      const rule = await getMicroRule(found.row.user_id);
      if (rule && rule.enabled && rule.auto_run) {
        micro_auto = await runMicroEngine({ user_id: found.row.user_id, days_back: 365, source: "auto_run(reset)" });
      }
    } catch (e) {
      micro_auto = { ok: false, error: String(e) };
    }

    return res.json({ ok: true, message: "Cursor reseteado. Sync desde cero ejecutada.", plaid_item_id: found.row.plaid_item_id, user_id: found.row.user_id, institution_name: found.row.institution_name, ...result, micro_auto });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.response?.data || String(err) });
  }
});

// Analytics summary
app.get("/analytics/summary", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const user_id = String(req.query.user_id || "");
    const days = Number(req.query.days || 30);
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });
    if (!Number.isFinite(days) || days <= 0 || days > 3650) return res.status(400).json({ ok: false, error: "days inválido" });

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data: tx, error } = await supabase
      .from("plaid_transactions")
      .select("date,amount,merchant_name,name,personal_finance_primary,personal_finance_detailed,is_removed")
      .eq("user_id", user_id)
      .eq("is_removed", false)
      .gte("date", since);

    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    const rows = Array.isArray(tx) ? tx : [];
    let total_spent = 0;
    let total_income = 0;

    const merchantMap = new Map();
    const categoryMap = new Map();

    for (const t of rows) {
      const amount = toNumber(t.amount, 0);
      if (amount === 0) continue;

      if (amount > 0) total_spent += amount;
      if (amount < 0) total_income += Math.abs(amount);

      const merchant = (t.merchant_name || t.name || "Unknown").toString().trim() || "Unknown";
      merchantMap.set(merchant, (merchantMap.get(merchant) || 0) + Math.abs(amount));

      const cat = (t.personal_finance_primary || t.personal_finance_detailed || "Uncategorized").toString().trim() || "Uncategorized";
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + Math.abs(amount));
    }

    const top_merchants = Array.from(merchantMap.entries()).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, 5);
    const top_categories = Array.from(categoryMap.entries()).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, 5);

    const net = total_income - total_spent;

    return res.json({
      ok: true,
      user_id,
      days,
      since,
      tx_count: rows.length,
      total_spent: Number(total_spent.toFixed(2)),
      total_income: Number(total_income.toFixed(2)),
      net: Number(net.toFixed(2)),
      top_merchants,
      top_categories,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Debts
app.post("/debts", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });
    const { user_id, name, balance, apr, min_payment, due_day } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });
    if (!name) return res.status(400).json({ ok: false, error: "name es requerido" });

    const row = {
      user_id: String(user_id),
      name: String(name),
      balance: Math.max(0, toNumber(balance, 0)),
      apr: Math.max(0, toNumber(apr, 0)),
      min_payment: Math.max(0, toNumber(min_payment, 0)),
      due_day: clampInt(due_day, 1, 28),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("debts").insert(row).select("*");
    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true, debt: data?.[0] || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});
app.get("/debts", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });
    const user_id = String(req.query.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const { data, error } = await supabase.from("debts").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true, debts: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Plan recommendation (igual)
app.post("/plan/recommendation", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const user_id = String(req.body?.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const strategy = String(req.body?.strategy || "avalanche").toLowerCase() === "snowball" ? "snowball" : "avalanche";
    const auto_extra = Boolean(req.body?.auto_extra);
    const buffer = Math.max(0, toNumber(req.body?.buffer, 300));
    const days = Math.min(3650, Math.max(1, Math.floor(toNumber(req.body?.days, 90))));

    const { data, error } = await supabase.from("debts").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    const debts = (data || []).map((d) => ({
      id: d.id,
      name: d.name,
      balance: Math.max(0, toNumber(d.balance, 0)),
      apr: Math.max(0, toNumber(d.apr, 0)),
      min_payment: Math.max(0, toNumber(d.min_payment, 0)),
      due_day: d.due_day ?? null,
    }));

    if (!debts.length) return res.json({ ok: true, message: "No hay deudas guardadas todavía.", plan: null });

    let suggested_extra = null;
    let used_extra = Math.max(0, toNumber(req.body?.monthly_extra, 0));

    if (auto_extra) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: tx, error: txErr } = await supabase
        .from("plaid_transactions")
        .select("date,amount,is_removed")
        .eq("user_id", user_id)
        .eq("is_removed", false)
        .gte("date", since);

      if (txErr) return res.status(500).json({ ok: false, supabase_error: txErr });

      let spent = 0;
      let income = 0;
      for (const t of tx || []) {
        const amt = toNumber(t.amount, 0);
        if (amt > 0) spent += amt;
        if (amt < 0) income += Math.abs(amt);
      }
      const net = income - spent;
      suggested_extra = Math.max(0, net - buffer);
      suggested_extra = Math.round(suggested_extra * 100) / 100;
      used_extra = suggested_extra;
    }

    const plan = simulateStrategy(debts, used_extra, strategy, 600);
    const payment_calendar = buildPaymentCalendar(debts, plan.next_month_payments, new Date());

    const total_balance = debts.reduce((s, d) => s + d.balance, 0);
    const total_mins = debts.reduce((s, d) => s + d.min_payment, 0);

    return res.json({
      ok: true,
      user_id,
      strategy,
      auto_extra,
      days_used_for_auto_extra: auto_extra ? days : null,
      buffer_used: auto_extra ? buffer : null,
      suggested_extra,
      used_extra: Number(used_extra.toFixed(2)),
      total_balance: Number(total_balance.toFixed(2)),
      total_min_payments: Number(total_mins.toFixed(2)),
      plan,
      payment_calendar,
      note: "Simulación mensual simplificada (APR/12). Calendario sugiere pagar 3 días antes del due_day. No es asesoría financiera.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// -------------------- MICRO ENDPOINTS --------------------

// GET /micro/rule?user_id=...
app.get("/micro/rule", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });
    const rule = await getMicroRule(user_id);
    return res.json({ ok: true, rule: rule || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /micro/rule (upsert)
app.post("/micro/rule", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const payload = {
      user_id,
      enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true,
      mode: String(req.body?.mode || "fixed"),
      fixed_amount: Math.max(0, toNumber(req.body?.fixed_amount, 1)),
      percent: Math.max(0, toNumber(req.body?.percent, 2)),
      roundup_to: Math.max(0.01, toNumber(req.body?.roundup_to, 1)),
      min_purchase_amount: Math.max(0, toNumber(req.body?.min_purchase_amount, 1)),
      cap_daily: req.body?.cap_daily === null || req.body?.cap_daily === undefined ? null : Math.max(0, toNumber(req.body?.cap_daily, 0)),
      cap_weekly: req.body?.cap_weekly === null || req.body?.cap_weekly === undefined ? null : Math.max(0, toNumber(req.body?.cap_weekly, 0)),
      target_debt_id: req.body?.target_debt_id || null,
      auto_run: req.body?.auto_run !== undefined ? Boolean(req.body.auto_run) : true,
      payout_enabled: req.body?.payout_enabled !== undefined ? Boolean(req.body.payout_enabled) : true,
      payout_min_threshold: Math.max(0, toNumber(req.body?.payout_min_threshold, 20)),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("micro_rules").upsert(payload, { onConflict: "user_id" }).select("*");
    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    return res.json({ ok: true, rule: data?.[0] || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /micro/status?user_id=...
app.get("/micro/status", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const rule = await getMicroRule(user_id);
    const ledger = await getLedger(user_id);

    const { data: recent } = await supabase
      .from("micro_contributions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(20);

    return res.json({ ok: true, rule: rule || null, ledger: ledger || null, recent: recent || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /micro/run  body: { user_id, days_back? }
app.post("/micro/run", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const days_back = Math.min(3650, Math.max(1, Math.floor(toNumber(req.body?.days_back, 120))));
    const out = await runMicroEngine({ user_id, days_back, source: "manual_run" });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /micro/payout/simulate  body: { user_id, threshold? }
app.post("/micro/payout/simulate", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const threshold = req.body?.threshold !== undefined ? toNumber(req.body.threshold, 0) : null;
    const out = await simulatePayout({ user_id, thresholdOverride: threshold });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// -------------------- NOTIFICATIONS --------------------

// GET /notifications?user_id=...&limit=20
app.get("/notifications", async (req, res) => {
  try {
    const user_id = String(req.query.user_id || "");
    const limit = Math.min(100, Math.max(1, Math.floor(toNumber(req.query.limit, 20))));
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true, notifications: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /notifications/mark_read  body: { user_id }
app.post("/notifications/mark_read", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "");
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user_id)
      .eq("is_read", false);

    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Supabase ping
app.post("/supabase/ping", async (req, res) => {
  try {
    const user_id = req.body?.user_id || "ping-user";
    const now = new Date().toISOString();
    const row = {
      user_id: String(user_id),
      plaid_item_id: `ping_item_${Date.now()}`,
      plaid_access_token: encryptToken(`ping_access_${Date.now()}`),
      institution_name: `PING ${now}`,
    };
    const { data, error } = await supabase.from("plaid_items").insert(row).select("*");
    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true, inserted: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Debtya API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
  console.log(`✅ SUPABASE configured: ${Boolean(supabase)}`);
  console.log(`✅ TOKEN_ENCRYPTION_KEY configured: ${Boolean(process.env.TOKEN_ENCRYPTION_KEY)}`);
});
