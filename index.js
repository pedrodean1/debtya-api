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

// -------------------- Encriptación Token (AES-256-GCM) --------------------
function getKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!key || key.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY falta o es muy corta (mínimo 32 caracteres)");
  }
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

// ✅ Desencripta si corresponde, si no devuelve plano (compatibilidad)
function unwrapAccessToken(maybeEncrypted) {
  const s = String(maybeEncrypted || "");
  const parts = s.split(".");
  if (parts.length === 3) return decryptToken(s);
  return s;
}

function looksLikePlaidAccessToken(s) {
  return typeof s === "string" && s.startsWith("access-");
}

// -------------------- Routes --------------------
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

// Debe estar configurado en Plaid Dashboard -> Developers -> API -> Allowed redirect URIs
app.get("/plaid/redirect", (req, res) => {
  res.status(200).send("OK");
});

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

    return res.json({
      ok: true,
      link_token: response.data.link_token,
      expiration: response.data.expiration,
      request_id: response.data.request_id,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (create_link_token):", plaidData || err);
    return res.status(500).json({ ok: false, error: plaidData || err?.message || "Unknown error" });
  }
});

// Exchange public_token -> access_token + guardar en Supabase (token encriptado)
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id, institution_name } = req.body || {};
    if (!public_token) return res.status(400).json({ ok: false, error: "public_token is required" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    if (!supabase) {
      return res.status(500).json({ ok: false, error: "Supabase not configured" });
    }

    const encrypted_access_token = encryptToken(access_token);

    const payload = {
      user_id: String(user_id || "pedro-dev-1"),
      plaid_item_id: item_id,
      plaid_access_token: encrypted_access_token,
      institution_name: institution_name || null,
    };

    const { data, error } = await supabase
      .from("plaid_items")
      .upsert(payload, { onConflict: "plaid_item_id" })
      .select("*");

    if (error) {
      console.error("SUPABASE ERROR (save plaid_items):", error);
      return res.status(500).json({ ok: false, where: "save_plaid_items", supabase_error: error });
    }

    return res.json({
      ok: true,
      item_id,
      user_id: payload.user_id,
      institution_name: payload.institution_name,
      saved: data,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (exchange_public_token):", plaidData || err);
    return res.status(400).json(plaidData || { ok: false, error: err?.message || "Unknown error" });
  }
});

// Página web (captura public_token y llama a exchange)
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
                body: JSON.stringify({
                  public_token,
                  user_id: "${user_id}",
                  institution_name: inst
                })
              });

              const text = await r.text();
              let data = null;
              try { data = JSON.parse(text); } catch {}

              if (!r.ok) {
                const msg = (data && (data.error?.error_message || data.error)) || text;
                throw new Error(msg);
              }

              setStatus("✅ Bank connected + saved!", "ok");
              detailsEl.style.display = "block";
              detailsEl.textContent =
                "plaid_item_id: " + data.item_id +
                "\\n(guardado en Supabase con token encriptado)";
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

// -------------------- Plaid Accounts --------------------
app.post("/plaid/accounts", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { plaid_item_id, user_id } = req.body || {};
    if (!plaid_item_id && !user_id) {
      return res.status(400).json({ ok: false, error: "Envía plaid_item_id o user_id" });
    }

    let row = null;

    if (plaid_item_id) {
      const { data, error } = await supabase
        .from("plaid_items")
        .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
        .eq("plaid_item_id", String(plaid_item_id))
        .limit(1)
        .maybeSingle();

      if (error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: error });
      row = data;
    } else {
      const { data, error } = await supabase
        .from("plaid_items")
        .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
        .eq("user_id", String(user_id))
        .not("plaid_item_id", "like", "ping_item_%")
        .order("id", { ascending: false })
        .limit(1);

      if (error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: error });
      row = Array.isArray(data) ? data[0] : null;

      if (!row) {
        const fallback = await supabase
          .from("plaid_items")
          .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
          .eq("user_id", String(user_id))
          .order("id", { ascending: false })
          .limit(1);

        if (fallback.error) {
          return res.status(500).json({ ok: false, where: "supabase_select_fallback", supabase_error: fallback.error });
        }
        row = Array.isArray(fallback.data) ? fallback.data[0] : null;
      }
    }

    if (!row) {
      return res.status(404).json({ ok: false, error: "No encontré plaid_items para ese plaid_item_id/user_id" });
    }

    const access_token = unwrapAccessToken(row.plaid_access_token);

    if (!looksLikePlaidAccessToken(access_token)) {
      return res.status(400).json({
        ok: false,
        error: "El access_token que salió NO parece un token de Plaid (no empieza con 'access-').",
        used_row: {
          plaid_item_id: row.plaid_item_id,
          user_id: row.user_id,
          institution_name: row.institution_name,
        },
      });
    }

    const resp = await plaidClient.accountsGet({ access_token });

    return res.json({
      ok: true,
      plaid_item_id: row.plaid_item_id,
      user_id: row.user_id,
      institution_name: row.institution_name,
      accounts: resp.data.accounts,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (/plaid/accounts):", plaidData || err);
    return res.status(500).json({ ok: false, error: plaidData || String(err) });
  }
});

// -------------------- NUEVO: Plaid Transactions Sync --------------------
// body: { user_id: "..." } o { plaid_item_id: "..." }  (opcional: cursor: "..." )
app.post("/plaid/transactions/sync", async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const { plaid_item_id, user_id, cursor } = req.body || {};
    if (!plaid_item_id && !user_id) {
      return res.status(400).json({ ok: false, error: "Envía plaid_item_id o user_id" });
    }

    // 1) Buscar row en Supabase (igual que accounts)
    let row = null;

    if (plaid_item_id) {
      const { data, error } = await supabase
        .from("plaid_items")
        .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
        .eq("plaid_item_id", String(plaid_item_id))
        .limit(1)
        .maybeSingle();

      if (error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: error });
      row = data;
    } else {
      const { data, error } = await supabase
        .from("plaid_items")
        .select("plaid_item_id, plaid_access_token, institution_name, user_id, id")
        .eq("user_id", String(user_id))
        .not("plaid_item_id", "like", "ping_item_%")
        .order("id", { ascending: false })
        .limit(1);

      if (error) return res.status(500).json({ ok: false, where: "supabase_select", supabase_error: error });
      row = Array.isArray(data) ? data[0] : null;
    }

    if (!row) {
      return res.status(404).json({ ok: false, error: "No encontré plaid_items para ese plaid_item_id/user_id" });
    }

    // 2) Desencriptar token
    const access_token = unwrapAccessToken(row.plaid_access_token);

    if (!looksLikePlaidAccessToken(access_token)) {
      return res.status(400).json({
        ok: false,
        error: "El access_token que salió NO parece un token de Plaid (no empieza con 'access-').",
        used_row: {
          plaid_item_id: row.plaid_item_id,
          user_id: row.user_id,
          institution_name: row.institution_name,
        },
      });
    }

    // 3) Llamar Plaid transactionsSync
    const resp = await plaidClient.transactionsSync({
      access_token,
      cursor: cursor ? String(cursor) : undefined,
    });

    return res.json({
      ok: true,
      plaid_item_id: row.plaid_item_id,
      user_id: row.user_id,
      institution_name: row.institution_name,
      added: resp.data.added,
      modified: resp.data.modified,
      removed: resp.data.removed,
      next_cursor: resp.data.next_cursor,
      has_more: resp.data.has_more,
      request_id: resp.data.request_id,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (/plaid/transactions/sync):", plaidData || err);
    return res.status(500).json({ ok: false, error: plaidData || String(err) });
  }
});

// -------------------- Supabase Ping --------------------
app.post("/supabase/ping", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, error: "Supabase not configured" });
    }

    const user_id = req.body?.user_id || "ping-user";
    const now = new Date().toISOString();

    const row = {
      user_id: String(user_id),
      plaid_item_id: `ping_item_${Date.now()}`,
      plaid_access_token: encryptToken(`ping_access_${Date.now()}`),
      institution_name: `PING ${now}`,
    };

    const { data, error } = await supabase.from("plaid_items").insert(row).select("*");

    if (error) {
      console.error("SUPABASE ERROR (ping insert):", error);
      return res.status(500).json({ ok: false, where: "supabase_ping", supabase_error: error });
    }

    return res.json({ ok: true, inserted: data });
  } catch (err) {
    return res.status(500).json({ ok: false, where: "supabase_ping", error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Debtya API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
  console.log(`✅ SUPABASE configured: ${Boolean(supabase)}`);
  console.log(`✅ TOKEN_ENCRYPTION_KEY configured: ${Boolean(process.env.TOKEN_ENCRYPTION_KEY)}`);
});
