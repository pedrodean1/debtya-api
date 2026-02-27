require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================
// Plaid configuration
// =============================

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// =============================
// Health check
// =============================

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// =============================
// Create Link Token
// =============================

app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: user_id,
      },
      client_name: "Debtya",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json(response.data);
  } catch (err) {
    const plaidData = err?.response?.data;

    console.error("PLAID ERROR:", plaidData || err);

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
// Start server
// =============================

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});