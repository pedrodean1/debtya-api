function registerDebtsExtraPaymentRoutes(app, deps) {
  const { requireUser, recordManualExtraDebtPayment, jsonError } = deps;

  app.post("/debts/:id/extra-payment", requireUser, async (req, res) => {
    try {
      const debtId = req.params.id;
      const amount = req.body && req.body.amount;
      const note = req.body && req.body.note;
      const out = await recordManualExtraDebtPayment(req.user.id, debtId, amount, note);
      return res.json(out);
    } catch (error) {
      const status = error.status && Number(error.status) >= 400 ? Number(error.status) : 500;
      const msg = error.message || "Error registrando pago extra";
      return jsonError(res, status, msg, {
        details: msg,
        debt_apply: error.debt_apply || undefined
      });
    }
  });
}

module.exports = { registerDebtsExtraPaymentRoutes };
