function registerPlanningRoutes(app, deps) {
  const {
    requireUser,
    callRpc,
    safeNumber,
    stampRecentIntentsFundingFromPlan,
    appDebug,
    approveIntentDirect,
    executeIntentDirect,
    jsonError
  } = deps;

  app.post("/apply_rules_v2", requireUser, async (req, res) => {
    try {
      const result = await callRpc("apply_rules_v2", {
        p_user_id: req.user.id
      });

      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error ejecutando apply_rules_v2", {
        details: error.message
      });
    }
  });

  app.post("/rules/apply", requireUser, async (req, res) => {
    try {
      const result = await callRpc("apply_rules_v2", {
        p_user_id: req.user.id
      });

      const created =
        safeNumber(result?.allocations_created) ||
        safeNumber(result?.count) ||
        safeNumber(result?.created) ||
        0;

      return res.json({
        ok: true,
        created,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error aplicando reglas", {
        details: error.message
      });
    }
  });

  app.post("/build_intents_v2", requireUser, async (req, res) => {
    try {
      const result = await callRpc("build_intents_v2", {
        p_user_id: req.user.id
      });

      await stampRecentIntentsFundingFromPlan(req.user.id).catch((e) => {
        appDebug("stampRecentIntentsFundingFromPlan:", e.message);
      });

      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error ejecutando build_intents_v2", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/build", requireUser, async (req, res) => {
    try {
      const result = await callRpc("build_intents_v2", {
        p_user_id: req.user.id
      });

      await stampRecentIntentsFundingFromPlan(req.user.id).catch((e) => {
        appDebug("stampRecentIntentsFundingFromPlan:", e.message);
      });

      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error construyendo intents", {
        details: error.message
      });
    }
  });

  app.post("/approve_intent_v2", requireUser, async (req, res) => {
    try {
      const intentId = req.body.intent_id;
      const data = await approveIntentDirect(req.user.id, intentId);

      return res.json({
        ok: true,
        bypass_sql_function: true,
        data
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error ejecutando approve_intent_v2", {
        details: error.message
      });
    }
  });

  app.post("/execute_intent_v2", requireUser, async (req, res) => {
    try {
      const intentId = req.body.intent_id;
      const result = await executeIntentDirect(req.user.id, intentId);

      return res.json({
        ok: true,
        bypass_sql_function: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error ejecutando execute_intent_v2", {
        details: error.message
      });
    }
  });

  app.post("/auto_sweep_v2", requireUser, async (req, res) => {
    try {
      const result = await callRpc("auto_sweep_v2", {
        p_user_id: req.user.id
      });

      return res.json({
        ok: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error ejecutando auto_sweep_v2", {
        details: error.message
      });
    }
  });
}

module.exports = { registerPlanningRoutes };
