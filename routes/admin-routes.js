const { buildSystemDiagnostics } = require("../lib/system-diagnostics");

function splitAdminList(value) {
  return String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function adminAccessConfigured(env = process.env) {
  return splitAdminList(env.DEBTYA_ADMIN_EMAILS).length > 0 || splitAdminList(env.DEBTYA_ADMIN_USER_IDS).length > 0;
}

function isAdminUser(user, env = process.env) {
  const email = String(user?.email || "").trim().toLowerCase();
  const userId = String(user?.id || "").trim();
  const adminEmails = new Set(splitAdminList(env.DEBTYA_ADMIN_EMAILS).map((x) => x.toLowerCase()));
  const adminUserIds = new Set(splitAdminList(env.DEBTYA_ADMIN_USER_IDS));

  if (!adminEmails.size && !adminUserIds.size) return false;
  if (email && adminEmails.has(email)) return true;
  if (userId && adminUserIds.has(userId)) return true;
  return false;
}

function registerAdminRoutes(app, deps) {
  const { requireUser, supabaseAdmin, jsonError, safeNumber, appDebug, SERVER_VERSION } = deps;

  if (typeof requireUser !== "function") {
    throw new Error("registerAdminRoutes requires requireUser in deps");
  }

  app.get("/api/admin/diagnostics", requireUser, async (req, res) => {
    try {
      if (!isAdminUser(req.user)) {
        console.warn(
          "[admin/diagnostics:forbidden]",
          JSON.stringify({
            allowlist_configured: adminAccessConfigured(),
            user_id_present: !!req.user?.id,
            email_present: !!req.user?.email
          })
        );
        return jsonError(res, 403, "Admin no autorizado", { details: "admin_forbidden" });
      }

      if (!supabaseAdmin) return jsonError(res, 500, "Supabase no configurado");

      const result = await buildSystemDiagnostics({
        supabaseAdmin,
        safeNumber,
        days: req.query?.days,
        limit: req.query?.limit
      });

      console.log(
        "[admin/diagnostics]",
        JSON.stringify({
          overall_status: result.overall_status,
          alerts_count: result.alerts.length,
          query_failures: result.query_failures.length,
          active_debts: result.debts.active_carrying_count,
          open_intents: result.payment_intents.open_count,
          recent_notification_events: result.notification_events.scanned
        })
      );

      return res.json({ ok: true, server_version: SERVER_VERSION, ...result });
    } catch (error) {
      if (typeof appDebug === "function") appDebug("admin diagnostics:", error?.message || String(error));
      return jsonError(res, 500, "Error cargando diagnostico interno", {
        details: "admin_diagnostics_failed"
      });
    }
  });
}

module.exports = {
  adminAccessConfigured,
  isAdminUser,
  registerAdminRoutes,
  splitAdminList
};
