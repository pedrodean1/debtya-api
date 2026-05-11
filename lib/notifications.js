const axios = require("axios");

const VALID_CHANNELS = new Set(["email", "sms", "both", "none"]);
const OPEN_REMINDER_STATUSES = ["pending_review", "approved"];
const VALID_REMINDER_FREQUENCIES = new Set(["smart", "daily", "weekly", "off"]);

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

function normalizePhoneNumber(value) {
  const raw = safeString(value, 40);
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, "");
  if (!/^\+?[1-9]\d{7,14}$/.test(compact)) return null;
  return compact;
}

function normalizeReminderTime(value) {
  const s = safeString(value, 20);
  if (!s) return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

function normalizeReminderFrequency(raw) {
  const s = safeString(raw, 20).toLowerCase();
  if (VALID_REMINDER_FREQUENCIES.has(s)) return s;
  return "smart";
}

function defaultNotificationPreferences(userId = null) {
  return {
    user_id: userId,
    email_enabled: false,
    sms_enabled: false,
    phone_number: null,
    preferred_channel: "none",
    reminder_time: null,
    timezone: null,
    reminder_frequency: "smart",
    consent_sms_at: null,
    consent_email_at: null,
    created_at: null,
    updated_at: null
  };
}

function derivePreferredChannel(raw, emailEnabled, smsEnabled) {
  const ch = safeString(raw, 20).toLowerCase();
  if (ch === "both" && emailEnabled && smsEnabled) return "both";
  if (ch === "email" && emailEnabled) return "email";
  if (ch === "sms" && smsEnabled) return "sms";
  if (ch === "none") return "none";
  if (emailEnabled && smsEnabled) return "both";
  if (emailEnabled) return "email";
  if (smsEnabled) return "sms";
  return "none";
}

function normalizeNotificationPreferences(row, userId = null) {
  const base = defaultNotificationPreferences(userId);
  const source = row && typeof row === "object" ? row : {};
  const emailEnabled = !!source.email_enabled;
  const smsEnabled = !!source.sms_enabled;
  return {
    ...base,
    ...source,
    user_id: source.user_id || userId || null,
    email_enabled: emailEnabled,
    sms_enabled: smsEnabled,
    phone_number: source.phone_number || null,
    preferred_channel: derivePreferredChannel(source.preferred_channel, emailEnabled, smsEnabled),
    reminder_time: source.reminder_time || null,
    timezone: source.timezone || null,
    reminder_frequency: normalizeReminderFrequency(source.reminder_frequency),
    consent_sms_at: source.consent_sms_at || null,
    consent_email_at: source.consent_email_at || null
  };
}

function validateNotificationPreferencesInput(body, existing = null, nowIso = new Date().toISOString()) {
  const src = body && typeof body === "object" ? body : {};
  const previous = normalizeNotificationPreferences(existing, src.user_id || null);
  const emailEnabled = boolValue(src.email_enabled);
  const smsEnabled = boolValue(src.sms_enabled);
  const rawPhone = safeString(src.phone_number, 40);
  const phoneNumber = rawPhone ? normalizePhoneNumber(rawPhone) : null;

  if (rawPhone && !phoneNumber) {
    return { error: "phone_number must be a valid SMS-capable phone number" };
  }
  if (smsEnabled && !phoneNumber) {
    return { error: "phone_number is required when SMS reminders are enabled" };
  }
  const smsConsented = !!previous.consent_sms_at || boolValue(src.sms_consent);
  if (smsEnabled && !smsConsented) {
    return { error: "SMS consent is required before enabling SMS reminders" };
  }

  const emailConsented = !!previous.consent_email_at || boolValue(src.email_consent);
  if (emailEnabled && !emailConsented) {
    return { error: "Email consent is required before enabling email reminders" };
  }

  const reminderTime = src.reminder_time == null || src.reminder_time === "" ? null : normalizeReminderTime(src.reminder_time);
  if (src.reminder_time != null && src.reminder_time !== "" && !reminderTime) {
    return { error: "reminder_time must use HH:MM 24-hour format" };
  }

  const timezone = src.timezone == null || src.timezone === "" ? null : safeString(src.timezone, 80);
  const preferredChannel = derivePreferredChannel(src.preferred_channel, emailEnabled, smsEnabled);
  const reminderFrequency =
    src.reminder_frequency == null || src.reminder_frequency === ""
      ? previous.reminder_frequency || "smart"
      : normalizeReminderFrequency(src.reminder_frequency);

  return {
    payload: {
      email_enabled: emailEnabled,
      sms_enabled: smsEnabled,
      phone_number: phoneNumber,
      preferred_channel: preferredChannel,
      reminder_time: reminderTime,
      timezone,
      reminder_frequency: reminderFrequency,
      consent_sms_at: smsEnabled && !previous.consent_sms_at ? nowIso : previous.consent_sms_at,
      consent_email_at: emailEnabled && !previous.consent_email_at ? nowIso : previous.consent_email_at,
      updated_at: nowIso
    }
  };
}

async function fetchNotificationPreferences(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from("notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return normalizeNotificationPreferences(data, userId);
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

function isManualFirstIntent(intent) {
  const meta = parseMetadata(intent?.metadata);
  return meta.manual_first_priority === true || meta.manual_first_rebuild === true;
}

function visibleDebtName(value) {
  return safeString(value || "Debt", 120).replace(/^Spinwheel\s+/i, "") || "Debt";
}

function strategyLabel(strategy) {
  const s = safeString(strategy || "avalanche", 30).toLowerCase();
  return s === "snowball" ? "Snowball" : "Avalanche";
}

function reminderReason(strategy, es = false) {
  const label = strategyLabel(strategy);
  if (es) {
    if (label === "Snowball")
      return "coincide con tu plan Snowball y ayuda a tomar impulso enfocando el siguiente objetivo.";
    return "coincide con tu plan Avalanche y ayuda a enfocar el extra donde reduce mas presion de intereses.";
  }
  if (label === "Snowball") return "it matches your Snowball plan and helps build momentum by focusing the next target.";
  return "it matches your Avalanche plan and helps focus extra money where it can reduce interest pressure.";
}

function getAmountFromIntent(intent, getIntentAmount) {
  if (typeof getIntentAmount === "function") {
    const n = safeNumber(getIntentAmount(intent), NaN);
    if (Number.isFinite(n)) return n;
  }
  return safeNumber(intent?.amount ?? intent?.payment_amount ?? intent?.recommended_amount, 0);
}

async function findNextManualFirstIntent(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from("payment_intents")
    .select("*")
    .eq("user_id", userId)
    .in("status", OPEN_REMINDER_STATUSES)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.find(isManualFirstIntent) || null;
}

async function fetchDebtForIntent(supabaseAdmin, userId, intent) {
  const debtId = safeString(intent?.debt_id, 80);
  if (!debtId) return null;
  const { data, error } = await supabaseAdmin
    .from("debts")
    .select("*")
    .eq("id", debtId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchPlanStrategy(supabaseAdmin, userId, fallback) {
  const { data, error } = await supabaseAdmin
    .from("payment_plans")
    .select("strategy")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.strategy || fallback || "avalanche";
}

async function buildNextPaymentReminderPreview(opts) {
  const {
    supabaseAdmin,
    userId,
    channel = "email",
    getIntentAmount,
    appUrl = "https://www.debtya.com",
    lang = "en"
  } = opts || {};
  const es = String(lang || "en").toLowerCase().startsWith("es");
  if (!supabaseAdmin) {
    const err = new Error("Supabase is not configured");
    err.status = 500;
    throw err;
  }
  const intent = await findNextManualFirstIntent(supabaseAdmin, userId);
  if (!intent) {
    const err = new Error("No actionable manual-first payment reminder is available");
    err.status = 404;
    throw err;
  }
  const debt = await fetchDebtForIntent(supabaseAdmin, userId, intent);
  const strategy = await fetchPlanStrategy(supabaseAdmin, userId, intent.strategy);
  const amount = getAmountFromIntent(intent, getIntentAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Reminder intent has no valid amount");
    err.status = 400;
    throw err;
  }

  const debtName = visibleDebtName(debt?.name || intent.debt_name || intent.creditor_name || "Debt");
  const amountText = `$${amount.toFixed(2)}`;
  const label = strategyLabel(strategy);
  const reason = reminderReason(strategy, es);
  const sms = es
    ? `DebtYa: paga ${amountText} a ${debtName} hoy. Recomendado por tu plan ${label}. Paga fuera de DebtYa y luego marca Ya lo pague en la app.`
    : `DebtYa reminder: Pay ${amountText} to ${debtName} today. Recommended for your ${label} plan. Pay outside DebtYa, then tap I paid it in the app.`;
  const subject = es
    ? `DebtYa: pago sugerido ${amountText} (${debtName})`
    : `DebtYa reminder: pay ${amountText} to ${debtName}`;
  const body = es
    ? [
        `Pago recomendado: ${amountText}`,
        `Deuda: ${debtName}`,
        `Por que: DebtYa lo recomienda porque ${reason}`,
        "Haz el pago fuera de DebtYa. DebtYa no mueve dinero ni paga a acreedores por ti.",
        `Despues de pagar, abre ${appUrl} y marca Ya lo pague.`
      ].join("\n")
    : [
        `Recommended payment: ${amountText}`,
        `Debt: ${debtName}`,
        `Why: DebtYa recommends this because ${reason}`,
        "Make this payment outside DebtYa. DebtYa does not move money or pay creditors for you.",
        `After you pay, open ${appUrl} and tap I paid it.`
      ].join("\n");

  const normalizedChannel = VALID_CHANNELS.has(channel) ? channel : "email";
  return {
    channel: normalizedChannel,
    subject,
    message: normalizedChannel === "sms" ? sms : body,
    sms_message: sms,
    email_body: body,
    intent_id: intent.id || null,
    debt_id: intent.debt_id || null,
    debt_name: debtName,
    amount,
    strategy: String(strategy || "avalanche").toLowerCase()
  };
}

function providerState(env = process.env) {
  return {
    email_provider: safeString(env.EMAIL_PROVIDER || (env.RESEND_API_KEY ? "resend" : env.SENDGRID_API_KEY ? "sendgrid" : ""), 40).toLowerCase(),
    has_resend: !!safeString(env.RESEND_API_KEY, 200),
    has_sendgrid: !!safeString(env.SENDGRID_API_KEY, 200),
    sms_provider: safeString(env.SMS_PROVIDER || (env.TWILIO_ACCOUNT_SID ? "twilio" : ""), 40).toLowerCase(),
    has_twilio:
      !!safeString(env.TWILIO_ACCOUNT_SID, 200) &&
      !!safeString(env.TWILIO_AUTH_TOKEN, 200) &&
      !!safeString(env.TWILIO_FROM_NUMBER, 80)
  };
}

function isProviderConfigured(channel, env = process.env) {
  const st = providerState(env);
  if (channel === "email") return st.has_resend || st.has_sendgrid;
  if (channel === "sms") return st.has_twilio;
  return false;
}

async function sendEmailReminder({ to, preview, env = process.env, http = axios }) {
  if (env.RESEND_API_KEY) {
    await http.post(
      "https://api.resend.com/emails",
      {
        from: env.EMAIL_FROM || "DebtYa <notifications@debtya.com>",
        to,
        subject: preview.subject,
        text: preview.email_body || preview.message
      },
      {
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
    return { channel: "email", provider: "resend", sent: true };
  }
  if (env.SENDGRID_API_KEY) {
    await http.post(
      "https://api.sendgrid.com/v3/mail/send",
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.EMAIL_FROM || "notifications@debtya.com", name: "DebtYa" },
        subject: preview.subject,
        content: [{ type: "text/plain", value: preview.email_body || preview.message }]
      },
      {
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
    return { channel: "email", provider: "sendgrid", sent: true };
  }
  return { channel: "email", provider: null, sent: false };
}

async function sendSmsReminder({ to, preview, env = process.env, http = axios }) {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) {
    const body = new URLSearchParams({
      To: to,
      From: env.TWILIO_FROM_NUMBER,
      Body: preview.sms_message || preview.message
    });
    await http.post(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      body.toString(),
      {
        auth: {
          username: env.TWILIO_ACCOUNT_SID,
          password: env.TWILIO_AUTH_TOKEN
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000
      }
    );
    return { channel: "sms", provider: "twilio", sent: true };
  }
  return { channel: "sms", provider: null, sent: false };
}

async function sendReminder({ channel, to, preview, env = process.env, http = axios }) {
  if (channel === "email") return sendEmailReminder({ to, preview, env, http });
  if (channel === "sms") return sendSmsReminder({ to, preview, env, http });
  const err = new Error("Unsupported notification channel");
  err.status = 400;
  throw err;
}

function minGapMsForCadence(cadence) {
  if (cadence === "off") return Number.POSITIVE_INFINITY;
  if (cadence === "daily") return 22 * 60 * 60 * 1000;
  if (cadence === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 36 * 60 * 60 * 1000;
}

function localWallClockMinutes(nowUtc, timeZone) {
  try {
    const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "UTC";
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = fmt.formatToParts(nowUtc);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}

function parseHHMMToMinutes(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isWithinReminderTimeWindow(prefs, nowUtc = new Date(), windowMin = 35) {
  if (!prefs?.reminder_time) return true;
  const target = parseHHMMToMinutes(prefs.reminder_time);
  if (target == null) return true;
  const cur = localWallClockMinutes(nowUtc, prefs.timezone || "UTC");
  if (cur == null) return true;
  let diff = Math.abs(cur - target);
  if (diff > 12 * 60) diff = 24 * 60 - diff;
  return diff <= windowMin;
}

function isMissingNotificationEventsTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  if (code === "42P01") return true;
  if (msg.includes("notification_events") && (msg.includes("does not exist") || msg.includes("schema cache")))
    return true;
  return false;
}

async function fetchLastAutoReminderSentAt(supabaseAdmin, userId, intentId, channel) {
  const { data, error } = await supabaseAdmin
    .from("notification_events")
    .select("created_at")
    .eq("user_id", userId)
    .eq("intent_id", intentId)
    .eq("channel", channel)
    .eq("event_type", "auto_reminder")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingNotificationEventsTable(error)) return null;
    throw error;
  }
  if (!data?.created_at) return null;
  const t = new Date(data.created_at).getTime();
  return Number.isFinite(t) ? t : null;
}

async function insertAutoReminderEvent(supabaseAdmin, { user_id, intent_id, channel }) {
  const { error } = await supabaseAdmin.from("notification_events").insert({
    user_id,
    intent_id,
    channel,
    event_type: "auto_reminder"
  });
  if (error && !isMissingNotificationEventsTable(error)) throw error;
}

async function fetchAuthUserEmail(supabaseAdmin, userId) {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user?.email) return null;
    return String(data.user.email).trim() || null;
  } catch {
    return null;
  }
}

function isMissingNotificationPreferencesTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  if (code === "42P01") return true;
  if (msg.includes("notification_preferences") && (msg.includes("does not exist") || msg.includes("schema cache")))
    return true;
  return false;
}

/**
 * Procesa recordatorios automaticos para filas de notification_preferences.
 * Requiere tablas SQL V96/V97 y proveedores email/SMS configurados para enviar.
 */
async function runDuePaymentReminders(deps) {
  const { supabaseAdmin, getIntentAmount, env = process.env, http = axios, now = new Date() } = deps || {};
  if (!supabaseAdmin) {
    return { ok: false, error: "Supabase is not configured" };
  }

  const summary = { scanned: 0, eligible: 0, sent: 0, skipped: 0, errors: [] };

  const { data: rows, error } = await supabaseAdmin.from("notification_preferences").select("*");
  if (error) {
    if (isMissingNotificationPreferencesTable(error)) {
      return { ok: true, skipped_all: true, reason: "notification_preferences table missing" };
    }
    throw error;
  }

  for (const row of rows || []) {
    summary.scanned += 1;
    const prefs = normalizeNotificationPreferences(row, row.user_id);
    const cadence = normalizeReminderFrequency(prefs.reminder_frequency);
    if (cadence === "off") {
      summary.skipped += 1;
      continue;
    }
    if (!prefs.email_enabled && !prefs.sms_enabled) {
      summary.skipped += 1;
      continue;
    }
    if (!isWithinReminderTimeWindow(prefs, now)) {
      summary.skipped += 1;
      continue;
    }

    let intent;
    try {
      intent = await findNextManualFirstIntent(supabaseAdmin, prefs.user_id);
    } catch (e) {
      summary.errors.push({ user_id: prefs.user_id, step: "intent", message: e.message });
      continue;
    }
    if (!intent?.id) {
      summary.skipped += 1;
      continue;
    }

    const gapMs = minGapMsForCadence(cadence);
    const channels = [];
    if (prefs.email_enabled) channels.push("email");
    if (prefs.sms_enabled) channels.push("sms");

    let cachedEmail = null;
    for (const channel of channels) {
      if (!isProviderConfigured(channel, env)) {
        summary.skipped += 1;
        continue;
      }

      try {
        const lastMs = await fetchLastAutoReminderSentAt(supabaseAdmin, prefs.user_id, intent.id, channel);
        if (lastMs != null && now.getTime() - lastMs < gapMs) {
          summary.skipped += 1;
          continue;
        }

        const preview = await buildNextPaymentReminderPreview({
          supabaseAdmin,
          userId: prefs.user_id,
          channel,
          getIntentAmount,
          lang: "en"
        });

        let to = null;
        if (channel === "email") {
          cachedEmail = cachedEmail || (await fetchAuthUserEmail(supabaseAdmin, prefs.user_id));
          to = cachedEmail;
        } else {
          if (!prefs.phone_number || !prefs.consent_sms_at) {
            summary.skipped += 1;
            continue;
          }
          to = prefs.phone_number;
        }
        if (!to) {
          summary.skipped += 1;
          continue;
        }

        summary.eligible += 1;
        const sendResult = await sendReminder({ channel, to, preview, env, http });
        if (sendResult.sent) {
          await insertAutoReminderEvent(supabaseAdmin, {
            user_id: prefs.user_id,
            intent_id: intent.id,
            channel
          });
          summary.sent += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (e) {
        summary.errors.push({ user_id: prefs.user_id, channel, message: e.message });
      }
    }
  }

  return { ok: true, ...summary };
}

/** @deprecated use runDuePaymentReminders */
async function sendDuePaymentReminders(deps) {
  return runDuePaymentReminders(deps);
}

module.exports = {
  VALID_CHANNELS,
  VALID_REMINDER_FREQUENCIES,
  defaultNotificationPreferences,
  normalizeNotificationPreferences,
  validateNotificationPreferencesInput,
  fetchNotificationPreferences,
  buildNextPaymentReminderPreview,
  isProviderConfigured,
  providerState,
  sendReminder,
  runDuePaymentReminders,
  sendDuePaymentReminders,
  normalizePhoneNumber,
  normalizeReminderFrequency,
  minGapMsForCadence,
  isWithinReminderTimeWindow
};
