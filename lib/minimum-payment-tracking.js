const AUTO_TRACK_SOURCE = "scheduled_minimum_tracking";
const AUTO_TRACK_NOTE_EN = "Auto-tracked minimum payment";
const AUTO_TRACK_NOTE_ES = "Pago minimo registrado automaticamente";

function safeString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolValue(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

function increment(summary, reason) {
  const key = safeString(reason || "skipped", 80) || "skipped";
  summary.skipped += 1;
  summary.reason_counts[key] = (summary.reason_counts[key] || 0) + 1;
}

function isMissingAutoTrackColumn(error) {
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return msg.includes("auto_track_minimum_payments") && (msg.includes("column") || msg.includes("schema cache"));
}

function isDuplicateAutoTrackError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return code === "23505" || (msg.includes("duplicate") && msg.includes(AUTO_TRACK_SOURCE));
}

function localDateParts(nowUtc = new Date(), timeZone = "UTC") {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  if (Number.isNaN(now.getTime())) return null;
  try {
    const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "UTC";
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = fmt.formatToParts(now);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    const dayOfMonth = Number(day);
    if (!year || !month || !Number.isFinite(dayOfMonth)) return null;
    return { dateKey: `${year}-${month}-${day}`, dayOfMonth };
  } catch {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return { dateKey: `${y}-${m}-${d}`, dayOfMonth: now.getUTCDate() };
  }
}

function minimumPaymentAmountForDebt(debt) {
  return safeNumber(debt?.minimum_payment ?? debt?.min_payment, 0);
}

function computeAutoTrackedMinimumPayment(debt) {
  const balance = Math.max(0, safeNumber(debt?.balance ?? debt?.current_balance, 0));
  const minimum = Math.max(0, minimumPaymentAmountForDebt(debt));
  if (!(balance > 0) || !(minimum > 0)) return { amount: 0, balance, minimum, amount_clamped: false };
  const amount = Math.min(balance, minimum);
  return {
    amount: Number(amount.toFixed(2)),
    balance,
    minimum,
    amount_clamped: minimum > balance
  };
}

function debtIsEligibleForAutoTrack(debt, dayOfMonth) {
  if (!debt || typeof debt !== "object") return { ok: false, reason: "invalid_debt" };
  if (debt.is_active === false) return { ok: false, reason: "debt_inactive" };
  if (String(debt.status || "active").toLowerCase() === "paid") return { ok: false, reason: "debt_paid" };
  const dueDay = Number(debt.due_day);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return { ok: false, reason: "missing_due_day" };
  if (dueDay !== dayOfMonth) return { ok: false, reason: "not_due_today" };
  const computed = computeAutoTrackedMinimumPayment(debt);
  if (!(computed.amount > 0)) return { ok: false, reason: "no_minimum_payment_amount" };
  return { ok: true, dueDay, computed };
}

function buildAutoTrackMetadata({ dueDay, dateApplied, amount, amountClamped }) {
  return {
    auto_tracked_minimum_payment: true,
    due_day: dueDay,
    date_applied: dateApplied,
    source: AUTO_TRACK_SOURCE,
    amount_clamped: !!amountClamped,
    amount,
    manual_first_note: "DebtYa recorded this scheduled minimum in your progress only. DebtYa did not make the payment."
  };
}

async function findExistingAutoTrackIntent(supabaseAdmin, userId, debtId, dateKey) {
  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .select("id,status,metadata")
    .eq("user_id", userId)
    .eq("debt_id", debtId)
    .eq("source", AUTO_TRACK_SOURCE)
    .eq("scheduled_for", dateKey)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function rollbackIntent(supabaseAdmin, userId, intentId) {
  try {
    await supabaseAdmin.from("payment_executions").delete().eq("payment_intent_id", intentId);
  } catch (_) {}
  try {
    await supabaseAdmin.from("payment_intents").delete().eq("id", intentId).eq("user_id", userId);
  } catch (_) {}
}

async function runMinimumPaymentAutoTracking(deps = {}) {
  const {
    supabaseAdmin,
    now = new Date(),
    applyExecutedIntentToDebt,
    reconcileManualFirstPriorityIntent,
    appDebug
  } = deps;
  if (!supabaseAdmin) return { ok: false, error: "Supabase is not configured" };
  if (typeof applyExecutedIntentToDebt !== "function") {
    return { ok: false, error: "applyExecutedIntentToDebt is not configured" };
  }

  const summary = {
    ok: true,
    users_checked: 0,
    debts_checked: 0,
    tracked: 0,
    skipped: 0,
    failures: 0,
    reason_counts: {},
    errors: []
  };

  const { data: prefRows, error: prefError } = await supabaseAdmin
    .from("notification_preferences")
    .select("user_id,auto_track_minimum_payments,timezone,preferred_language")
    .eq("auto_track_minimum_payments", true);

  if (prefError) {
    if (isMissingAutoTrackColumn(prefError)) {
      return {
        ...summary,
        skipped_all: true,
        reason: "auto_track_minimum_payments_column_missing"
      };
    }
    throw prefError;
  }

  for (const pref of prefRows || []) {
    if (!boolValue(pref?.auto_track_minimum_payments)) {
      increment(summary, "auto_track_disabled");
      continue;
    }
    const userId = safeString(pref.user_id, 80);
    if (!userId) {
      increment(summary, "missing_user_id");
      continue;
    }
    summary.users_checked += 1;
    const local = localDateParts(now, pref.timezone || "UTC");
    if (!local) {
      increment(summary, "invalid_tracking_date");
      continue;
    }

    let debts = [];
    try {
      const { data, error } = await supabaseAdmin
        .from("debts")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) throw error;
      debts = data || [];
    } catch (error) {
      summary.failures += 1;
      summary.errors.push({ user_id: userId, step: "debts", message: "debt_lookup_failed" });
      continue;
    }

    for (const debt of debts) {
      summary.debts_checked += 1;
      const eligible = debtIsEligibleForAutoTrack(debt, local.dayOfMonth);
      if (!eligible.ok) {
        increment(summary, eligible.reason);
        continue;
      }

      const debtId = safeString(debt.id, 80);
      if (!debtId) {
        increment(summary, "missing_debt_id");
        continue;
      }

      try {
        const existing = await findExistingAutoTrackIntent(supabaseAdmin, userId, debtId, local.dateKey);
        if (existing?.id) {
          increment(summary, "already_tracked_for_date");
          continue;
        }

        const amount = eligible.computed.amount;
        const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
        const metadata = buildAutoTrackMetadata({
          dueDay: eligible.dueDay,
          dateApplied: local.dateKey,
          amount,
          amountClamped: eligible.computed.amount_clamped
        });
        const insertPayload = {
          user_id: userId,
          debt_id: debtId,
          source: AUTO_TRACK_SOURCE,
          strategy: AUTO_TRACK_SOURCE,
          amount,
          total_amount: amount,
          status: "executed",
          executed_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
          execution_mode: "safe",
          execution_frequency: "monthly",
          scheduled_for: local.dateKey,
          notes: AUTO_TRACK_NOTE_EN,
          metadata
        };

        const { data: inserted, error: insertError } = await supabaseAdmin
          .from("payment_intents")
          .insert(insertPayload)
          .select()
          .single();
        if (insertError) {
          if (isDuplicateAutoTrackError(insertError)) {
            increment(summary, "already_tracked_for_date");
            continue;
          }
          throw insertError;
        }

        const intentId = inserted?.id;
        if (!intentId) throw new Error("auto_track_intent_missing_id");
        const debtApply = await applyExecutedIntentToDebt(userId, inserted, { amountOverride: amount });
        const appliedOk = debtApply && debtApply.ok === true && debtApply.skipped !== true;
        const idempotentOk = debtApply && debtApply.ok === true && debtApply.skipped === true && debtApply.reason === "ya_aplicado";
        if (!appliedOk && !idempotentOk) {
          await rollbackIntent(supabaseAdmin, userId, intentId);
          increment(summary, "debt_balance_apply_failed");
          continue;
        }

        const executionPayload = {
          user_id: userId,
          payment_intent_id: intentId,
          amount,
          status: "executed",
          executed_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso
        };
        try {
          await supabaseAdmin
            .from("payment_executions")
            .upsert(executionPayload, { onConflict: "payment_intent_id" });
        } catch (executionError) {
          if (typeof appDebug === "function") appDebug("auto-track minimum execution insert skipped", executionError?.message || String(executionError));
        }

        if (typeof reconcileManualFirstPriorityIntent === "function") {
          try {
            await reconcileManualFirstPriorityIntent(userId);
          } catch (reconcileError) {
            if (typeof appDebug === "function") appDebug("auto-track minimum reconcile skipped", reconcileError?.message || String(reconcileError));
          }
        }

        summary.tracked += 1;
      } catch (error) {
        summary.failures += 1;
        summary.errors.push({ user_id: userId, debt_id: debtId, message: "auto_track_minimum_failed" });
      }
    }
  }

  return summary;
}

module.exports = {
  AUTO_TRACK_SOURCE,
  AUTO_TRACK_NOTE_EN,
  AUTO_TRACK_NOTE_ES,
  localDateParts,
  computeAutoTrackedMinimumPayment,
  debtIsEligibleForAutoTrack,
  buildAutoTrackMetadata,
  runMinimumPaymentAutoTracking
};