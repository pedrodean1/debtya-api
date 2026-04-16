function registerPaymentPlansRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    jsonError,
    normalizePaymentPlan,
    savePaymentPlanForUser,
    getCurrentPaymentPlan
  } = deps;

  app.get("/payment-plans", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("payment_plans")
        .select("*")
        .eq("user_id", req.user.id)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return res.json({
        ok: true,
        data: (data || []).map(normalizePaymentPlan)
      });
    } catch (error) {
      return jsonError(res, 500, "Error cargando planes", {
        details: error.message
      });
    }
  });

  app.post("/payment-plans", requireUser, async (req, res) => {
    try {
      const data = await savePaymentPlanForUser(req.user.id, req.body);
      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error guardando plan", {
        details: error.message
      });
    }
  });

  app.get("/payment-plan", requireUser, async (req, res) => {
    try {
      const data = await getCurrentPaymentPlan(req.user.id);
      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error cargando plan", {
        details: error.message
      });
    }
  });

  app.post("/payment-plan", requireUser, async (req, res) => {
    try {
      const data = await savePaymentPlanForUser(req.user.id, req.body);
      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error guardando plan", {
        details: error.message
      });
    }
  });
}

module.exports = { registerPaymentPlansRoutes };
