const { parsePreferredLanguageHintFromHttp } = require("../lib/notifications");

function logExtraPaymentOutcome(userId, result) {
  try {
    console.log(
      "[extra-payment]",
      JSON.stringify({
        user_id: userId,
        intent_id: result?.intent_id || null,
        debt_id: result?.debt_id || null,
        debt_marked_paid: result?.debt_marked_paid === true,
        debt_apply_reason: result?.debt_apply?.reason || result?.debt_apply?.error || null,
        transactional_email: result?.transactional_email || null
      })
    );
  } catch (_) {}
}

function registerDebtsExtraPaymentRoutes(app, deps) {
  const { requireUser, recordManualExtraDebtPayment, jsonError } = deps;

  app.post("/debts/:id/extra-payment", requireUser, async (req, res) => {
    try {
      const debtId = req.params.id;
      const amount = req.body && req.body.amount;
      const note = req.body && req.body.note;
      const langHint = parsePreferredLanguageHintFromHttp(req);
      const out = await recordManualExtraDebtPayment(req.user.id, debtId, amount, note, {
        preferredLanguageHint: langHint
      });
      logExtraPaymentOutcome(req.user.id, out);
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
