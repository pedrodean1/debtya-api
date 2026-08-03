/**
 * Manual confirm (paid outside app): atomic claim on payment_intents row + idempotent paths.
 */

function createConfirmManualPaymentIntentHandler(deps) {
  const {
    supabaseAdmin,
    isUuid,
    getIntentAmount,
    getIntentMetadata,
    intentRowForDebtBalanceApply,
    applyExecutedIntentToDebt,
    sendPaymentRecordedEmailsSafe,
    appDebug
  } = deps;

  function buildAlreadyConfirmedPayload(cur, amount, debtId, debtPreview) {
    const meta = getIntentMetadata(cur);
    return {
      ok: true,
      already_confirmed: true,
      intent_id: cur.id,
      debt_id: String(debtId),
      amount_confirmed: amount,
      old_balance: meta.debt_balance_previous != null ? Number(meta.debt_balance_previous) : null,
      new_balance: meta.debt_balance_next != null ? Number(meta.debt_balance_next) : null,
      data: cur,
      debt_apply: { ok: true, skipped: true, reason: "ya_confirmado" },
      debt_marked_paid: false,
      debt_name: debtPreview?.name ?? null
    };
  }

  async function maybeSendRecordedEmailForAppliedIntent(userId, cur, amount, debtPreview, options, balanceHint = {}) {
    const meta = getIntentMetadata(cur);
    if (meta.payment_recorded_email_sent_at) return null;
    if (typeof sendPaymentRecordedEmailsSafe !== "function") return null;
    return sendPaymentRecordedEmailsSafe(userId, {
      intentId: cur.id,
      amount,
      debtName: debtPreview?.name,
      previousBalance:
        balanceHint.previous_balance ?? balanceHint.previousBalance ?? meta.debt_balance_previous ?? null,
      nextBalance: balanceHint.next_balance ?? balanceHint.nextBalance ?? meta.debt_balance_next ?? null,
      previousDebtStatus: debtPreview?.status || balanceHint.previous_status || balanceHint.previousDebtStatus,
      preferredLanguageHint: options?.preferredLanguageHint
    });
  }

  /** Executed intent but balance metadata not written yet (another request is applying, or transient). Never recover-apply from the public endpoint. */
  function buildConfirmationInProgressPayload(cur, amount, debtId, debtPreview) {
    const meta = getIntentMetadata(cur);
    return {
      ok: true,
      already_confirmed: true,
      confirmation_in_progress: true,
      intent_id: cur.id,
      debt_id: String(debtId),
      amount_confirmed: amount,
      old_balance: meta.debt_balance_previous != null ? Number(meta.debt_balance_previous) : null,
      new_balance: meta.debt_balance_next != null ? Number(meta.debt_balance_next) : null,
      data: cur,
      debt_apply: { ok: true, skipped: true, reason: "confirmacion_en_progreso" },
      debt_marked_paid: false,
      debt_name: debtPreview?.name ?? null
    };
  }

  async function upsertExecutionAndApplyDebt({
    userId,
    intentId,
    intentPreRow,
    curRow,
    amount,
    debtPreview,
    options,
    now
  }) {
    const executionPayload = {
      user_id: userId,
      payment_intent_id: curRow.id,
      amount,
      status: "executed",
      executed_at: now,
      created_at: now,
      updated_at: now
    };

    const { error: executionError } = await supabaseAdmin
      .from("payment_executions")
      .upsert(executionPayload, { onConflict: "payment_intent_id" });

    if (executionError) {
      appDebug("No se pudo registrar payment_execution (manual):", executionError.message);
    }

    const intentForDebt = intentRowForDebtBalanceApply(intentPreRow, curRow, amount);
    const debtApply = await applyExecutedIntentToDebt(userId, intentForDebt, {
      amountOverride: amount
    });

    const appliedOk = debtApply && debtApply.ok === true && debtApply.skipped !== true;
    const idempotentOk =
      debtApply &&
      debtApply.ok === true &&
      debtApply.skipped === true &&
      debtApply.reason === "ya_aplicado";

    return { debtApply, appliedOk, idempotentOk };
  }

  function isAlreadyPaidDebtApply(debtApply) {
    return (
      debtApply &&
      debtApply.ok === true &&
      debtApply.skipped === true &&
      debtApply.reason === "deuda_ya_pagada"
    );
  }

  async function retireAlreadyPaidDebtIntent({ userId, intentId, claimed, amount, debtApply, now }) {
    const nextMeta = {
      ...getIntentMetadata(claimed),
      manual_confirm_skipped_at: now,
      manual_confirm_skipped_reason: "deuda_ya_pagada",
      debt_balance_apply_reason: "deuda_ya_pagada",
      debt_balance_apply_attempted_amount: amount
    };
    if (debtApply?.previous_balance != null) nextMeta.debt_balance_previous = Number(debtApply.previous_balance);
    if (debtApply?.next_balance != null) nextMeta.debt_balance_next = Number(debtApply.next_balance);

    await supabaseAdmin.from("payment_executions").delete().eq("payment_intent_id", intentId);
    await supabaseAdmin
      .from("payment_intents")
      .update({
        status: "canceled",
        executed_at: null,
        metadata: nextMeta,
        updated_at: now
      })
      .eq("id", intentId)
      .eq("user_id", userId);

    return {
      ...claimed,
      status: "canceled",
      executed_at: null,
      metadata: nextMeta,
      updated_at: now
    };
  }

  async function returnExecutedIntentPublicSafe(userId, cur, amount, debtId, debtPreview, options) {
    const meta = getIntentMetadata(cur);
    if (meta.debt_balance_applied_at) {
      const transactionalEmail = await maybeSendRecordedEmailForAppliedIntent(
        userId,
        cur,
        amount,
        debtPreview,
        options
      );
      return {
        ...buildAlreadyConfirmedPayload(cur, amount, debtId, debtPreview),
        ...(transactionalEmail ? { transactional_email: transactionalEmail } : {})
      };
    }
    return buildConfirmationInProgressPayload(cur, amount, debtId, debtPreview);
  }

  return async function confirmManualPaymentIntentDirect(userId, intentId, options = {}) {
    if (!isUuid(intentId)) {
      const err = new Error("intent_id inválido");
      err.status = 400;
      throw err;
    }

    const { data: intent, error: intentError } = await supabaseAdmin
      .from("payment_intents")
      .select("*")
      .eq("id", intentId)
      .eq("user_id", userId)
      .single();

    if (intentError || !intent) {
      const err = new Error("Intent no encontrado");
      err.status = 404;
      throw err;
    }

    const st0 = String(intent.status || "").toLowerCase().trim();
    if (st0 === "canceled" || st0 === "cancelled") {
      const err = new Error("Este intent está cancelado.");
      err.status = 400;
      throw err;
    }

    const amount = getIntentAmount(intent);
    if (amount <= 0) {
      const err = new Error("Monto del intent no válido para confirmar.");
      err.status = 400;
      throw err;
    }

    const debtIdRaw = intent.debt_id || intent.target_debt_id || null;
    const debtId = debtIdRaw != null ? String(debtIdRaw).trim() : null;
    if (!debtId || !isUuid(debtId)) {
      const err = new Error("El intent no tiene una deuda asociada válida.");
      err.status = 400;
      throw err;
    }

    const { data: debtPreview } = await supabaseAdmin
      .from("debts")
      .select("id,name,status,balance")
      .eq("id", debtId)
      .eq("user_id", userId)
      .maybeSingle();

    if (st0 === "executed") {
      return returnExecutedIntentPublicSafe(userId, intent, amount, debtId, debtPreview, options);
    }

    if (!["pending_review", "approved"].includes(st0)) {
      const err = new Error(
        "Solo se puede confirmar manualmente un intent en pending_review o approved."
      );
      err.status = 400;
      throw err;
    }

    const now = new Date().toISOString();
    const meta = {
      ...getIntentMetadata(intent),
      manual_confirmed: true,
      paid_outside_app: true,
      confirmed_at: now
    };

    const previousSnapshot = {
      status: intent.status,
      executed_at: intent.executed_at ?? null,
      metadata: intent.metadata
    };

    const { data: claimedRows, error: claimErr } = await supabaseAdmin
      .from("payment_intents")
      .update({
        status: "executed",
        executed_at: now,
        updated_at: now,
        metadata: meta
      })
      .eq("id", intentId)
      .eq("user_id", userId)
      .in("status", ["pending_review", "approved"])
      .select("*");

    if (claimErr) throw claimErr;

    const claimed = Array.isArray(claimedRows) && claimedRows[0];

    if (!claimed) {
      const { data: fresh, error: freshErr } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("id", intentId)
        .eq("user_id", userId)
        .single();

      if (freshErr || !fresh) {
        const err = new Error("Intent no encontrado");
        err.status = 404;
        throw err;
      }

      const st1 = String(fresh.status || "").toLowerCase().trim();
      if (st1 === "executed") {
        return returnExecutedIntentPublicSafe(userId, fresh, amount, debtId, debtPreview, options);
      }

      const err = new Error("No se pudo confirmar el pago; el estado del intent cambió. Reintenta.");
      err.status = 409;
      throw err;
    }

    let rolledBack = false;
    async function rollbackManualExecute() {
      if (rolledBack) return;
      rolledBack = true;
      const rbNow = new Date().toISOString();
      await supabaseAdmin
        .from("payment_intents")
        .update({
          status: previousSnapshot.status,
          executed_at: previousSnapshot.executed_at,
          metadata: previousSnapshot.metadata,
          updated_at: rbNow
        })
        .eq("id", intentId)
        .eq("user_id", userId);
      await supabaseAdmin.from("payment_executions").delete().eq("payment_intent_id", intentId);
    }

    try {
      const { debtApply, appliedOk, idempotentOk } = await upsertExecutionAndApplyDebt({
        userId,
        intentId,
        intentPreRow: intent,
        curRow: claimed,
        amount,
        debtPreview,
        options,
        now
      });

      if (idempotentOk) {
        const transactionalEmail = await maybeSendRecordedEmailForAppliedIntent(
          userId,
          claimed,
          amount,
          debtPreview,
          options,
          debtApply
        );
        return {
          ok: true,
          already_confirmed: true,
          intent_id: claimed.id,
          debt_id: String(debtId),
          amount_confirmed: amount,
          old_balance: debtApply.previous_balance ?? null,
          new_balance: debtApply.next_balance ?? null,
          data: claimed,
          debt_apply: debtApply,
          debt_marked_paid: false,
          debt_name: debtPreview?.name ?? null,
          ...(transactionalEmail ? { transactional_email: transactionalEmail } : {})
        };
      }

      if (isAlreadyPaidDebtApply(debtApply)) {
        const retired = await retireAlreadyPaidDebtIntent({
          userId,
          intentId,
          claimed,
          amount,
          debtApply,
          now
        });
        return {
          ok: true,
          already_confirmed: true,
          intent_id: claimed.id,
          debt_id: String(debtId),
          amount_confirmed: amount,
          old_balance: debtApply.previous_balance ?? null,
          new_balance: debtApply.next_balance ?? debtApply.previous_balance ?? null,
          data: retired,
          debt_apply: debtApply,
          debt_marked_paid: false,
          debt_name: debtPreview?.name ?? null
        };
      }

      if (!appliedOk) {
        const detail =
          (debtApply && (debtApply.reason || debtApply.error)) || "rebaja_no_aplicada";
        await rollbackManualExecute();
        const err = new Error(
          `No se pudo rebajar el balance de la deuda tras confirmar el pago (${detail}).`
        );
        err.status = 409;
        err.debt_apply = debtApply;
        throw err;
      }

      const transactionalEmail = await sendPaymentRecordedEmailsSafe(userId, {
        intentId: claimed.id,
        amount,
        debtName: debtPreview?.name,
        previousBalance: debtApply.previous_balance,
        nextBalance: debtApply.next_balance,
        previousDebtStatus: debtPreview?.status || debtApply.previous_status,
        preferredLanguageHint: options.preferredLanguageHint
      });

      return {
        ok: true,
        already_confirmed: false,
        intent_id: claimed.id,
        debt_id: String(debtId),
        amount_confirmed: amount,
        old_balance: debtApply.previous_balance ?? null,
        new_balance: debtApply.next_balance ?? null,
        data: claimed,
        debt_apply: debtApply,
        debt_marked_paid: !!debtApply.debt_marked_paid_now,
        debt_name: debtPreview?.name ?? null,
        transactional_email: transactionalEmail || null
      };
    } catch (e) {
      await rollbackManualExecute().catch(() => null);
      throw e;
    }
  };
}

module.exports = { createConfirmManualPaymentIntentHandler };
