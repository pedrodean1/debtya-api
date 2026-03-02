require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Plaid environment
const PLAID_ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const basePath =
  PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PLAID_ENV === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

// Plaid client
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

// --- Health ---
app.get("/health", (req, res) => {
  res.json({ ok: true, name: "debtya-api", env: PLAID_ENV, time: new Date().toISOString() });
});

// --- Redirect endpoint (must exist + must be configured in Plaid Dashboard Allowed redirect URIs) ---
app.get("/plaid/redirect", (req, res) => {
  res.status(200).send("OK");
});

// --- 1) Create link_token (for mobile or general use) ---
app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const user_id = req.body?.user_id || "pedro-dev-1";

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user_id) },
      client_name: "Debtya",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
      // IMPORTANT: must be configured in Plaid Dashboard -> Developers -> API -> Allowed redirect URIs
      redirect_uri: "https://debtya-api.onrender.com/plaid/redirect",
    });

    return res.json({
      link_token: response.data.link_token,
      expiration: response.data.expiration,
      request_id: response.data.request_id,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (create_link_token):", plaidData || err);
    return res.status(500).json({ error: plaidData || err?.message || "Unknown error" });
  }
});

// --- 2) Exchange public_token -> access_token ---
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "public_token is required" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });

    // ✅ Aquí es donde luego guardarías access_token en DB (Supabase) por user_id
    // const access_token = exchange.data.access_token;
    // const item_id = exchange.data.item_id;

    return res.json({
      ok: true,
      access_token: exchange.data.access_token,
      item_id: exchange.data.item_id,
      user_id: user_id || null,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (exchange_public_token):", plaidData || err);
    // Plaid errors often come as structured JSON
    return res.status(400).json(plaidData || { error: err?.message || "Unknown error" });
  }
});

// --- 3) Create link URL for web (simple URL) ---
// NOTE: This only opens Plaid, it does NOT capture public_token by itself.
// The definitive way is /plaid/web below.
app.post("/plaid/create_link_for_web", async (req, res) => {
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

    const link_url =
      "https://cdn.plaid.com/link/v2/stable/link.html?token=" +
      encodeURIComponent(response.data.link_token);

    return res.json({
      link_token: response.data.link_token,
      link_url,
      expiration: response.data.expiration,
      request_id: response.data.request_id,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (create_link_for_web):", plaidData || err);
    return res.status(500).json({ error: plaidData || err?.message || "Unknown error" });
  }
});

// --- 4) DEFINITIVE WEB FLOW: Host a page that opens Plaid Link JS and captures public_token ---
// Open this URL from the app: https://debtya-api.onrender.com/plaid/web?user_id=pedro-dev-1
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
              const r = await fetch("/plaid/exchange_public_token", {
                method: "POST",
                headers: {"Content-Type":"application/json"},
                body: JSON.stringify({ public_token, user_id: "${user_id}" })
              });
              const text = await r.text();
              let data = null;
              try { data = JSON.parse(text); } catch {}

              if (!r.ok) {
                const msg = (data && (data.error?.error_message || data.error)) || text;
                throw new Error(msg);
              }

              setStatus("✅ Bank connected!", "ok");
              detailsEl.style.display = "block";
              detailsEl.textContent = "item_id: " + data.item_id + "\\n(access_token received)";
            } catch (e) {
              setStatus("❌ Exchange failed", "err");
              detailsEl.style.display = "block";
              detailsEl.textContent = String(e);
            }
          },
          onExit: (err, metadata) => {
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
    return res.status(500).json({ error: plaidData || err?.message || "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Debtya API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
});