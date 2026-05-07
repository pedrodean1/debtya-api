const { executeManualPlanRebuild } = require("../lib/manual-plan-rebuild");

function registerManualPlanRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    getCurrentPaymentPlan,
    normalizePaymentPlan,
    safeNumber,
    isUuid,
    appDebug
  } = deps;

  app.post("/manual-plan/rebuild", requireUser, async (req, res) => {
    try {
      const out = await executeManualPlanRebuild({
        userId: req.user.id,
        body: req.body && typeof req.body === "object" ? req.body : {},
        supabaseAdmin,
        getCurrentPaymentPlan,
        normalizePaymentPlan,
        safeNumber,
        isUuid
      });
      return res.json(out);
    } catch (e) {
      appDebug("executeManualPlanRebuild:", e.message);
      return res.json({
        ok: false,
        manual_plan_rebuild: false,
        manual_first_reconcile: {
          ok: false,
          skipped: true,
          error: e.message || String(e)
        },
        intent: null
      });
    }
  });
}

module.exports = { registerManualPlanRoutes };
