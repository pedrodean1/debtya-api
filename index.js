import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PlaidApi, Configuration, PlaidEnvironments } from "plaid";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
      },
    },
  })
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/plaid/create_link_token", async (req, res) => {
  try {
    const { user_id } = req.body;

    const resp = await plaid.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: "Debtya",
      products: ["auth", "transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json(resp.data);
  } catch (e) {
    res.status(400).json({ error: e?.response?.data || e.message });
  }
});

app.post("/plaid/exchange_public_token", async (req, res) => {
  try {
    const { user_id, public_token, institution_name } = req.body;

    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const { error } = await supabase.from("plaid_items").insert({
      user_id,
      plaid_item_id: item_id,
      plaid_access_token: access_token,
      institution_name: institution_name || null,
    });

    if (error) throw error;

    res.json({ ok: true, item_id });
  } catch (e) {
    res.status(400).json({ error: e?.response?.data || e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API running on port", port));