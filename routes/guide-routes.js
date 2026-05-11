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

function buildGuideLocalFallback(lang, message) {
  const hasQ = typeof message === "string" && message.trim().length > 0;
  const snippet = hasQ ? message.trim().slice(0, 120) : "";

  if (lang === "es") {
    return (
      "Estas en la beta de DebtYa (modo manual-first). DebtYa no mueve dinero ni ejecuta pagos: tu marcas lo que pagaste fuera de la app.\n\n" +
      (snippet ? `Sobre tu pregunta (“${snippet}${message.length > 120 ? "…" : ""}”): ` : "") +
      "No puedo dar asesoria financiera personalizada aqui. Para el producto: revisa la pestana FAQ, el plan de pago (avalanche/snowball) y el historial despues de confirmar con “Ya lo pagué”.\n\n" +
      "Soporte por email: contact@debtya.com\n\n" +
      "Esta respuesta es local (sin IA externa) porque el asistente conectado no esta configurado en este servidor."
    );
  }

  return (
    "You are on the DebtYa beta (manual-first). DebtYa does not move money or run payments for you; you confirm what you paid outside the app.\n\n" +
    (snippet ? `About your question (“${snippet}${message.length > 120 ? "…" : ""}”): ` : "") +
    "I cannot give personalized financial advice here. For the product itself, use the FAQ tab, your payoff plan (avalanche/snowball), and History after you tap “I paid it”.\n\n" +
    "Support email: contact@debtya.com\n\n" +
    "This answer was generated locally (no external AI) because the connected assistant is not configured on this server."
  );
}

function registerGuideRoutes(app, deps) {
  const { jsonError, appError, requireUser } = deps;

  const guideHardOff = process.env.OPENAI_GUIDE_DISABLED === "1";
  const openAiReady = Boolean(process.env.OPENAI_API_KEY) && !guideHardOff;

  app.get("/guide-assistant/status", (_req, res) => {
    return res.json({
      ok: true,
      enabled: !guideHardOff,
      mode: openAiReady ? "openai" : "local",
      openai_ready: Boolean(process.env.OPENAI_API_KEY) && !guideHardOff
    });
  });

  app.post("/guide-assistant", requireUser, async (req, res) => {
    try {
      if (guideHardOff) {
        return res.status(503).json({
          ok: false,
          disabled: true,
          error: "Assistant disabled on this server"
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

      if (!openAiReady) {
        const reply = buildGuideLocalFallback(lang, message);
        return res.json({ ok: true, mode: "local", reply });
      }

      const axios = require("axios");
      const model = process.env.OPENAI_GUIDE_MODEL || "gpt-4o-mini";
      const langLine =
        lang === "es"
          ? "Respond entirely in Spanish."
          : "Respond entirely in English.";

      const system = `You are the in-app guide for DebtYa, a debt payoff copilot. The default experience is manual-first: users add debts from their statements, choose avalanche or snowball, save a plan, see a recommended next payment, pay their lender or bank themselves, then confirm in DebtYa with “I paid it” / “Ya lo pagué”. DebtYa does not move money or execute payments for users. Optional bank-style linking may exist for some workspaces but is never required to use the product.

Answer only about signing up, using the DebtYa screens, reminders, history, and general product questions.

Do not ask the user to pay inside the chat, do not push subscriptions or checkout, and do not promise automatic payments.

Never give personalized financial, legal, tax, or investment advice. Do not promise results. Remind users to verify APR and minimum payments on their statements when relevant.

If you are unsure or the question is outside DebtYa, suggest contacting contact@debtya.com.

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

      return res.json({ ok: true, mode: "openai", reply });
    } catch (err) {
      appError("[guide-assistant]", err.response?.data || err.message);
      const msg =
        err.response?.data?.error?.message || err.message || "Unknown error";
      return jsonError(res, 500, "Assistant request failed", { details: msg });
    }
  });
}

module.exports = { registerGuideRoutes };
