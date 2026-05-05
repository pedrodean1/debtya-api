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
  return "DebtYa recommends this payment because it helps move your current plan forward and reduces this debt balance. Make the payment outside DebtYa, then mark it as paid.";
}

function visibleDebtName(name) {
  const s = String(name || "").trim() || "Debt";
  return s.replace(/^Spinwheel\s+/i, "").slice(0, 120);
}

function registerAiCoachRoutes(app, deps) {
  const {
    jsonError,
    appError,
    requireUser,
    supabaseAdmin,
    getIntentAmount,
    isUuid,
    safeNumber
  } = deps;

  app.post("/ai/explain-next-payment", requireUser, async (req, res) => {
    const langEarly =
      req.body?.locale === "es" || req.body?.lang === "es" ? "es" : "en";
    try {
      const lang = langEarly;
      const intentId =
        req.body?.intent_id != null ? String(req.body.intent_id).trim() : "";

      if (!intentId) {
        return jsonError(res, 400, "intent_id is required");
      }
      if (!isUuid(intentId)) {
        return jsonError(res, 400, "intent_id must be a valid UUID");
      }

      const { data: intent, error: intentErr } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("id", intentId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (intentErr) throw intentErr;
      if (!intent) {
        return jsonError(res, 404, "Intent not found");
      }

      const debtId =
        intent.debt_id != null ? String(intent.debt_id).trim() : "";
      if (!debtId || !isUuid(debtId)) {
        return jsonError(res, 400, "Intent must have a valid debt_id");
      }

      const { data: debt, error: debtErr } = await supabaseAdmin
        .from("debts")
        .select("*")
        .eq("id", debtId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (debtErr) throw debtErr;
      if (!debt) {
        return jsonError(res, 404, "Debt not found");
      }

      const { data: planRow, error: planErr } = await supabaseAdmin
        .from("payment_plans")
        .select("strategy")
        .eq("user_id", req.user.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (planErr) throw planErr;

      const strategy =
        String(planRow?.strategy || intent.strategy || "avalanche")
          .toLowerCase()
          .trim() || "avalanche";

      const paymentAmount = getIntentAmount(intent);
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        return jsonError(
          res,
          400,
          "Invalid recommended payment amount for this intent"
        );
      }

      const rateKey = `coach:${req.user.id}`;
      if (!coachCheckRate(rateKey)) {
        return jsonError(res, 429, "Too many requests. Try again later.");
      }

      const apiKey = stripOpenAiKey(process.env.OPENAI_API_KEY);
      if (!apiKey || process.env.OPENAI_COACH_DISABLED === "1") {
        return res.json({ ok: true, explanation: localFallbackExplanation(lang) });
      }

      const debtName = visibleDebtName(debt.name);
      const balance = safeNumber(debt.balance);
      const minPay = safeNumber(debt.minimum_payment);
      const aprRaw = debt.apr ?? debt.interest_rate;
      const aprNum =
        aprRaw != null && aprRaw !== ""
          ? safeNumber(aprRaw)
          : null;

      const facts = {
        locale: lang,
        strategy,
        debt_name: debtName,
        balance,
        recommended_payment_amount: paymentAmount
      };
      if (minPay > 0) facts.minimum_payment = minPay;
      if (aprNum != null && Number.isFinite(aprNum) && aprNum >= 0) {
        facts.apr = aprNum;
      }

      const factsStr = JSON.stringify(facts).slice(0, 4000);

      const model =
        process.env.OPENAI_COACH_MODEL ||
        process.env.OPENAI_GUIDE_MODEL ||
        "gpt-4o-mini";

      const system =
        lang === "es"
          ? "Eres el asistente breve de DebtYa. El usuario ve en el panel un monto recomendado hacia una deuda. Explica en 2 o 3 frases cortas, en español sencillo, por qué encaja priorizar este pago con la estrategia indicada (avalancha = priorizar mayor interés/APR; bola de nieve = priorizar menor saldo) usando solo los datos JSON enviados. No prometas resultados garantizados ni asesoría legal o financiera garantizada. No digas que DebtYa mueve dinero ni paga al acreedor: la persona paga fuera de DebtYa y marca el pago en la app."
          : "You are DebtYa's brief coach. The user sees a recommended amount to pay toward a debt on the dashboard. In 2 or 3 short simple sentences, explain why paying toward this debt now fits their stated strategy (avalanche = higher interest/APR first; snowball = smaller balance first), using only the JSON facts provided. Do not promise guaranteed outcomes or guaranteed legal/financial advice. Never say DebtYa moves money or pays the lender: the user pays outside DebtYa and marks it paid here.";

      const userMsg = `Facts JSON:\n${factsStr}`;

      try {
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

        let explanation = String(
          r.data?.choices?.[0]?.message?.content || ""
        ).trim();
        if (!explanation) {
          explanation = localFallbackExplanation(lang);
        }
        if (explanation.length > 1200) {
          explanation = explanation.slice(0, 1200);
        }

        return res.json({ ok: true, explanation });
      } catch (aiErr) {
        appError(
          "[ai/explain-next-payment]",
          aiErr.response?.data || aiErr.message
        );
        return res.json({
          ok: true,
          explanation: localFallbackExplanation(lang)
        });
      }
    } catch (err) {
      appError("[ai/explain-next-payment]", err.response?.data || err.message);
      return jsonError(res, 500, "Could not explain payment", {
        details: err.message
      });
    }
  });
}

module.exports = { registerAiCoachRoutes };
