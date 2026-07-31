const {
  validatePaymentIntentCreate,
  validateIntentRouteParamId
} = require("../lib/validation");
const { parsePreferredLanguageHintFromHttp } = require("../lib/notifications");
const {
  retireStaleOpenPaymentIntentsForInactiveDebts
} = require("../lib/payment-intent-stale-guard");

function logManualConfirmOutcome(userId, result) {
  try {
    console.log(
      "[payment-confirm-manual]",
      JSON.stringify({
        user_id: userId,
        intent_id: result?.intent_id || null,
        already_confirmed: result?.already_confirmed === true,
        confirmation_in_progress: result?.confirmation_in_progress === true,
        debt_apply_reason: result?.debt_apply?.reason || result?.debt_apply?.error || null,
        transactional_email: result?.transactional_email || null
      })
    );
  } catch (_) {}
}

function logStaleIntentGuardOutcome(userId, result) {
  if (!result || result.retired_count <= 0) return;
  try {
    console.log(
      "[payment-intents-stale-guard]",
      JSON.stringify({
        user_id: userId,
        retired_count: result.retired_count,
        reason_counts: result.reason_counts || {}
      })
    );
  } catch (_) {}
}

function registerPaymentIntentRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    safeNumber,
    approveIntentDirect,
    executeIntentDirect,
    confirmManualPaymentIntentDirect,
    reconcileRecentExecutedIntents,
    isoDaysAgo,
    jsonError
  } = deps;

  app.get("/payment-intents", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const staleGuard = await retireStaleOpenPaymentIntentsForInactiveDebts({
        userId: req.user.id,
        intents: data || [],
        supabaseAdmin,
        safeNumber
      });
      logStaleIntentGuardOutcome(req.user.id, staleGuard);

      return res.json({
        ok: true,
        data: staleGuard.intents || [],
        ...(staleGuard.retired_count > 0
          ? {
              stale_payment_intents: {
                retired_count: staleGuard.retired_count,
                reason_counts: staleGuard.reason_counts || {}
              }
            }
          : {})
      });
    } catch (error) {
      return jsonError(res, 500, "Error cargando intents", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents", requireUser, async (req, res) => {
    try {
      const intentErr = validatePaymentIntentCreate(req.body, safeNumber);
      if (intentErr) {
        return jsonError(res, 400, intentErr);
      }

      const payload = {
        user_id: req.user.id,
        debt_id: req.body.debt_id || null,
        source_account_id: req.body.source_account_id || null,
        strategy: req.body.strategy || "avalanche",
        amount: safeNumber(req.body.amount),
        status: req.body.status || "draft",
        scheduled_for: req.body.scheduled_for || null,
        notes: req.body.notes || null
      };

      const { data, error } = await supabaseAdmin
        .from("payment_intents")
        .insert(payload)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error creando intent", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/:id/approve", requireUser, async (req, res) => {
    try {
      const intentId = req.params.id;
      const idErr = validateIntentRouteParamId(intentId);
      if (idErr) {
        return jsonError(res, 400, idErr);
      }
      const data = await approveIntentDirect(req.user.id, intentId);

      return res.json({
        ok: true,
        bypass_sql_function: true,
        data
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error aprobando intent", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/:id/execute", requireUser, async (req, res) => {
    try {
      const intentId = req.params.id;
      const idErr = validateIntentRouteParamId(intentId);
      if (idErr) {
        return jsonError(res, 400, idErr);
      }
      const result = await executeIntentDirect(req.user.id, intentId);

      return res.json({
        ok: true,
        bypass_sql_function: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error ejecutando intent", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/:id/confirm-manual", requireUser, async (req, res) => {
    try {
      const intentId = req.params.id;
      const idErr = validateIntentRouteParamId(intentId);
      if (idErr) {
        return jsonError(res, 400, idErr);
      }
      const langHint = parsePreferredLanguageHintFromHttp(req);
      const result = await confirmManualPaymentIntentDirect(req.user.id, intentId, {
        preferredLanguageHint: langHint
      });
      logManualConfirmOutcome(req.user.id, result);

      return res.json({
        ok: true,
        bypass_sql_function: true,
        ...(result.already_confirmed ? { already_confirmed: true } : {}),
        ...(result.confirmation_in_progress ? { confirmation_in_progress: true } : {}),
        intent_id: result.intent_id,
        debt_id: result.debt_id,
        amount_confirmed: result.amount_confirmed,
        old_balance: result.old_balance,
        new_balance: result.new_balance,
        debt_marked_paid: result.debt_marked_paid,
        debt_apply: result.debt_apply,
        ...(result.transactional_email ? { transactional_email: result.transactional_email } : {}),
        data: result.data
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error confirmando pago manual", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/approve-visible", requireUser, async (req, res) => {
    try {
      const { data: intents, error } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("user_id", req.user.id)
        .in("status", ["draft", "pending", "built", "proposed", "ready", "pending_review"])
        .or("source.is.null,source.neq.spinwheel")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const results = [];

      for (const intent of intents || []) {
        try {
          const approved = await approveIntentDirect(req.user.id, intent.id);
          results.push({
            id: intent.id,
            ok: true,
            data: approved
          });
        } catch (e) {
          results.push({
            id: intent.id,
            ok: false,
            error: e.message
          });
        }
      }

      return res.json({
        ok: true,
        bypass_sql_function: true,
        total_visible: (intents || []).length,
        approved_count: results.filter((x) => x.ok).length,
        failed_count: results.filter((x) => !x.ok).length,
        results
      });
    } catch (error) {
      return jsonError(res, 500, "Error aprobando visibles", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/execute-visible", requireUser, async (req, res) => {
    try {
      const { data: intents, error } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("user_id", req.user.id)
        .in("status", ["approved"])
        .or("source.is.null,source.neq.spinwheel")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const results = [];

      for (const intent of intents || []) {
        try {
          const executed = await executeIntentDirect(req.user.id, intent.id);
          results.push({
            id: intent.id,
            ok: true,
            data: executed
          });
        } catch (e) {
          results.push({
            id: intent.id,
            ok: false,
            error: e.message
          });
        }
      }

      return res.json({
        ok: true,
        bypass_sql_function: true,
        total_visible: (intents || []).length,
        executed_count: results.filter((x) => x.ok).length,
        failed_count: results.filter((x) => !x.ok).length,
        results
      });
    } catch (error) {
      return jsonError(res, 500, "Error ejecutando visibles", {
        details: error.message
      });
    }
  });

  app.post("/payment-intents/reconcile-recent", requireUser, async (req, res) => {
    try {
      const days = Math.max(0, safeNumber(req.body?.days, 2));
      const limit = Math.min(50, Math.max(1, safeNumber(req.body?.limit, 10)));
      const sinceIso = req.body?.since_iso || isoDaysAgo(days);

      const result = await reconcileRecentExecutedIntents(req.user.id, {
        days,
        limit,
        since_iso: sinceIso
      });

      return res.json({
        ok: true,
        safe_mode: true,
        data: result
      });
    } catch (error) {
      return jsonError(res, 500, "Error reconciliando intents recientes", {
        details: error.message
      });
    }
  });
}

module.exports = { registerPaymentIntentRoutes };
