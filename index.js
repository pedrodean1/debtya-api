// Web Link URL (opens Plaid in browser)
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

// redirect endpoint (must exist)
app.get("/plaid/redirect", (req, res) => {
  res.status(200).send("OK");
});