const axios = require("axios");
const { sendEmailReminder } = require("./notifications");
const { buildSystemDiagnostics } = require("./system-diagnostics");

const ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE = "admin_diagnostics_alert";
const DEFAULT_ADMIN_ALERT_COOLDOWN_HOURS = 24;
const MAX_ADMIN_ALERT_COOLDOWN_HOURS = 168;

function safeString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function safeInteger(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function splitAdminAlertList(value) {
  return String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function resolveAdminAlertRecipients(env = process.env) {
  const explicit = safeString(env.DEBTYA_ADMIN_ALERT_EMAILS, 4000);
  const fallback = safeString(env.DEBTYA_ADMIN_EMAILS, 4000);
  const raw = explicit || fallback;
  const seen = new Set();
  const out = [];

  for (const item of splitAdminAlertList(raw)) {
    const email = item.toLowerCase();
    if (!looksLikeEmail(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }

  return out;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function firstUuidFromList(value) {
  return splitAdminAlertList(value).find((item) => looksLikeUuid(item)) || null;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildAlertFingerprint(alerts = []) {
  const normalized = [...new Set((alerts || []).map((x) => safeString(x, 120)).filter(Boolean))].sort();
  return normalized.length ? normalized.join("|") : "ok";
}

function formatCountMap(value) {
  const entries = Object.entries(value || {}).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return "none";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function buildAdminDiagnosticsAlertEmailPreview({
  diagnostics,
  serverVersion = "",
  now = new Date()
}) {
  const generatedAt = diagnostics?.generated_at || new Date(now).toISOString();
  const alerts = Array.isArray(diagnostics?.alerts) ? diagnostics.alerts : [];
  const alertLines = alerts.length ? alerts.map((alert) => `- ${alert}`) : ["- diagnostics_warning"];

  const lines = [
    "DebtYa Diagnostics detected a warning.",
    "",
    `Generated: ${generatedAt}`,
    `Lookback days: ${diagnostics?.lookback_days ?? "unknown"}`,
    `Row limit: ${diagnostics?.row_limit ?? "unknown"}`,
    "",
    "Alerts:",
    ...alertLines,
    "",
    "Summary:",
    `- Active debts carrying balance: ${diagnostics?.debts?.active_carrying_count ?? 0}`,
    `- Paid or paid off debts: ${diagnostics?.debts?.paid_or_paid_off_count ?? 0}`,
    `- Paid debts with positive balance: ${diagnostics?.debts?.alert_counts?.paid_with_positive_balance ?? 0}`,
    `- Active debts with zero balance: ${diagnostics?.debts?.alert_counts?.active_zero_balance ?? 0}`,
    `- Open payment intents: ${diagnostics?.payment_intents?.open_count ?? 0}`,
    `- Executed payment intents: ${diagnostics?.payment_intents?.executed_count ?? 0}`,
    `- Open intents with retired metadata: ${diagnostics?.payment_intents?.alert_counts?.open_with_retired_metadata ?? 0}`,
    `- Open intents without debt id: ${diagnostics?.payment_intents?.alert_counts?.open_without_debt_id ?? 0}`,
    `- Payment recorded emails marked sent: ${diagnostics?.payment_intents?.payment_recorded_email_sent_count ?? 0}`,
    `- Debt paid emails marked sent: ${diagnostics?.payment_intents?.debt_paid_celebration_email_sent_count ?? 0}`,
    `- Recent notification events scanned: ${diagnostics?.notification_events?.scanned ?? 0}`,
    `- Minimum payment due email failures: ${diagnostics?.notification_events?.minimum_payment_due?.failed_count ?? 0}`,
    "",
    `Debt status counts: ${formatCountMap(diagnostics?.debts?.status_counts)}`,
    `Payment intent status counts: ${formatCountMap(diagnostics?.payment_intents?.status_counts)}`,
    `Notification event counts: ${formatCountMap(diagnostics?.notification_events?.event_type_counts)}`,
    "",
    `Server version: ${serverVersion || "unknown"}`,
    "",
    "Open the DebtYa admin Diagnostics panel for details."
  ];

  return {
    subject: "DebtYa admin alert: Diagnostics warning",
    message: lines.join("\n"),
    email_body: lines.join("\n")
  };
}

function eventMatchesAdminAlert(row, fingerprint, sinceMs) {
  const metadata = parseMetadata(row?.metadata);
  const createdMs = new Date(row?.created_at || 0).getTime();
  if (!Number.isFinite(createdMs) || createdMs < sinceMs) return false;
  if (safeString(row?.channel, 40) !== "email") return false;
  if (safeString(metadata.audit_type, 80) !== ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE) return false;
  if (safeString(metadata.fingerprint, 500) !== fingerprint) return false;
  const deliveryStatus = safeString(metadata.delivery_status || metadata.status, 40);
  return deliveryStatus === "sent" || deliveryStatus === "partial";
}

async function resolveAdminAlertAuditUserId({ supabaseAdmin, env = process.env } = {}) {
  const configured =
    firstUuidFromList(env.DEBTYA_ADMIN_ALERT_AUDIT_USER_ID) ||
    firstUuidFromList(env.DEBTYA_ADMIN_USER_IDS);
  if (configured) return configured;

  const emails = resolveAdminAlertRecipients(env);
  if (!emails.length || !supabaseAdmin?.auth?.admin?.listUsers) return null;

  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (error) return null;
    const users = Array.isArray(data?.users) ? data.users : [];
    const wanted = new Set(emails.map((x) => x.toLowerCase()));
    const match = users.find((user) => wanted.has(safeString(user?.email, 320).toLowerCase()));
    return looksLikeUuid(match?.id) ? match.id : null;
  } catch {
    return null;
  }
}

async function findRecentAdminAlertEvent({ supabaseAdmin, auditUserId, fingerprint, sinceMs }) {
  if (!supabaseAdmin || !auditUserId) {
    return { ok: true, found: false, audit_available: false };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("notification_events")
      .select("id,channel,event_type,created_at,metadata")
      .eq("user_id", auditUserId)
      .eq("channel", "email")
      .eq("event_type", "test")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      return { ok: false, found: false, audit_available: false, reason: "admin_alert_audit_lookup_failed" };
    }

    const found = (data || []).find((row) => eventMatchesAdminAlert(row, fingerprint, sinceMs));
    return { ok: true, found: !!found, audit_available: true };
  } catch {
    return { ok: false, found: false, audit_available: false, reason: "admin_alert_audit_lookup_failed" };
  }
}

async function recordAdminAlertEvent({
  supabaseAdmin,
  auditUserId,
  fingerprint,
  diagnostics,
  deliveryStatus,
  recipientsCount,
  sentCount,
  failedCount,
  now = new Date()
}) {
  if (!supabaseAdmin || !auditUserId) {
    return { ok: true, recorded: false, reason: "admin_alert_audit_user_missing" };
  }

  const nowIso = new Date(now).toISOString();
  const metadata = {
    audit_type: ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE,
    fingerprint,
    delivery_status: deliveryStatus,
    alerts: Array.isArray(diagnostics?.alerts) ? diagnostics.alerts.slice(0, 20) : [],
    overall_status: safeString(diagnostics?.overall_status, 40),
    generated_at: safeString(diagnostics?.generated_at, 80),
    recipients_count: recipientsCount,
    sent_count: sentCount,
    failed_count: failedCount,
    recorded_at: nowIso
  };

  try {
    const { error } = await supabaseAdmin
      .from("notification_events")
      .insert({
        user_id: auditUserId,
        channel: "email",
        event_type: "test",
        message: "DebtYa admin diagnostics alert",
        metadata,
        created_at: nowIso
      })
      .select("id")
      .maybeSingle();

    if (error) {
      return { ok: false, recorded: false, reason: "admin_alert_audit_insert_failed" };
    }

    return { ok: true, recorded: true };
  } catch {
    return { ok: false, recorded: false, reason: "admin_alert_audit_insert_failed" };
  }
}

async function sendAdminAlertEmail({ recipients, preview, sendEmailFn, env, http }) {
  const sender =
    typeof sendEmailFn === "function"
      ? sendEmailFn
      : (opts) => sendEmailReminder({ ...opts, env, http });
  const results = [];

  for (const to of recipients) {
    try {
      const result = await sender({ to, preview, env, http });
      results.push({
        ok: !!result?.sent,
        provider: safeString(result?.provider, 40) || null,
        reason: result?.sent ? "sent" : "provider_returned_not_sent"
      });
    } catch (error) {
      results.push({
        ok: false,
        provider: null,
        reason: "provider_send_failed",
        code: safeString(error?.code || error?.status || error?.statusCode, 40) || null
      });
    }
  }

  return results;
}

async function runAdminDiagnosticsAlert({
  supabaseAdmin,
  safeNumber = Number,
  env = process.env,
  http = axios,
  sendEmailFn,
  now = new Date(),
  days,
  limit,
  force = false,
  serverVersion = ""
} = {}) {
  if (!supabaseAdmin) throw new Error("Supabase no configurado");

  const recipients = resolveAdminAlertRecipients(env);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!recipients.length) {
    return {
      ok: true,
      ran_at: nowIso,
      skipped: true,
      reason: "admin_alert_recipients_missing",
      recipients_count: 0,
      sent_count: 0,
      failed_count: 0
    };
  }

  const diagnostics = await buildSystemDiagnostics({
    supabaseAdmin,
    safeNumber,
    days,
    limit,
    now: new Date(nowMs)
  });

  const alerts = Array.isArray(diagnostics.alerts) ? diagnostics.alerts : [];
  const fingerprint = buildAlertFingerprint(alerts);
  const cooldownHours = safeInteger(
    env.DEBTYA_ADMIN_ALERT_COOLDOWN_HOURS,
    DEFAULT_ADMIN_ALERT_COOLDOWN_HOURS,
    MAX_ADMIN_ALERT_COOLDOWN_HOURS
  );

  if (diagnostics.overall_status !== "warning" || !alerts.length) {
    return {
      ok: true,
      ran_at: nowIso,
      generated_at: diagnostics.generated_at,
      overall_status: diagnostics.overall_status,
      alerts,
      skipped: true,
      reason: "diagnostics_ok",
      recipients_count: recipients.length,
      sent_count: 0,
      failed_count: 0,
      cooldown_hours: cooldownHours
    };
  }

  const auditUserId = await resolveAdminAlertAuditUserId({ supabaseAdmin, env });
  const sinceMs = nowMs - cooldownHours * 60 * 60 * 1000;
  const cooldown = force
    ? { ok: true, found: false, audit_available: !!auditUserId, forced: true }
    : await findRecentAdminAlertEvent({ supabaseAdmin, auditUserId, fingerprint, sinceMs });

  if (cooldown.found) {
    return {
      ok: true,
      ran_at: nowIso,
      generated_at: diagnostics.generated_at,
      overall_status: diagnostics.overall_status,
      alerts,
      skipped: true,
      reason: "admin_alert_cooldown_active",
      recipients_count: recipients.length,
      sent_count: 0,
      failed_count: 0,
      cooldown_hours: cooldownHours,
      audit_available: cooldown.audit_available
    };
  }

  const preview = buildAdminDiagnosticsAlertEmailPreview({
    diagnostics,
    serverVersion,
    now: new Date(nowMs)
  });
  const sendResults = await sendAdminAlertEmail({
    recipients,
    preview,
    sendEmailFn,
    env,
    http
  });
  const sentCount = sendResults.filter((item) => item.ok).length;
  const failedCount = sendResults.length - sentCount;
  const deliveryStatus = sentCount === recipients.length ? "sent" : sentCount > 0 ? "partial" : "failed";
  const audit = await recordAdminAlertEvent({
    supabaseAdmin,
    auditUserId,
    fingerprint,
    diagnostics,
    deliveryStatus,
    recipientsCount: recipients.length,
    sentCount,
    failedCount,
    now: new Date(nowMs)
  });

  return {
    ok: true,
    ran_at: nowIso,
    generated_at: diagnostics.generated_at,
    overall_status: diagnostics.overall_status,
    alerts,
    skipped: false,
    reason: sentCount > 0 ? "admin_alert_sent" : "admin_alert_failed",
    recipients_count: recipients.length,
    sent_count: sentCount,
    failed_count: failedCount,
    cooldown_hours: cooldownHours,
    audit_available: !!auditUserId,
    audit_recorded: !!audit.recorded,
    audit_reason: audit.recorded ? undefined : audit.reason
  };
}

module.exports = {
  ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE,
  DEFAULT_ADMIN_ALERT_COOLDOWN_HOURS,
  buildAdminDiagnosticsAlertEmailPreview,
  buildAlertFingerprint,
  resolveAdminAlertAuditUserId,
  resolveAdminAlertRecipients,
  runAdminDiagnosticsAlert
};
