const { debtRowEligibleForPlan, debtRowListedAsPaid } = require("./debt-paid-helpers");
const { STALE_PAYMENT_INTENT_OPEN_STATUSES } = require("./payment-intent-stale-guard");

const DEFAULT_DIAGNOSTIC_DAYS = 7;
const MAX_DIAGNOSTIC_DAYS = 90;
const DEFAULT_DIAGNOSTIC_LIMIT = 1000;
const MAX_DIAGNOSTIC_LIMIT = 5000;

function clampInteger(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function normalizeStatus(value, fallback = "unknown") {
  const s = String(value || "").toLowerCase().trim();
  return s || fallback;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function increment(target, key, amount = 1) {
  const k = String(key || "unknown");
  target[k] = (target[k] || 0) + amount;
}

function safeErrorSummary(error) {
  return {
    code: error?.code || null,
    message: String(error?.message || error?.details || error || "unknown").slice(0, 180)
  };
}

async function loadDiagnosticRows({ supabaseAdmin, table, columns, limit, orderColumn, sinceIso }) {
  try {
    let query = supabaseAdmin.from(table).select(columns);
    if (sinceIso && query && typeof query.gte === "function") query = query.gte("created_at", sinceIso);
    if (orderColumn && query && typeof query.order === "function") {
      query = query.order(orderColumn, { ascending: false, nullsFirst: false });
    }
    if (query && typeof query.limit === "function") query = query.limit(limit);

    const { data, error } = await query;
    if (error) return { ok: false, rows: [], error: safeErrorSummary(error) };
    return { ok: true, rows: Array.isArray(data) ? data : [], error: null };
  } catch (error) {
    return { ok: false, rows: [], error: safeErrorSummary(error) };
  }
}

function summarizeDebts(rows, safeNumber = Number) {
  const statusCounts = {};
  let activeCarrying = 0;
  let paidOrPaidOff = 0;
  let inactive = 0;
  let activeBalance = 0;
  let activeZeroBalance = 0;
  let paidWithPositiveBalance = 0;

  for (const row of rows || []) {
    const status = normalizeStatus(row?.status, "active");
    const balance = safeNumber(row?.balance, 0);
    const isPaidStatus = status === "paid" || status === "paid_off";
    increment(statusCounts, status);
    if (row?.is_active === false) inactive += 1;
    if (debtRowEligibleForPlan(row, safeNumber)) {
      activeCarrying += 1;
      activeBalance += balance;
    }
    if (debtRowListedAsPaid(row, safeNumber)) paidOrPaidOff += 1;
    if (row?.is_active !== false && !isPaidStatus && balance <= 0.01) activeZeroBalance += 1;
    if (isPaidStatus && balance > 0.01) paidWithPositiveBalance += 1;
  }

  return {
    scanned: rows.length,
    active_carrying_count: activeCarrying,
    paid_or_paid_off_count: paidOrPaidOff,
    inactive_count: inactive,
    active_total_balance: Number(activeBalance.toFixed(2)),
    status_counts: statusCounts,
    alert_counts: {
      active_zero_balance: activeZeroBalance,
      paid_with_positive_balance: paidWithPositiveBalance
    }
  };
}

function summarizePaymentIntents(rows) {
  const statusCounts = {};
  let openCount = 0;
  let executedCount = 0;
  let retiredMetadataCount = 0;
  let openWithRetiredMetadata = 0;
  let openWithoutDebtId = 0;
  let paymentRecordedEmailSent = 0;
  let debtPaidCelebrationEmailSent = 0;

  for (const row of rows || []) {
    const status = normalizeStatus(row?.status);
    const metadata = parseMetadata(row?.metadata);
    const isOpen = STALE_PAYMENT_INTENT_OPEN_STATUSES.includes(status);
    increment(statusCounts, status);
    if (isOpen) openCount += 1;
    if (status === "executed" || row?.executed_at) executedCount += 1;
    if (metadata.stale_intent_retired_at || metadata.stale_intent_retired_reason) retiredMetadataCount += 1;
    if (isOpen && (metadata.stale_intent_retired_at || metadata.stale_intent_retired_reason)) {
      openWithRetiredMetadata += 1;
    }
    if (isOpen && !row?.debt_id) openWithoutDebtId += 1;
    if (metadata.payment_recorded_email_sent_at) paymentRecordedEmailSent += 1;
    if (metadata.debt_paid_celebration_email_sent_at) debtPaidCelebrationEmailSent += 1;
  }

  return {
    scanned: rows.length,
    open_count: openCount,
    executed_count: executedCount,
    retired_metadata_count: retiredMetadataCount,
    payment_recorded_email_sent_count: paymentRecordedEmailSent,
    debt_paid_celebration_email_sent_count: debtPaidCelebrationEmailSent,
    status_counts: statusCounts,
    alert_counts: {
      open_with_retired_metadata: openWithRetiredMetadata,
      open_without_debt_id: openWithoutDebtId
    }
  };
}

function summarizeNotificationEvents(rows) {
  const eventTypeCounts = {};
  const channelCounts = {};
  const eventTypeChannelCounts = {};
  let minimumPaymentDueSent = 0;
  let minimumPaymentDueFailed = 0;

  for (const row of rows || []) {
    const eventType = normalizeStatus(row?.event_type, "unknown");
    const channel = normalizeStatus(row?.channel, "unknown");
    const metadata = parseMetadata(row?.metadata);
    increment(eventTypeCounts, eventType);
    increment(channelCounts, channel);
    increment(eventTypeChannelCounts, `${eventType}:${channel}`);
    if (eventType === "minimum_payment_due") {
      const deliveryStatus = normalizeStatus(metadata.delivery_status || metadata.status, "");
      if (deliveryStatus === "sent") minimumPaymentDueSent += 1;
      if (deliveryStatus === "failed") minimumPaymentDueFailed += 1;
    }
  }

  return {
    scanned: rows.length,
    event_type_counts: eventTypeCounts,
    channel_counts: channelCounts,
    event_type_channel_counts: eventTypeChannelCounts,
    minimum_payment_due: {
      sent_count: minimumPaymentDueSent,
      failed_count: minimumPaymentDueFailed
    }
  };
}

function buildAlerts({ debts, intents, notificationEvents, queryFailures }) {
  const alerts = [];
  if (queryFailures.length) alerts.push("diagnostics_partial_query_failure");
  if ((debts.alert_counts?.paid_with_positive_balance || 0) > 0) alerts.push("paid_debts_with_positive_balance");
  if ((debts.alert_counts?.active_zero_balance || 0) > 0) alerts.push("active_debts_with_zero_balance");
  if ((intents.alert_counts?.open_with_retired_metadata || 0) > 0) alerts.push("open_intents_retired_metadata_only");
  if ((intents.alert_counts?.open_without_debt_id || 0) > 0) alerts.push("open_intents_without_debt_id");
  if ((notificationEvents.minimum_payment_due?.failed_count || 0) > 0) {
    alerts.push("recent_minimum_payment_due_email_failures");
  }
  return alerts;
}

async function buildSystemDiagnostics({
  supabaseAdmin,
  safeNumber = Number,
  days = DEFAULT_DIAGNOSTIC_DAYS,
  limit = DEFAULT_DIAGNOSTIC_LIMIT,
  now = new Date()
}) {
  if (!supabaseAdmin) throw new Error("Supabase no configurado");
  const lookbackDays = clampInteger(days, DEFAULT_DIAGNOSTIC_DAYS, MAX_DIAGNOSTIC_DAYS);
  const rowLimit = clampInteger(limit, DEFAULT_DIAGNOSTIC_LIMIT, MAX_DIAGNOSTIC_LIMIT);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const sinceIso = new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const [debtRows, intentRows, eventRows] = await Promise.all([
    loadDiagnosticRows({
      supabaseAdmin,
      table: "debts",
      columns: "id,status,balance,is_active,created_at,updated_at",
      orderColumn: "updated_at",
      limit: rowLimit
    }),
    loadDiagnosticRows({
      supabaseAdmin,
      table: "payment_intents",
      columns: "id,debt_id,status,metadata,created_at,updated_at,executed_at",
      orderColumn: "updated_at",
      limit: rowLimit
    }),
    loadDiagnosticRows({
      supabaseAdmin,
      table: "notification_events",
      columns: "id,event_type,channel,created_at,metadata",
      orderColumn: "created_at",
      sinceIso,
      limit: rowLimit
    })
  ]);

  const queryFailures = [];
  if (!debtRows.ok) queryFailures.push({ table: "debts", error: debtRows.error });
  if (!intentRows.ok) queryFailures.push({ table: "payment_intents", error: intentRows.error });
  if (!eventRows.ok) queryFailures.push({ table: "notification_events", error: eventRows.error });

  const debts = summarizeDebts(debtRows.rows, safeNumber);
  const paymentIntents = summarizePaymentIntents(intentRows.rows);
  const notificationEvents = summarizeNotificationEvents(eventRows.rows);
  const alerts = buildAlerts({ debts, intents: paymentIntents, notificationEvents, queryFailures });

  return {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    lookback_days: lookbackDays,
    row_limit: rowLimit,
    overall_status: alerts.length ? "warning" : "ok",
    alerts,
    query_failures: queryFailures,
    debts,
    payment_intents: paymentIntents,
    notification_events: notificationEvents
  };
}

module.exports = {
  DEFAULT_DIAGNOSTIC_DAYS,
  MAX_DIAGNOSTIC_DAYS,
  DEFAULT_DIAGNOSTIC_LIMIT,
  MAX_DIAGNOSTIC_LIMIT,
  buildSystemDiagnostics,
  summarizeDebts,
  summarizePaymentIntents,
  summarizeNotificationEvents
};
