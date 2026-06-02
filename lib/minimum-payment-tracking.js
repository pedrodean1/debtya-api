const AUTO_TRACK_SOURCE = "scheduled_minimum_tracking";
const AUTO_TRACK_NOTE_EN = "Auto-tracked minimum payment";
const AUTO_TRACK_NOTE_ES = "Pago minimo registrado automaticamente";
const {
  fetchAuthUserEmail,
  resolveNotificationEventMessage,
  sendMinimumPaymentDueEmail,
  sendTransactionalPaymentCelebrationEmails
} = require("./notifications");

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

function addReason(summary, reason, { skipped = false } = {}) {
  const key = safeString(reason || "skipped", 80) || "skipped";
  if (skipped) summary.skipped += 1;
  summary.reason_counts[key] = (summary.reason_counts[key] || 0) + 1;
}

function increment(summary, reason) {
  addReason(summary, reason, { skipped: true });
}

function safeErrorCode(error) {
  const raw = safeString(error?.code || error?.statusCode || error?.status || "", 80);
  const code = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return code || undefined;
}

function pushSafeError(summary, step, message, error) {
  summary.failures += 1;
  const item = {
    step: safeString(step || "unknown", 80),
    message: safeString(message || "auto_track_minimum_failed", 120)
  };
  const code = safeErrorCode(error);
  if (code) item.code = code;
  summary.errors.push(item);
}

function isMissingAutoTrackColumn(error) {
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return msg.includes("auto_track_minimum_payments") && (msg.includes("column") || msg.includes("schema cache"));
}

function isMissingNotificationEventsTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  if (code === "42P01") return true;
  return msg.includes("notification_events") && (msg.includes("does not exist") || msg.includes("schema cache"));
}

function isUnsupportedNotificationEventType(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return code === "23514" && (msg.includes("event_type") || msg.includes("notification_events"));
}

function isDuplicateAutoTrackError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return code === "23505" || (msg.includes("duplicate") && msg.includes(AUTO_TRACK_SOURCE));
}

function isDuplicateNotificationEventError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  return code === "23505" || (msg.includes("duplicate") && msg.includes("notification_events"));
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function isMinimumPaymentDueEvent(row, debtId, dateKey) {
  const meta = parseMetadata(row?.metadata);
  const type = safeString(row?.event_type, 80);
  const auditType = safeString(meta.audit_type, 80);
  return (
    (type === "minimum_payment_due" || auditType === "minimum_payment_due") &&
    safeString(meta.debt_id, 80) === debtId &&
    safeString(meta.date_key, 40) === dateKey
  );
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
  const primary = safeNumber(debt?.minimum_payment, NaN);
  if (Number.isFinite(primary) && primary > 0) return primary;
  const legacy = safeNumber(debt?.min_payment, NaN);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  if (Number.isFinite(primary)) return primary;
  return Number.isFinite(legacy) ? legacy : 0;
}

function paymentDueDayForDebt(debt) {
  for (const raw of [debt?.due_day, debt?.payment_due_day]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  }
  return NaN;
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
  const dueDay = Number(paymentDueDayForDebt(debt));
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return { ok: false, reason: "missing_due_day" };
  if (dueDay !== dayOfMonth) return { ok: false, reason: "no_due_today" };
  const balance = Math.max(0, safeNumber(debt?.balance ?? debt?.current_balance, 0));
  if (!(balance > 0)) return { ok: false, reason: "zero_balance" };
  const minimum = Math.max(0, minimumPaymentAmountForDebt(debt));
  if (!(minimum > 0)) return { ok: false, reason: "missing_min_payment" };
  const computed = computeAutoTrackedMinimumPayment(debt);
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

async function findExistingMinimumPaymentDueEvent(supabaseAdmin, userId, debtId, dateKey) {
  const { data, error } = await supabaseAdmin
    .from("notification_events")
    .select("id,event_type,created_at,metadata,message")
    .eq("user_id", userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingNotificationEventsTable(error)) return null;
    throw error;
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.find((row) => isMinimumPaymentDueEvent(row, debtId, dateKey)) || null;
}

function minimumPaymentDueEventStatus(row) {
  const meta = parseMetadata(row?.metadata);
  return safeString(meta.delivery_status || meta.status, 40).toLowerCase();
}

function buildMinimumPaymentDueEventPayload({
  userId,
  debtId,
  dateKey,
  amount,
  preview,
  deliveryStatus,
  reason,
  eventType = "minimum_payment_due"
}) {
  const metadata = {
    audit_type: "minimum_payment_due",
    source: AUTO_TRACK_SOURCE,
    debt_id: debtId,
    date_key: dateKey,
    amount,
    delivery_status: deliveryStatus
  };
  if (reason) metadata.reason = safeString(reason, 120);
  if (deliveryStatus === "sent") metadata.sent_at = new Date().toISOString();
  if (deliveryStatus === "failed") metadata.failed_at = new Date().toISOString();
  return {
    user_id: userId,
    channel: "email",
    event_type: eventType,
    message: resolveNotificationEventMessage(preview, "email"),
    metadata
  };
}

async function updateMinimumPaymentDueEvent(supabaseAdmin, eventId, userId, payload) {
  const { error } = await supabaseAdmin
    .from("notification_events")
    .update({
      message: payload.message,
      metadata: payload.metadata
    })
    .eq("id", eventId)
    .eq("user_id", userId);
  if (error) {
    if (isMissingNotificationEventsTable(error)) return { ok: false, reason: "notification_events_missing" };
    throw error;
  }
  return { ok: true, event_id: eventId };
}

async function insertMinimumPaymentDueEvent(supabaseAdmin, payload) {
  const { data, error } = await supabaseAdmin.from("notification_events").insert(payload).select("id").maybeSingle();
  if (!error) return { ok: true, event_id: data?.id || null };
  if (isMissingNotificationEventsTable(error)) return { ok: false, reason: "notification_events_missing" };
  if (isDuplicateNotificationEventError(error)) return { ok: true, duplicate: true };
  if (isUnsupportedNotificationEventType(error) && payload.event_type !== "test") {
    const fallbackPayload = {
      ...payload,
      event_type: "test",
      metadata: {
        ...payload.metadata,
        event_type_fallback: true
      }
    };
    const retry = await supabaseAdmin.from("notification_events").insert(fallbackPayload).select("id").maybeSingle();
    if (!retry.error) return { ok: true, event_id: retry.data?.id || null, fallback: true };
    if (isDuplicateNotificationEventError(retry.error)) return { ok: true, duplicate: true, fallback: true };
    if (isMissingNotificationEventsTable(retry.error)) return { ok: false, reason: "notification_events_missing" };
    throw retry.error;
  }
  throw error;
}

async function recordMinimumPaymentDueEvent(supabaseAdmin, existingEvent, details) {
  const payload = buildMinimumPaymentDueEventPayload(details);
  if (existingEvent?.id) {
    return updateMinimumPaymentDueEvent(supabaseAdmin, existingEvent.id, details.userId, payload);
  }
  return insertMinimumPaymentDueEvent(supabaseAdmin, payload);
}

async function rollbackIntent(supabaseAdmin, userId, intentId) {
  try {
    await supabaseAdmin.from("payment_executions").delete().eq("payment_intent_id", intentId);
  } catch (_) {}
  try {
    await supabaseAdmin.from("payment_intents").delete().eq("id", intentId).eq("user_id", userId);
  } catch (_) {}
}

async function mergeIntentMetadataForPaymentEmail(supabaseAdmin, userId, intentId, patch = {}) {
  const { data: current, error: currentError } = await supabaseAdmin
    .from("payment_intents")
    .select("metadata")
    .eq("id", intentId)
    .eq("user_id", userId)
    .single();
  if (currentError) throw currentError;
  const metadata = {
    ...parseMetadata(current?.metadata),
    ...patch
  };
  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", intentId)
    .eq("user_id", userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function runMinimumPaymentAutoTracking(deps = {}) {
  const {
    supabaseAdmin,
    now = new Date(),
    applyExecutedIntentToDebt,
    reconcileManualFirstPriorityIntent,
    appDebug,
    appError,
    env = process.env,
    http,
    sendEmailFn,
    sendMinimumPaymentDueEmailFn,
    sendTransactionalPaymentCelebrationEmailsFn,
    fetchAuthUserEmailFn
  } = deps;
  if (!supabaseAdmin) return { ok: false, error: "Supabase is not configured" };
  if (typeof applyExecutedIntentToDebt !== "function") {
    return { ok: false, error: "applyExecutedIntentToDebt is not configured" };
  }
  const doSendMinimumPaymentDueEmail =
    typeof sendMinimumPaymentDueEmailFn === "function" ? sendMinimumPaymentDueEmailFn : sendMinimumPaymentDueEmail;
  const doSendTransactionalPaymentCelebrationEmails =
    typeof sendTransactionalPaymentCelebrationEmailsFn === "function"
      ? sendTransactionalPaymentCelebrationEmailsFn
      : sendTransactionalPaymentCelebrationEmails;
  const doFetchAuthUserEmail =
    typeof fetchAuthUserEmailFn === "function" ? fetchAuthUserEmailFn : fetchAuthUserEmail;

  const summary = {
    ok: true,
    preferences_checked: 0,
    users_checked: 0,
    debts_checked: 0,
    minimum_due_emails_sent: 0,
    payment_recorded_emails_sent: 0,
    email_failures: 0,
    tracked: 0,
    skipped: 0,
    failures: 0,
    reason_counts: {},
    errors: []
  };

  const { data: prefRows, error: prefError } = await supabaseAdmin
    .from("notification_preferences")
    .select("user_id,email_enabled,consent_email_at,auto_track_minimum_payments,timezone,preferred_language");

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
    summary.preferences_checked += 1;
    if (!boolValue(pref?.auto_track_minimum_payments)) {
      increment(summary, "missing_auto_track_opt_in");
      continue;
    }
    if (!boolValue(pref?.email_enabled) || !pref?.consent_email_at) {
      increment(summary, "missing_email_enabled");
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
      pushSafeError(summary, "debts", "debt_lookup_failed", error);
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
          increment(summary, "already_tracked_today");
          continue;
        }

        const amount = eligible.computed.amount;
        let userEmail = null;
        let dueEvent = null;
        try {
          dueEvent = await findExistingMinimumPaymentDueEvent(supabaseAdmin, userId, debtId, local.dateKey);
        } catch (eventLookupError) {
          if (typeof appDebug === "function") {
            appDebug("auto-track minimum due event lookup skipped", eventLookupError?.message || String(eventLookupError));
          }
        }

        const dueEventAlreadySent = minimumPaymentDueEventStatus(dueEvent) === "sent";
        if (dueEventAlreadySent) {
          addReason(summary, "due_email_already_sent");
        } else {
          try {
            userEmail = await doFetchAuthUserEmail(supabaseAdmin, userId);
          } catch (_) {
            userEmail = null;
          }
          const dueEmail = await doSendMinimumPaymentDueEmail({
            supabaseAdmin,
            userId,
            userEmail,
            debtName: debt.name || debt.creditor_name || "Debt",
            amount,
            preferredLanguage: pref.preferred_language,
            env,
            http,
            sendEmailFn,
            appError
          });
          userEmail = dueEmail?.user_email || dueEmail?.userEmail || userEmail;
          const dueEmailSent = dueEmail && dueEmail.sent === true;
          try {
            const eventResult = await recordMinimumPaymentDueEvent(supabaseAdmin, dueEvent, {
              userId,
              debtId,
              dateKey: local.dateKey,
              amount,
              preview: dueEmail?.preview,
              deliveryStatus: dueEmailSent ? "sent" : "failed",
              reason: dueEmailSent ? null : dueEmail?.reason || "minimum_payment_due_email_not_sent"
            });
            if (!eventResult?.ok) addReason(summary, eventResult?.reason || "due_email_event_failed");
          } catch (eventWriteError) {
            addReason(summary, "due_email_event_failed");
            if (typeof appDebug === "function") {
              appDebug("auto-track minimum due event write skipped", eventWriteError?.message || String(eventWriteError));
            }
          }
          if (!dueEmailSent) {
            summary.email_failures += 1;
            increment(summary, "due_email_failed");
            continue;
          }
          summary.minimum_due_emails_sent += 1;
          addReason(summary, "due_email_sent");
        }
        if (!userEmail) {
          try {
            userEmail = await doFetchAuthUserEmail(supabaseAdmin, userId);
          } catch (_) {
            userEmail = null;
          }
        }

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
            increment(summary, "already_tracked_today");
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

        if (appliedOk) {
          try {
            const txEmail = await doSendTransactionalPaymentCelebrationEmails({
              supabaseAdmin,
              userId,
              userEmail,
              intentId,
              amount,
              debtNameDisplay: debt.name || debt.creditor_name || "Debt",
              previousBalance: debtApply.previous_balance,
              nextBalance: debtApply.next_balance,
              previousDebtStatus: debt.status || "active",
              preferredLanguageHint: pref.preferred_language,
              env,
              http,
              sendEmailFn,
              mergeIntentMetadata: (patch) =>
                mergeIntentMetadataForPaymentEmail(supabaseAdmin, userId, intentId, patch),
              appError
            });
            if (txEmail?.payment_email) {
              summary.payment_recorded_emails_sent += 1;
            } else {
              summary.email_failures += 1;
            }
          } catch (emailError) {
            summary.email_failures += 1;
            if (typeof appDebug === "function") {
              appDebug("auto-track minimum transactional email skipped", emailError?.message || String(emailError));
            }
          }
        }

        summary.tracked += 1;
        addReason(summary, "tracked_success");
      } catch (error) {
        pushSafeError(summary, "track_debt", "auto_track_minimum_failed", error);
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
