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

// -------------------- Token Encryption (AES-256-GCM) --------------------
// Si existe TOKEN_ENCRYPTION_KEY, encriptamos el access_token de Plaid antes de guardarlo en Supabase.
// Si NO existe, guardamos en texto plano (NO recomendado para producción).
function hasEncryptionKey() {
  const k = String(process.env.TOKEN_ENCRYPTION_KEY || "");
  return k.length >= 16;
}
function getKey32() {
  const key = String(process.env.TOKEN_ENCRYPTION_KEY || "");
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY falta");
  return crypto.createHash("sha256").update(key).digest(); // 32 bytes
}
function encryptToken(plain) {
  if (!hasEncryptionKey()) return String(plain);
  const key = getKey32();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
function decryptToken(payload) {
  if (!hasEncryptionKey()) return String(payload);
  const key = getKey32();
  const parts = String(payload || "").split(".");
  if (parts.length !== 3) throw new Error("Formato de token encriptado inválido");
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const data = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}
function unwrapPlaidAccessToken(maybeEncrypted) {
  const s = String(maybeEncrypted || "");
  if (s.split(".").length === 3) {
    try {
      return decryptToken(s);
    } catch {
      return s; // si falla, devolvemos como está
    }
  }
  return s;
}

// -------------------- Utils --------------------
function toNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// =========================
// AUTH MIDDLEWARE (Supabase JWT) - FALLBACK DEFINITIVO
// Acepta JWT por:
// 1) Authorization: Bearer <jwt>
// 2) x-debtya-jwt: <jwt>
// 3) ?jwt=<jwt>   (fallback para Expo si headers fallan)
// 4) body.jwt
// =========================
async function requireAuth(req, res, next) {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase no configurado" });

    const auth = String(req.headers.authorization || "");
    let token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (!token) token = String(req.headers["x-debtya-jwt"] || "").trim();
    if (!token) token = String(req.query?.jwt || "").trim();
    if (!token) token = String(req.body?.jwt || "").trim();

    if (!token) return res.status(401).json({ ok: false, error: "Falta Authorization Bearer token" });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: "Token inválido" });

    req.user = data.user;
    req.jwt = token;
    return next();
  } catch (e) {
    console.error("AUTH ERROR:", e);
    return res.status(401).json({ ok: false, error: "Auth error" });
  }
}

// =========================
// Health + Me
// =========================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "debtya-api",
    env: PLAID_ENV,
    supabase_configured: Boolean(supabase),
    encryption_configured: hasEncryptionKey(),
    time: new Date().toISOString(),
  });
});

app.get("/me", requireAuth, async (req, res) => {
  return res.json({ ok: true, user: { id: req.user.id, email: req.user.email } });
});

// =========================
// PLAID WEB (PUBLIC) - WebView
// =========================
app.get("/plaid/redirect", (req, res) => res.status(200).send("OK"));

app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase no configurado" });

    const { public_token, user_id, institution_name } = req.body || {};
    if (!public_token) return res.status(400).json({ ok: false, error: "public_token es requerido" });
    if (!user_id) return res.status(400).json({ ok: false, error: "user_id es requerido" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const token_to_store = encryptToken(access_token);

    const { error } = await supabase.from("plaid_items").upsert(
      {
        user_id: String(user_id),
        plaid_item_id: item_id,
        plaid_access_token: token_to_store,
        institution_name: institution_name || null,
      },
      { onConflict: "plaid_item_id" }
    );

    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    return res.json({
      ok: true,
      plaid_item_id: item_id,
      user_id: String(user_id),
      institution_name: institution_name || null,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (exchange_public_token):", plaidData || err);
    return res.status(400).json({ ok: false, error: plaidData || err?.message || "Unknown error" });
  }
});

app.get("/plaid/web", async (req, res) => {
  try {
    const user_id = req.query.user_id || "";
    if (!user_id) return res.status(400).send("Missing user_id");

    const linkResp = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user_id) },
      client_name: "Debtya",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: `${API_BASE_URL}/plaid/redirect`,
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

      const setStatus = (msg, kind) => {
        statusEl.textContent = msg;
        statusEl.className = kind ? kind : "muted";
      };

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
                body: JSON.stringify({ public_token, user_id: "${String(user_id)}", institution_name: inst })
              });

              const text = await r.text();
              let data = null; try { data = JSON.parse(text); } catch {}
              if (!r.ok) throw new Error((data && (data.error?.error_message || data.error)) || text);

              setStatus("✅ Bank connected + saved!", "ok");
              detailsEl.style.display = "block";
              detailsEl.textContent = "plaid_item_id: " + data.plaid_item_id + "\\n(saved in Supabase)";
            } catch (e) {
              setStatus("❌ Exchange failed", "err");
              detailsEl.style.display = "block";
              detailsEl.textContent = String(e);
            }
          },
          onExit: (err) => {
            if (err) {
              setStatus("❌ Plaid exited with error", "err");
              detailsEl.style.display = "block";
              detailsEl.textContent = JSON.stringify(err);
            } else {
              setStatus("Plaid closed.");
            }
          }
        });
        handler.open();
      };
    </script>
  </body>
</html>`);
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (/plaid/web):", plaidData || err);
    return res.status(500).json({ ok: false, error: plaidData || err?.message || "Unknown error" });
  }
});

// =========================
// PLAID TRANSACTIONS RESET (AUTH) -> guarda en plaid_transactions + plaid_sync_state
// =========================
app.post("/plaid/transactions/reset", requireAuth, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase no configurado" });

    const user_id = req.user.id;

    const { data: rows, error: selErr } = await supabase
      .from("plaid_items")
      .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
      .eq("user_id", String(user_id))
      .not("plaid_item_id", "like", "ping_item_%")
      .order("id", { ascending: false })
      .limit(1);

    if (selErr) return res.status(500).json({ ok: false, supabase_error: selErr });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ ok: false, error: "No encontré plaid_items para este usuario" });

    // Borrar cursor
    await supabase.from("plaid_sync_state").delete().eq("plaid_item_id", String(row.plaid_item_id));

    // Token real
    const access_token = unwrapPlaidAccessToken(row.plaid_access_token);

    if (!String(access_token).startsWith("access-")) {
      return res.status(400).json({ ok: false, error: "access_token inválido" });
    }

    // Sync desde cero
    const resp = await plaidClient.transactionsSync({
      access_token,
      cursor: undefined,
    });

    const added = resp.data.added || [];
    const modified = resp.data.modified || [];
    const removed = resp.data.removed || [];
    const next_cursor = resp.data.next_cursor;
    const has_more = resp.data.has_more;

    // upsert tx
    const upRows = []
      .concat(added)
      .concat(modified)
      .filter((t) => t && t.transaction_id)
      .map((tx) => {
        const pfc = tx?.personal_finance_category || {};
        return {
          transaction_id: String(tx.transaction_id),
          user_id: String(user_id),
          plaid_item_id: String(row.plaid_item_id),
          account_id: String(tx.account_id),
          date: tx.date || null,
          authorized_date: tx.authorized_date || null,
          name: tx.name || null,
          merchant_name: tx.merchant_name || null,
          amount: tx.amount ?? null,
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

    if (upRows.length) {
      const { error: upErr } = await supabase.from("plaid_transactions").upsert(upRows, { onConflict: "transaction_id" });
      if (upErr) return res.status(500).json({ ok: false, supabase_error: upErr });
    }

    const removedIds = removed.map((r) => r?.transaction_id).filter(Boolean);
    if (removedIds.length) {
      const { error: rmErr } = await supabase
        .from("plaid_transactions")
        .update({ is_removed: true, removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in("transaction_id", removedIds);

      if (rmErr) return res.status(500).json({ ok: false, supabase_error: rmErr });
    }

    // guardar cursor
    const { error: curErr } = await supabase.from("plaid_sync_state").upsert(
      {
        user_id: String(user_id),
        plaid_item_id: String(row.plaid_item_id),
        next_cursor: String(next_cursor),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "plaid_item_id" }
    );
    if (curErr) return res.status(500).json({ ok: false, supabase_error: curErr });

    return res.json({
      ok: true,
      message: "Cursor reseteado. Sync desde cero ejecutada.",
      plaid_item_id: row.plaid_item_id,
      user_id,
      institution_name: row.institution_name,
      added_count: added.length,
      modified_count: modified.length,
      removed_count: removed.length,
      next_cursor,
      has_more,
      request_id: resp.data.request_id,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// =========================
// MICRO v2 (AUTH) - mínimo para probar: status / run / payout
// Tablas esperadas:
// - micro_rules_v2 (user_id unique)
// - micro_ledger_v2 (user_id unique)
// - micro_contributions_v2
// - plaid_transactions
// =========================
async function getMicroRule(user_id) {
  const { data } = await supabase.from("micro_rules_v2").select("*").eq("user_id", String(user_id)).maybeSingle();
  return data || null;
}
async function getLedger(user_id) {
  const { data } = await supabase.from("micro_ledger_v2").select("*").eq("user_id", String(user_id)).maybeSingle();
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
  await supabase.from("micro_ledger_v2").upsert(payload, { onConflict: "user_id" });
  return payload;
}
function calcContributionFixed(rule, purchaseAmount) {
  const min = Math.max(0, toNumber(rule?.min_purchase_amount, 1));
  const amt = Math.max(0, toNumber(purchaseAmount, 0));
  if (amt < min) return 0;
  const c = Math.max(0, toNumber(rule?.fixed_amount, 1));
  return Math.round(c * 100) / 100;
}

app.get("/micro/status", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const rule = await getMicroRule(user_id);
    const ledger = await getLedger(user_id);

    const { data: recent } = await supabase
      .from("micro_contributions_v2")
      .select("*")
      .eq("user_id", String(user_id))
      .order("created_at", { ascending: false })
      .limit(20);

    return res.json({ ok: true, rule: rule || null, ledger: ledger || null, recent: recent || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/micro/rule", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const payload = {
      user_id: String(user_id),
      enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true,
      auto_run: req.body?.auto_run !== undefined ? Boolean(req.body.auto_run) : true,
      payout_enabled: req.body?.payout_enabled !== undefined ? Boolean(req.body.payout_enabled) : true,
      payout_min_threshold: Math.max(0, toNumber(req.body?.payout_min_threshold, 20)),
      mode: String(req.body?.mode || "fixed"),
      fixed_amount: Math.max(0, toNumber(req.body?.fixed_amount, 1)),
      min_purchase_amount: Math.max(0, toNumber(req.body?.min_purchase_amount, 1)),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("micro_rules_v2").upsert(payload, { onConflict: "user_id" }).select("*");
    if (error) return res.status(500).json({ ok: false, supabase_error: error });
    return res.json({ ok: true, rule: data?.[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/micro/run", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const days_back = Math.min(3650, Math.max(1, Math.floor(toNumber(req.body?.days_back, 120))));

    const rule = await getMicroRule(user_id);
    if (!rule || !rule.enabled) {
      return res.json({ ok: true, message: "Micro-pagos desactivados o regla no existe.", created: 0, created_total: 0 });
    }

    const since = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data: tx, error } = await supabase
      .from("plaid_transactions")
      .select("transaction_id,date,amount,pending,is_removed")
      .eq("user_id", String(user_id))
      .eq("is_removed", false)
      .eq("pending", false)
      .gte("date", since);

    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    let created = 0;
    let created_total = 0;

    for (const t of tx || []) {
      const tid = String(t.transaction_id || "");
      if (!tid) continue;

      // evita duplicar contribuciones por la misma tx
      const { data: already } = await supabase
        .from("micro_contributions_v2")
        .select("id")
        .eq("user_id", String(user_id))
        .eq("transaction_id", tid)
        .limit(1);

      if (Array.isArray(already) && already.length > 0) continue;

      const purchaseAmount = Math.max(0, toNumber(t.amount, 0));
      const c = calcContributionFixed(rule, purchaseAmount);
      if (c <= 0) continue;

      const row = {
        user_id: String(user_id),
        plaid_item_id: null,
        transaction_id: tid,
        transaction_date: t.date || null,
        purchase_amount: purchaseAmount,
        contribution_amount: c,
        target_debt_id: rule.target_debt_id || null,
        status: "pending",
      };

      const { error: insErr } = await supabase.from("micro_contributions_v2").insert(row);
      if (insErr) continue;

      created += 1;
      created_total += c;
    }

    const ledger = (await getLedger(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
    const newPending = Math.round((toNumber(ledger.pending_total, 0) + created_total) * 100) / 100;

    await upsertLedger(user_id, { pending_total: newPending, last_run_at: new Date().toISOString() });

    return res.json({ ok: true, created, created_total: Number(created_total.toFixed(2)), pending_total: newPending });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/micro/payout/simulate", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const threshold = req.body?.threshold !== undefined ? Math.max(0, toNumber(req.body.threshold, 0)) : null;

    const rule = await getMicroRule(user_id);
    if (!rule || !rule.payout_enabled) {
      return res.json({ ok: true, message: "Payout desactivado o regla no existe.", paid: 0 });
    }

    const ledger = (await getLedger(user_id)) || { user_id, pending_total: 0, processed_total: 0 };
    const min = threshold !== null ? threshold : Math.max(0, toNumber(rule.payout_min_threshold, 20));
    const pending = Math.max(0, toNumber(ledger.pending_total, 0));

    if (pending < min) {
      return res.json({ ok: true, message: `Pendiente ${pending} < umbral ${min}. No payout.`, paid: 0, pending_total: pending });
    }

    const now = new Date().toISOString();

    const { error: updErr } = await supabase
      .from("micro_contributions_v2")
      .update({ status: "processed", processed_at: now })
      .eq("user_id", String(user_id))
      .eq("status", "pending");
    if (updErr) return res.status(500).json({ ok: false, supabase_error: updErr });

    const newProcessed = Math.round((toNumber(ledger.processed_total, 0) + pending) * 100) / 100;

    await upsertLedger(user_id, { pending_total: 0, processed_total: newProcessed, last_payout_at: now });

    return res.json({ ok: true, paid: Number(pending.toFixed(2)), pending_total: 0, processed_total: newProcessed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`✅ Debtya API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
  console.log(`✅ SUPABASE configured: ${Boolean(supabase)}`);
  console.log(`✅ TOKEN_ENCRYPTION_KEY configured: ${hasEncryptionKey()}`);
});