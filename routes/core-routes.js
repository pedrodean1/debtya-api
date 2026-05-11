const { isMethodConfigured, readMethodEnv, readMethodApiVersion, readMethodKeyStatus } = require("../lib/method-env");
const { isSpinwheelConfigured, readSpinwheelEnv, readSpinwheelKeyStatus } = require("../lib/spinwheel-env");

function traceIntentMetadata(meta) {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta;
  if (typeof meta === "string") {
    const s = meta.trim();
    if (!s) return {};
    try {
      const p = JSON.parse(s);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

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
    const methodOn = isMethodConfigured();
    const methodStatus = readMethodKeyStatus();
    const spinOn = isSpinwheelConfigured();
    const spinStatus = readSpinwheelKeyStatus();
    const payload = {
      ok: true,
      message: "DebtYa API funcionando",
      server_version: SERVER_VERSION,
      bank_disconnect_page: "/bank-disconnect",
      bank_disconnect_page_alt: "/disconnect-bank.html",
      bank_disconnect_page_plaid: "/plaid/manage-disconnect",
      bank_disconnect_page_api: "/api/bank-disconnect",
      now: new Date().toISOString(),
      has_method_api_key: methodStatus.configured,
      method_key_source: methodStatus.key_source,
      method_configured: methodOn,
      method_env: methodOn ? readMethodEnv() : null,
      method_api_version: methodOn ? readMethodApiVersion() : null,
      spinwheel_configured: spinOn,
      spinwheel_key_source: spinStatus.key_source,
      spinwheel_env: readSpinwheelEnv(),
      has_spinwheel_api_secret: spinOn
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
        guide_assistant_disabled: process.env.OPENAI_GUIDE_DISABLED === "1",
        has_method_api_key: methodOn,
        has_spinwheel_api_secret: spinOn
      };
    }

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");

    return res.json(payload);
  });

  app.get("/payment-trace", requireUser, async (req, res) => {
    try {
      const userId = req.user.id;

      const { data: intents, error: intentErr } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("user_id", userId)
        .or("executed_at.not.is.null,status.eq.executed")
        .order("executed_at", { ascending: false, nullsFirst: false })
        .limit(200);

      if (intentErr) throw intentErr;

      const intentIds = new Set((intents || []).map((x) => x && x.id).filter(Boolean));

      const { data: execs, error: execErr } = await supabaseAdmin
        .from("payment_executions")
        .select("*")
        .eq("user_id", userId)
        .order("executed_at", { ascending: false, nullsFirst: false })
        .limit(200);

      if (execErr) {
        appDebug("payment-trace: payment_executions omitido:", execErr.message);
      }

      const normalized = [];

      for (const x of intents || []) {
        const meta = traceIntentMetadata(x.metadata);
        const manual = !!(meta.manual_confirmed || meta.paid_outside_app);
        const origin = manual ? "manual" : String(x.source || "intent").toLowerCase();
        normalized.push({
          id: x.id,
          user_id: x.user_id,
          debt_id: x.debt_id,
          status: x.status,
          total_amount: getIntentAmount(x),
          amount: getIntentAmount(x),
          scheduled_for: x.scheduled_for,
          approved_at: x.approved_at,
          executed_at: x.executed_at,
          created_at: x.created_at,
          updated_at: x.updated_at,
          metadata: x.metadata || null,
          trace_origin: origin
        });
      }

      for (const ex of execs || []) {
        const pid = ex.payment_intent_id;
        if (!pid || intentIds.has(pid)) continue;
        const amt = Number(ex.amount ?? ex.total_amount ?? 0);
        normalized.push({
          id: ex.id || pid,
          user_id: ex.user_id,
          debt_id: ex.debt_id || null,
          status: ex.status || "executed",
          total_amount: amt,
          amount: amt,
          scheduled_for: null,
          approved_at: null,
          executed_at: ex.executed_at || ex.created_at,
          created_at: ex.created_at,
          updated_at: ex.updated_at,
          metadata: { from_payment_execution: true, payment_intent_id: pid },
          trace_origin: "execution"
        });
      }

      return res.json({
        ok: true,
        source: "payment_intents_and_executions",
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
