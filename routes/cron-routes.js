function registerCronRoutes(app, deps) {
  const {
    requireCronSecret,
    supabaseAdmin,
    jsonError,
    callRpc,
    approveIntentDirect,
    executeIntentDirect,
    getIntentAmount,
    isUuid,
    safeNumber,
    SERVER_VERSION,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    CRON_SECRET
  } = deps;

  app.post("/cron/full-auto", requireCronSecret, async (_req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }

      const { data: users, error } = await supabaseAdmin
        .from("profiles")
        .select("id");

      if (error) throw error;

      const results = [];
      let successUsers = 0;
      let failedUsers = 0;
      let allocationsCreated = 0;
      let intentsCreated = 0;
      let intentsExecuted = 0;
      let totalExecutedAmount = 0;

      for (const user of users || []) {
        try {
          const userId = user.id;

          const applyResult = await callRpc("apply_rules_v2", {
            p_user_id: userId
          }).catch(() => null);

          const buildResult = await callRpc("build_intents_v2", {
            p_user_id: userId
          }).catch(() => null);

          let buildItems = [];
          if (Array.isArray(buildResult)) buildItems = buildResult;
          if (buildResult?.intents && Array.isArray(buildResult.intents)) {
            buildItems = buildResult.intents;
          }

          let createdForUser = 0;
          let executedForUser = 0;
          let totalExecutedForUser = 0;

          for (const item of buildItems) {
            const intentId =
              item?.intent_id || item?.id || item?.payment_intent_id || null;
            if (!intentId || !isUuid(intentId)) continue;

            createdForUser += 1;

            await approveIntentDirect(userId, intentId).catch(() => null);

            const executeResult = await executeIntentDirect(userId, intentId).catch(() => null);

            if (executeResult && !executeResult.already_executed) {
              executedForUser += 1;
              totalExecutedForUser += getIntentAmount(executeResult.data);
            }
          }

          const allocationsForUser =
            safeNumber(applyResult?.allocations_created) ||
            safeNumber(applyResult?.count) ||
            0;

          allocationsCreated += allocationsForUser;
          intentsCreated += createdForUser;
          intentsExecuted += executedForUser;
          totalExecutedAmount += totalExecutedForUser;
          successUsers += 1;

          results.push({
            user_id: userId,
            ok: true,
            allocations_created: allocationsForUser,
            intents_created: createdForUser,
            intents_executed: executedForUser,
            total_executed: Number(totalExecutedForUser.toFixed(2))
          });
        } catch (error) {
          failedUsers += 1;
          results.push({
            user_id: user.id,
            ok: false,
            error: error.message
          });
        }
      }

      return res.json({
        ok: true,
        server_version: SERVER_VERSION,
        ran_at: new Date().toISOString(),
        total_users: (users || []).length,
        success_users: successUsers,
        failed_users: failedUsers,
        allocations_created: allocationsCreated,
        intents_created: intentsCreated,
        intents_executed: intentsExecuted,
        total_executed_amount: Number(totalExecutedAmount.toFixed(2)),
        results,
        env_debug: {
          has_supabase_url: !!SUPABASE_URL,
          has_anon_key: !!SUPABASE_ANON_KEY,
          has_service_role_key: !!SUPABASE_SERVICE_ROLE_KEY,
          has_cron_secret: !!CRON_SECRET
        }
      });
    } catch (error) {
      return jsonError(res, 500, "Error ejecutando cron full-auto", {
        details: error.message
      });
    }
  });
}

module.exports = { registerCronRoutes };
