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

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, name: "debtya-api", env: PLAID_ENV, time: new Date().toISOString() });
});

// 1) Create link_token (works for both native + web)
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

// 2) Exchange public_token -> access_token
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { public_token, user_id } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "public_token is required" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });

    return res.json({
      ok: true,
      access_token: exchange.data.access_token,
      item_id: exchange.data.item_id,
      user_id: user_id || null,
    });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (exchange_public_token):", plaidData || err);
    return res.status(400).json(plaidData || { error: err?.message || "Unknown error" });
  }
});

// 3) Create link URL for Web (Plaid Link in browser)
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

// Redirect endpoint (just needs to exist)
app.get("/plaid/redirect", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
  console.log(`✅ PLAID_ENV=${PLAID_ENV}`);
});