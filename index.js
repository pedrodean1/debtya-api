require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { PlaidApi, Configuration, PlaidEnvironments } = require("plaid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================
// Plaid
// =============================
const plaidEnv = (process.env.PLAID_ENV || "sandbox").toLowerCase();

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaid = new PlaidApi(plaidConfig);

// =============================
// Supabase
// =============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =============================
// Routes
// =============================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Create Link Token
app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: true, message: "user_id is required" });
    }

    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "Debtya",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    return res.json(response.data);
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (create_link_token):", plaidData || err);

    return res.status(err?.response?.status || 500).json({
      error: true,
      message: plaidData?.error_message || err?.message || "Unknown error",
      error_code: plaidData?.error_code,
      error_type: plaidData?.error_type,
      display_message: plaidData?.display_message,
      request_id: plaidData?.request_id,
    });
  }
});

// Exchange public_token -> access_token and store in Supabase
app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { user_id, public_token, institution_name } = req.body;

    if (!user_id || !public_token) {
      return res.status(400).json({
        error: true,
        message: "user_id and public_token are required",
      });
    }

    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const { error } = await supabase.from("plaid_items").insert({
      user_id,
      plaid_item_id: item_id,
      plaid_access_token: access_token,
      institution_name: institution_name || null,
    });

    if (error) {
      console.error("SUPABASE INSERT ERROR:", error);
      return res.status(500).json({ error: true, message: error.message });
    }

    return res.json({ ok: true, item_id });
  } catch (err) {
    const plaidData = err?.response?.data;
    console.error("PLAID ERROR (exchange_public_token):", plaidData || err);

    return res.status(err?.response?.status || 500).json({
      error: true,
      message: plaidData?.error_message || err?.message || "Unknown error",
      error_code: plaidData?.error_code,
      error_type: plaidData?.error_type,
      display_message: plaidData?.display_message,
      request_id: plaidData?.request_id,
    });
  }
});

// =============================
// Start
// =============================
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  console.log(`PLAID_ENV=${plaidEnv}`);
});