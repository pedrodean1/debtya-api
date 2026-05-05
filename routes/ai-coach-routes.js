const axios = require("axios");

const coachRateByUser = new Map();
const COACH_RATE_MAX = 30;
const COACH_RATE_WINDOW_MS = 60 * 60 * 1000;

function coachCheckRate(key) {
  const now = Date.now();
  let row = coachRateByUser.get(key);
  if (!row || now - row.windowStart > COACH_RATE_WINDOW_MS) {
    row = { count: 0, windowStart: now };
  }
  if (row.count >= COACH_RATE_MAX) {
    coachRateByUser.set(key, row);
    return false;
  }
  row.count += 1;
  coachRateByUser.set(key, row);
  return true;
}

function stripOpenAiKey(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function localFallbackExplanation(lang) {
  if (lang === "es") {
    return "DebtYa recomienda este pago porque ayuda a avanzar tu plan actual y reduce el balance de esta deuda. Haz el pago fuera de DebtYa y luego márcalo como realizado.";
  }
  return "DebtYa recommends this payment because it helps you move forward with your current plan and lowers this debt's balance. Pay your lender outside DebtYa, then mark it as paid here.";
}

function registerAiCoachRoutes(app, deps) {
  const { jsonError, appError, requireUser } = deps;

  app.post("/ai/explain-next-payment", requireUser, async (req, res) => {
    const langEarly = req.body?.lang === "es" ? "es" : "en";
    try {
      const lang = langEarly;
      const strategy = String(req.body?.strategy || "avalanche").toLowerCase();
      const intent = req.body?.intent;
      const debt = req.body?.debt;
      const paymentAmount = Number(req.body?.payment_amount);

      if (!intent || typeof intent !== "object") {
        return jsonError(res, 400, "intent is required");
      }
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        return jsonError(res, 400, "payment_amount must be a positive number");
      }

      const rateKey = `coach:${req.user.id}`;
      if (!coachCheckRate(rateKey)) {
        return jsonError(res, 429, "Too many requests. Try again later.");
      }

      const apiKey = stripOpenAiKey(process.env.OPENAI_API_KEY);
      if (!apiKey || process.env.OPENAI_COACH_DISABLED === "1") {
        return res.json({ ok: true, explanation: localFallbackExplanation(lang) });
      }

      const model =
        process.env.OPENAI_COACH_MODEL ||
        process.env.OPENAI_GUIDE_MODEL ||
        "gpt-4o-mini";
      const facts = JSON.stringify(
        { strategy, intent, debt, payment_amount: paymentAmount },
        null,
        0
      ).slice(0, 8000);

      const system =
        lang === "es"
          ? "Eres el asistente breve de DebtYa. El usuario ve en el panel un monto a pagar hacia una deuda. Explica en 2 o 3 frases cortas, en español sencillo, por qué encaja priorizar este pago con la estrategia indicada (avalancha = priorizar mayor APR; bola de nieve = priorizar menor saldo) usando solo los datos enviados. No prometas resultados garantizados. No digas que DebtYa mueve dinero ni paga al acreedor: la persona paga fuera de DebtYa y marca el pago en la app. No des asesoría financiera personalizada más allá de explicar el orden del plan."
          : "You are DebtYa's brief coach. The user sees an amount to pay toward a debt on the dashboard. In 2 or 3 short simple sentences, explain why paying toward this debt now fits their stated strategy (avalanche = higher APR first; snowball = smaller balance first), using only the facts provided. Do not promise guaranteed outcomes. Never say DebtYa moves money or pays the lender: the user pays outside DebtYa and marks it paid here. Do not give personalized financial advice beyond explaining plan ordering.";

      const userMsg = `Facts JSON:\n${facts}`;

      const r = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg }
          ],
          max_tokens: 180,
          temperature: 0.35
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 45000
        }
      );

      let explanation = String(r.data?.choices?.[0]?.message?.content || "").trim();
      if (!explanation) {
        explanation = localFallbackExplanation(lang);
      }
      if (explanation.length > 1200) {
        explanation = explanation.slice(0, 1200);
      }

      return res.json({ ok: true, explanation });
    } catch (err) {
      appError("[ai/explain-next-payment]", err.response?.data || err.message);
      return res.json({ ok: true, explanation: localFallbackExplanation(langEarly) });
    }
  });
}

module.exports = { registerAiCoachRoutes };
