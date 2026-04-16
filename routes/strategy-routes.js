function registerStrategyRoutes(app, deps) {
  const { requireUser, safeNumber, compareStrategiesForUser, jsonError } = deps;

  app.get("/strategy/compare", requireUser, async (req, res) => {
    try {
      const monthlyBudget = safeNumber(req.query.monthly_budget, 0);
      const extraPayment = safeNumber(req.query.extra_payment, 0);

      const data = await compareStrategiesForUser(
        req.user.id,
        monthlyBudget,
        extraPayment
      );

      return res.json({
        ok: true,
        data
      });
    } catch (error) {
      return jsonError(res, 500, "Error comparando estrategias", {
        details: error.message
      });
    }
  });

  app.post("/strategy/compare", requireUser, async (req, res) => {
    try {
      const monthlyBudget =
        req.body.monthly_budget_default !== undefined
          ? safeNumber(req.body.monthly_budget_default, 0)
          : safeNumber(req.body.monthly_budget, 0);

      const extraPayment =
        req.body.extra_payment_default !== undefined
          ? safeNumber(req.body.extra_payment_default, 0)
          : safeNumber(req.body.extra_payment, 0);

      const data = await compareStrategiesForUser(
        req.user.id,
        monthlyBudget,
        extraPayment
      );

      return res.json({
        ok: true,
        data
      });
    } catch (error) {
      return jsonError(res, 500, "Error comparando estrategias", {
        details: error.message
      });
    }
  });
}

module.exports = { registerStrategyRoutes };
