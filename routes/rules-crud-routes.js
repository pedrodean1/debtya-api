function registerRulesCrudRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    jsonError,
    safeNumber,
    safeBoolean,
    safeNullableNumber,
    isUuid,
    buildMicroRulePayload,
    normalizeMicroRuleModeInput
  } = deps;

  app.get("/rules", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("micro_rules")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return res.json({ ok: true, data: data || [] });
    } catch (error) {
      return jsonError(res, 500, "Error cargando reglas", {
        details: error.message
      });
    }
  });

  app.post("/rules", requireUser, async (req, res) => {
    try {
      const { data: existingRows, error: existingErr } = await supabaseAdmin
        .from("micro_rules")
        .select("id")
        .eq("user_id", req.user.id)
        .limit(1);

      if (existingErr) throw existingErr;
      if (Array.isArray(existingRows) && existingRows.length >= 1) {
        return jsonError(res, 409, "ERR_ONE_RULE_MAX");
      }

      const payload = buildMicroRulePayload(req.user.id, req.body);

      const { data, error } = await supabaseAdmin
        .from("micro_rules")
        .insert(payload)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error creando regla", {
        details: error.message
      });
    }
  });

  app.patch("/rules/:id", requireUser, async (req, res) => {
    try {
      const ruleId = req.params.id;
      if (!isUuid(ruleId)) {
        return jsonError(res, 400, "ID inválido");
      }

      const config = req.body.config_json || req.body.config || {};
      const patch = {
        updated_at: new Date().toISOString()
      };

      if (req.body.enabled !== undefined) patch.enabled = safeBoolean(req.body.enabled, true);
      if (req.body.is_active !== undefined) patch.enabled = safeBoolean(req.body.is_active, true);
      if (req.body.mode !== undefined) patch.mode = normalizeMicroRuleModeInput(req.body.mode);
      if (req.body.rule_type !== undefined) {
        patch.mode = normalizeMicroRuleModeInput(req.body.rule_type);
      }

      if (req.body.fixed_amount !== undefined) patch.fixed_amount = safeNumber(req.body.fixed_amount);
      else if (config.fixed_amount !== undefined) patch.fixed_amount = safeNumber(config.fixed_amount);
      else if (config.amount !== undefined) patch.fixed_amount = safeNumber(config.amount);

      if (req.body.percent !== undefined) patch.percent = safeNumber(req.body.percent);
      else if (config.percent !== undefined) patch.percent = safeNumber(config.percent);

      if (req.body.roundup_to !== undefined) patch.roundup_to = safeNumber(req.body.roundup_to);
      else if (config.roundup_to !== undefined) patch.roundup_to = safeNumber(config.roundup_to);

      if (req.body.min_purchase_amount !== undefined) patch.min_purchase_amount = safeNumber(req.body.min_purchase_amount);
      else if (config.min_purchase_amount !== undefined) patch.min_purchase_amount = safeNumber(config.min_purchase_amount);

      if (req.body.cap_daily !== undefined) patch.cap_daily = safeNullableNumber(req.body.cap_daily);
      else if (config.cap_daily !== undefined) patch.cap_daily = safeNullableNumber(config.cap_daily);

      if (req.body.cap_weekly !== undefined) patch.cap_weekly = safeNullableNumber(req.body.cap_weekly);
      else if (config.cap_weekly !== undefined) patch.cap_weekly = safeNullableNumber(config.cap_weekly);

      const targetDebtId =
        req.body.target_debt_id !== undefined
          ? req.body.target_debt_id
          : config.target_debt_id !== undefined
          ? config.target_debt_id
          : req.body.debt_id !== undefined
          ? req.body.debt_id
          : undefined;

      if (targetDebtId !== undefined) {
        patch.target_debt_id = isUuid(targetDebtId) ? targetDebtId : null;
      }

      if (req.body.auto_run !== undefined) patch.auto_run = safeBoolean(req.body.auto_run, false);
      else if (config.auto_run !== undefined) patch.auto_run = safeBoolean(config.auto_run, false);

      if (req.body.payout_enabled !== undefined) patch.payout_enabled = safeBoolean(req.body.payout_enabled, false);
      else if (config.payout_enabled !== undefined) patch.payout_enabled = safeBoolean(config.payout_enabled, false);

      if (req.body.payout_min_threshold !== undefined) patch.payout_min_threshold = safeNumber(req.body.payout_min_threshold);
      else if (config.payout_min_threshold !== undefined) patch.payout_min_threshold = safeNumber(config.payout_min_threshold);

      const { data, error } = await supabaseAdmin
        .from("micro_rules")
        .update(patch)
        .eq("id", ruleId)
        .eq("user_id", req.user.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error actualizando regla", {
        details: error.message
      });
    }
  });

  app.delete("/rules/:id", requireUser, async (req, res) => {
    try {
      const ruleId = req.params.id;
      if (!isUuid(ruleId)) {
        return jsonError(res, 400, "ID inválido");
      }

      const { error } = await supabaseAdmin
        .from("micro_rules")
        .delete()
        .eq("id", ruleId)
        .eq("user_id", req.user.id);

      if (error) throw error;

      return res.json({ ok: true });
    } catch (error) {
      return jsonError(res, 500, "Error eliminando regla", {
        details: error.message
      });
    }
  });
}

module.exports = { registerRulesCrudRoutes };
