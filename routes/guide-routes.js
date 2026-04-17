const guideRateByIp = new Map();
const GUIDE_RATE_MAX = 24;
const GUIDE_RATE_WINDOW_MS = 60 * 60 * 1000;

function guideCheckRate(key) {
  const now = Date.now();
  let row = guideRateByIp.get(key);
  if (!row || now - row.windowStart > GUIDE_RATE_WINDOW_MS) {
    row = { count: 0, windowStart: now };
  }
  if (row.count >= GUIDE_RATE_MAX) {
    guideRateByIp.set(key, row);
    return false;
  }
  row.count += 1;
  guideRateByIp.set(key, row);
  return true;
}

function registerGuideRoutes(app, deps) {
  const { jsonError, appError, requireUser } = deps;

  app.get("/guide-assistant/status", (_req, res) => {
    const enabled =
      Boolean(process.env.OPENAI_API_KEY) &&
      process.env.OPENAI_GUIDE_DISABLED !== "1";
    return res.json({ ok: true, enabled });
  });

  app.post("/guide-assistant", requireUser, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_GUIDE_DISABLED === "1") {
        return res.status(503).json({
          ok: false,
          disabled: true,
          error: "Assistant not configured"
        });
      }

      const rateKey = `user:${req.user.id}`;
      if (!guideCheckRate(rateKey)) {
        return jsonError(
          res,
          429,
          "Too many questions right now. Try again a bit later."
        );
      }

      const lang = req.body?.lang === "es" ? "es" : "en";
      const message = String(req.body?.message || "").trim().slice(0, 2500);
      if (!message) {
        return jsonError(res, 400, "Message is required");
      }

      const axios = require("axios");
      const model = process.env.OPENAI_GUIDE_MODEL || "gpt-4o-mini";
      const langLine =
        lang === "es"
          ? "Respond entirely in Spanish."
          : "Respond entirely in English.";

      const system = `You are the in-app guide for DebtYa, a web app that helps people organize paying down debt. Users connect their bank with Plaid, import accounts, add debts (balance, APR, minimum payment), choose avalanche or snowball strategy, set simple rules, prepare and approve suggested payment intents, execute them, and review history. Subscriptions are handled with Stripe.

Answer only about signing up, connecting the bank, using the DebtYa screens, and general product questions.

Never give personalized financial, legal, tax, or investment advice. Do not promise results. Remind users to verify APR and minimum payments on their statements when relevant.

If you are unsure or the question is outside DebtYa, suggest contacting support@debtya.com.

Keep answers concise (roughly under 180 words unless the user asks for more detail).

${langLine}`;

      const r = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: message }
          ],
          max_tokens: 650,
          temperature: 0.35
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 45000
        }
      );

      const reply = r.data?.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        return jsonError(res, 502, "Assistant returned an empty answer");
      }

      return res.json({ ok: true, reply });
    } catch (err) {
      appError("[guide-assistant]", err.response?.data || err.message);
      const msg =
        err.response?.data?.error?.message || err.message || "Unknown error";
      return jsonError(res, 500, "Assistant request failed", { details: msg });
    }
  });
}

module.exports = { registerGuideRoutes };
