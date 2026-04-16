function registerCoreRoutes(app, deps) {
  const {
    SERVER_VERSION,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET,
    STRIPE_SECRET_KEY,
    STRIPE_PRICE_ID_BETA_MONTHLY,
    STRIPE_WEBHOOK_SECRET,
    requireUser,
    supabaseAdmin,
    sortTraceRows,
    getIntentAmount,
    appDebug,
    jsonError
  } = deps;

  app.get("/health", async (_req, res) => {
    const payload = {
      ok: true,
      message: "DebtYa API funcionando",
      server_version: SERVER_VERSION,
      now: new Date().toISOString()
    };

    const exposeEnvDebug =
      process.env.NODE_ENV !== "production" ||
      process.env.HEALTH_EXPOSE_DEBUG === "1";

    if (exposeEnvDebug) {
      payload.env_debug = {
        has_supabase_url: !!SUPABASE_URL,
        has_anon_key: !!SUPABASE_ANON_KEY,
        has_service_role_key: !!SUPABASE_SERVICE_ROLE_KEY,
        has_cron_secret: !!CRON_SECRET,
        has_stripe_secret_key: !!STRIPE_SECRET_KEY,
        has_stripe_price_id_beta_monthly: !!STRIPE_PRICE_ID_BETA_MONTHLY,
        has_stripe_webhook_secret: !!STRIPE_WEBHOOK_SECRET,
        has_openai_guide: !!process.env.OPENAI_API_KEY,
        guide_assistant_disabled: process.env.OPENAI_GUIDE_DISABLED === "1"
      };
    }

    return res.json(payload);
  });

  app.get("/payment-trace", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("v_payment_trace")
        .select("*")
        .eq("user_id", req.user.id);

      if (!error) {
        return res.json({
          ok: true,
          source: "v_payment_trace",
          data: sortTraceRows(data || [])
        });
      }

      appDebug("Fallback payment-trace por error en vista:", error.message);

      const { data: intents, error: fallbackError } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false });

      if (fallbackError) throw fallbackError;

      const normalized = (intents || []).map((x) => ({
        id: x.id,
        user_id: x.user_id,
        debt_id: x.debt_id,
        status: x.status,
        total_amount: getIntentAmount(x),
        scheduled_for: x.scheduled_for,
        approved_at: x.approved_at,
        executed_at: x.executed_at,
        created_at: x.created_at,
        updated_at: x.updated_at,
        metadata: x.metadata || null
      }));

      return res.json({
        ok: true,
        source: "payment_intents_fallback",
        data: sortTraceRows(normalized)
      });
    } catch (error) {
      return jsonError(res, 500, "Error cargando trace", {
        details: error.message
      });
    }
  });
}

module.exports = { registerCoreRoutes };
