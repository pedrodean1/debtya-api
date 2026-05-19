const axios = require("axios");
const { Resend } = require("resend");

const VALID_CHANNELS = new Set(["email", "sms", "both", "none"]);
const OPEN_REMINDER_STATUSES = ["pending_review", "approved"];
const VALID_REMINDER_FREQUENCIES = new Set(["smart", "daily", "weekly", "twice_weekly", "off"]);
const TUESDAY_FRIDAY_REMINDER_GAP_MS = 36 * 60 * 60 * 1000;
const TUESDAY_FRIDAY_REMINDER_DAYS = new Set([2, 5]);

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
  return "twice_weekly";
}

/** Reminder email/SMS language; only en and es are supported. */
function normalizePreferredLanguage(raw) {
  const s = safeString(raw, 10).toLowerCase();
  return s === "es" ? "es" : "en";
}

/** Body `preferred_language` or header `x-debtya-language` (en|es); null if absent. */
function parsePreferredLanguageHintFromHttp(req) {
  if (!req || typeof req !== "object") return null;
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const fromBody = b.preferred_language;
  if (fromBody != null && String(fromBody).trim() !== "") return String(fromBody).trim();
  const h = req.headers && (req.headers["x-debtya-language"] || req.headers["X-Debtya-Language"]);
  if (h != null && String(h).trim() !== "") return String(h).trim();
  return null;
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
    reminder_frequency: "twice_weekly",
    preferred_language: "en",
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
    preferred_language: normalizePreferredLanguage(source.preferred_language),
    consent_sms_at: source.consent_sms_at || null,
    consent_email_at: source.consent_email_at || null
  };
}

function validateNotificationPreferencesInput(body, existing = null, nowIso = new Date().toISOString()) {
  const src = body && typeof body === "object" ? body : {};
  const previous = normalizeNotificationPreferences(existing, src.user_id || null);

  const emailEnabled = "email_enabled" in src ? boolValue(src.email_enabled) : previous.email_enabled;
  const smsEnabled = "sms_enabled" in src ? boolValue(src.sms_enabled) : previous.sms_enabled;

  let phoneNumber;
  if ("phone_number" in src) {
    const rawPhone = safeString(src.phone_number, 40);
    phoneNumber = rawPhone ? normalizePhoneNumber(rawPhone) : null;
    if (rawPhone && !phoneNumber) {
      return { error: "phone_number must be a valid SMS-capable phone number" };
    }
  } else {
    phoneNumber = previous.phone_number || null;
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

  let reminderTime;
  if ("reminder_time" in src) {
    reminderTime =
      src.reminder_time == null || src.reminder_time === "" ? null : normalizeReminderTime(src.reminder_time);
    if (src.reminder_time != null && src.reminder_time !== "" && !reminderTime) {
      return { error: "reminder_time must use HH:MM 24-hour format" };
    }
  } else {
    reminderTime = previous.reminder_time;
  }

  const timezone =
    "timezone" in src
      ? src.timezone == null || src.timezone === ""
        ? null
        : safeString(src.timezone, 80)
      : previous.timezone;

  const preferredChannel =
    "preferred_channel" in src
      ? derivePreferredChannel(src.preferred_channel, emailEnabled, smsEnabled)
      : previous.preferred_channel;

  const reminderFrequency =
    !("reminder_frequency" in src) ||
    src.reminder_frequency == null ||
    String(src.reminder_frequency).trim() === ""
      ? previous.reminder_frequency || "twice_weekly"
      : normalizeReminderFrequency(src.reminder_frequency);

  const preferredLanguageRaw =
    !("preferred_language" in src) || src.preferred_language == null || String(src.preferred_language).trim() === ""
      ? previous.preferred_language
      : src.preferred_language;
  const preferredLanguage = normalizePreferredLanguage(preferredLanguageRaw);

  return {
    payload: {
      email_enabled: emailEnabled,
      sms_enabled: smsEnabled,
      phone_number: phoneNumber,
      preferred_channel: preferredChannel,
      reminder_time: reminderTime,
      timezone,
      reminder_frequency: reminderFrequency,
      preferred_language: preferredLanguage,
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

async function fetchNotificationPreferenceRow(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from("notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
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

function isGenericDebtLabel(value) {
  return /^debt$/i.test(safeString(value, 200));
}

/** Human-facing debt line; uses a neutral label when no real name is known. */
function reminderDebtDisplayName(rawNameHint, es) {
  const sanitized = visibleDebtName(rawNameHint || "");
  return isGenericDebtLabel(sanitized) ? (es ? "tu deuda prioritaria" : "your priority debt") : sanitized;
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
    lang,
    preferredLanguage
  } = opts || {};
  const langResolved = normalizePreferredLanguage(preferredLanguage ?? lang ?? "en");
  const es = langResolved === "es";
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

  const rawNameHint = debt?.name || intent.debt_name || intent.creditor_name || "";
  const debtNameDisplay = reminderDebtDisplayName(rawNameHint, es);
  const amountText = `$${amount.toFixed(2)}`;
  const sms = es
    ? `DebtYa: pago recomendado ${amountText} (${debtNameDisplay}). Este pago ayuda a avanzar tu plan. Haz el pago con tu acreedor o banco; luego en DebtYa marca "Ya lo pagué".`
    : `DebtYa: suggested payment ${amountText} (${debtNameDisplay}). This payment advances your plan. Pay your creditor or bank directly, then in DebtYa tap "I paid it".`;
  const subject = es ? "DebtYa: recordatorio de pago sugerido" : "DebtYa: your payment reminder";
  const bodyLinesEs = [
    "Hola,",
    "",
    `Deuda recomendada: ${debtNameDisplay}`,
    `Monto recomendado: ${amountText}`,
    "",
    "Este pago ayuda a avanzar tu plan y reducir tu deuda.",
    "",
    "Haz el pago directamente con tu acreedor o banco.",
    `Después vuelve a DebtYa y toca 'Ya lo pagué' para actualizar tu progreso.`,
    "",
    `Donde hacerlo cuando quieras: ${appUrl}`,
    "",
    "DebtYa no mueve dinero ni ejecuta pagos por ti."
  ];
  const bodyLinesEn = [
    "Hello,",
    "",
    `Recommended debt: ${debtNameDisplay}`,
    `Suggested payment amount: ${amountText}`,
    "",
    "This payment helps advance your plan and reduce your debt.",
    "",
    "Make the payment directly with your creditor or bank.",
    `Then return to DebtYa and tap "I paid it" to update your progress.`,
    "",
    `When you are ready: ${appUrl}`,
    "",
    "DebtYa does not move money or make payments for you."
  ];
  const body = es ? bodyLinesEs.join("\n") : bodyLinesEn.join("\n");

  const normalizedChannel = VALID_CHANNELS.has(channel) ? channel : "email";
  return {
    channel: normalizedChannel,
    subject,
    message: normalizedChannel === "sms" ? sms : body,
    sms_message: sms,
    email_body: body,
    intent_id: intent.id || null,
    debt_id: intent.debt_id || null,
    debt_name: debtNameDisplay,
    amount,
    strategy: String(strategy || "avalanche").toLowerCase()
  };
}

/** SMS real sending is opt-in until product turns it on (Render: set DEBTYA_SEND_REAL_SMS_REMINDERS=true). */
function canSendSmsRemindersLive(env = process.env) {
  return String(env.DEBTYA_SEND_REAL_SMS_REMINDERS || "")
    .trim()
    .toLowerCase() === "true";
}

function resolveDebtYaReminderFromAddress(env = process.env) {
  const a = safeString(env.EMAIL_FROM, 512);
  if (a) return a;
  const b = safeString(env.RESEND_FROM_EMAIL, 512);
  if (b) return b;
  return "DebtYa <onboarding@resend.dev>";
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
  if (channel === "sms") return canSendSmsRemindersLive(env) && st.has_twilio;
  return false;
}

async function sendEmailReminder({ to, preview, env = process.env, http = axios }) {
  const resendKey = safeString(env.RESEND_API_KEY, 512);
  if (resendKey) {
    const from = resolveDebtYaReminderFromAddress(env);
    const resend = new Resend(resendKey);
    const { error } = await resend.emails.send({
      from,
      to,
      subject: preview.subject,
      text: preview.email_body || preview.message
    });
    if (error) {
      const err = new Error(error.message || "Resend email send failed");
      const sc = Number(error.statusCode);
      err.status = Number.isFinite(sc) && sc >= 400 && sc < 500 ? 400 : 500;
      throw err;
    }
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
  if (!canSendSmsRemindersLive(env)) {
    return { channel: "sms", provider: null, sent: false };
  }
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
  return TUESDAY_FRIDAY_REMINDER_GAP_MS;
}

/** Minimo entre dos envios automaticos para el mismo usuario (cualquier canal). */
function minUserWideGapMs(cadence) {
  if (cadence === "off") return Number.POSITIVE_INFINITY;
  return TUESDAY_FRIDAY_REMINDER_GAP_MS;
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

function localWeekdayIndex(nowUtc, timeZone) {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  if (Number.isNaN(now.getTime())) return null;
  try {
    const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "UTC";
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
    const short = String(fmt.format(now)).slice(0, 3).toLowerCase();
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    return Object.prototype.hasOwnProperty.call(map, short) ? map[short] : now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

function isTuesdayFridayReminderDay(nowUtc = new Date(), timeZone = "UTC") {
  const day = localWeekdayIndex(nowUtc, timeZone || "UTC");
  return day != null && TUESDAY_FRIDAY_REMINDER_DAYS.has(day);
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
    .select("created_at,metadata")
    .eq("user_id", userId)
    .eq("intent_id", intentId)
    .eq("channel", channel)
    .eq("event_type", "auto_reminder")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingNotificationEventsTable(error)) return null;
    throw error;
  }
  return lastNonForceTestEventMs(data);
}

async function fetchLastAutoReminderSentAtForUserAny(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from("notification_events")
    .select("created_at,metadata")
    .eq("user_id", userId)
    .eq("event_type", "auto_reminder")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingNotificationEventsTable(error)) return null;
    throw error;
  }
  return lastNonForceTestEventMs(data);
}

async function fetchLastAutoReminderSentAtForUserChannel(supabaseAdmin, userId, channel) {
  const { data, error } = await supabaseAdmin
    .from("notification_events")
    .select("created_at,metadata")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("event_type", "auto_reminder")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingNotificationEventsTable(error)) return null;
    throw error;
  }
  return lastNonForceTestEventMs(data);
}

function isForceTestNotificationEvent(row) {
  const meta = parseMetadata(row?.metadata);
  return meta.force_test === true || meta.force_test === "true" || meta.force_test === 1;
}

function lastNonForceTestEventMs(data) {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows.find((r) => r?.created_at && !isForceTestNotificationEvent(r));
  if (!row?.created_at) return null;
  const t = new Date(row.created_at).getTime();
  return Number.isFinite(t) ? t : null;
}

const NOTIFICATION_EVENT_MESSAGE_FALLBACK = "DebtYa reminder sent";
const NOTIFICATION_EVENT_MESSAGE_MAX = 8000;

/** Texto legible obligatorio para filas notification_events.message (NOT NULL en producción). */
function resolveNotificationEventMessage(preview, channel) {
  const fb = NOTIFICATION_EVENT_MESSAGE_FALLBACK;
  if (!preview || typeof preview !== "object") return fb;
  const ch = String(channel || "").toLowerCase();
  if (ch === "sms") {
    const s = safeString(preview.sms_message || preview.message, NOTIFICATION_EVENT_MESSAGE_MAX);
    return s || fb;
  }
  const subject = safeString(preview.subject, 500);
  const body = safeString(preview.email_body || preview.message, NOTIFICATION_EVENT_MESSAGE_MAX);
  const oneLine = [subject, body].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  const out = oneLine.slice(0, NOTIFICATION_EVENT_MESSAGE_MAX);
  return out || fb;
}

async function insertAutoReminderEvent(supabaseAdmin, { user_id, intent_id, channel, preview, metadata = null }) {
  const message = resolveNotificationEventMessage(preview, channel);
  const payload = {
    user_id,
    intent_id,
    channel,
    event_type: "auto_reminder",
    message
  };
  if (metadata && typeof metadata === "object") {
    payload.metadata = metadata;
  }
  const { error } = await supabaseAdmin.from("notification_events").insert(payload);
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

function safeCronErrorCode(error) {
  const raw = safeString(error?.code || error?.statusCode || error?.status || "", 80);
  const code = raw.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return code || undefined;
}

function cronErrorSummary({ userId, channel, step, reason, error }) {
  const out = {
    user_id: userId,
    message: reason || "notification_send_failed"
  };
  if (channel) out.channel = channel;
  if (step) out.step = step;
  const code = safeCronErrorCode(error);
  if (code) out.code = code;
  return out;
}

function isMissingNotificationPreferencesTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  if (code === "42P01") return true;
  if (msg.includes("notification_preferences") && (msg.includes("does not exist") || msg.includes("schema cache")))
    return true;
  return false;
}

function incrementReminderReason(summary, reason) {
  const key = safeString(reason || "skipped", 80) || "skipped";
  summary.skipped += 1;
  summary.reason_counts[key] = (summary.reason_counts[key] || 0) + 1;
}

function isoFromMs(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

async function buildReminderDebugState(opts) {
  const { supabaseAdmin, userId, getIntentAmount, env = process.env, now = new Date() } = opts || {};
  if (!supabaseAdmin) {
    const err = new Error("Supabase is not configured");
    err.status = 500;
    throw err;
  }

  let prefRow = null;
  try {
    prefRow = await fetchNotificationPreferenceRow(supabaseAdmin, userId);
  } catch (error) {
    if (!isMissingNotificationPreferencesTable(error)) throw error;
  }

  const prefs = normalizeNotificationPreferences(prefRow, userId);
  const cadence = normalizeReminderFrequency(prefs.reminder_frequency);
  let intent = null;
  try {
    intent = await findNextManualFirstIntent(supabaseAdmin, userId);
  } catch (error) {
    intent = null;
  }

  const amount = intent ? getAmountFromIntent(intent, getIntentAmount) : null;
  const lastEmailMs = await fetchLastAutoReminderSentAtForUserChannel(supabaseAdmin, userId, "email");
  const lastAnyMs = await fetchLastAutoReminderSentAtForUserAny(supabaseAdmin, userId);
  const gapMs = minUserWideGapMs(cadence);
  const cooldownActive =
    lastAnyMs != null && Number.isFinite(gapMs) && now.getTime() - lastAnyMs < gapMs;
  const nextAllowedMs =
    lastAnyMs != null && Number.isFinite(gapMs) ? lastAnyMs + gapMs : null;

  let reason = null;
  if (!prefRow) reason = "no_preferences";
  else if (cadence === "off") reason = "frequency_off";
  else if (!prefs.email_enabled) reason = "email_not_enabled";
  else if (!prefs.consent_email_at) reason = "email_consent_missing";
  else if (!isTuesdayFridayReminderDay(now, prefs.timezone || "UTC")) reason = "outside_tuesday_friday_schedule";
  else if (!isWithinReminderTimeWindow(prefs, now)) reason = "outside_reminder_time_window";
  else if (!intent?.id) reason = "no_next_manual_first_intent";
  else if (!Number.isFinite(amount) || amount <= 0) reason = "next_intent_invalid_amount";
  else if (cooldownActive) reason = "cooldown_active";
  else if (!isProviderConfigured("email", env)) reason = "email_provider_not_configured";

  return {
    ok: true,
    has_preferences: !!prefRow,
    email_enabled: !!prefs.email_enabled,
    has_email_consent: !!prefs.consent_email_at,
    preferred_channel: prefs.preferred_channel,
    frequency: cadence,
    preferred_language: prefs.preferred_language,
    has_next_intent: !!intent?.id,
    next_intent_status: intent?.status || null,
    next_intent_amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    last_email_event_at: isoFromMs(lastEmailMs),
    cooldown_active: !!cooldownActive,
    next_allowed_at: cooldownActive ? isoFromMs(nextAllowedMs) : null,
    reason_if_not_eligible: reason
  };
}

/**
 * Procesa recordatorios automaticos para filas de notification_preferences.
 * Requiere tablas SQL V96/V97 y proveedores email/SMS configurados para enviar.
 * @param {object} deps
 * @param {boolean} [deps.forceTest] Si true (?forceTest=1 en cron): ignora cooldown y ventana horaria esta ejecucion; solo email; exige consent_email_at.
 * @param {function} [deps.sendReminderFn] Solo tests: sustituye sendReminder.
 */
async function runDuePaymentReminders(deps) {
  const {
    supabaseAdmin,
    getIntentAmount,
    env = process.env,
    http = axios,
    now = new Date(),
    forceTest = false,
    sendReminderFn
  } = deps || {};
  const doSendReminder = typeof sendReminderFn === "function" ? sendReminderFn : sendReminder;
  if (!supabaseAdmin) {
    return { ok: false, error: "Supabase is not configured" };
  }

  const summary = {
    scanned: 0,
    eligible: 0,
    sent: 0,
    skipped: 0,
    reason_counts: {},
    errors: [],
    ...(forceTest ? { force_test: true } : {})
  };

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
      incrementReminderReason(summary, "frequency_off");
      continue;
    }
    if (!prefs.email_enabled && !prefs.sms_enabled) {
      incrementReminderReason(summary, "no_channels_enabled");
      continue;
    }
    if (forceTest) {
      if (!prefs.email_enabled || !prefs.consent_email_at) {
        incrementReminderReason(summary, "force_email_not_consented");
        continue;
      }
    } else if (!isTuesdayFridayReminderDay(now, prefs.timezone || "UTC")) {
      incrementReminderReason(summary, "outside_tuesday_friday_schedule");
      continue;
    } else if (!isWithinReminderTimeWindow(prefs, now)) {
      incrementReminderReason(summary, "outside_reminder_time_window");
      continue;
    }

    let intent;
    try {
      intent = await findNextManualFirstIntent(supabaseAdmin, prefs.user_id);
    } catch (e) {
      summary.errors.push(
        cronErrorSummary({
          userId: prefs.user_id,
          step: "intent",
          reason: "notification_lookup_failed",
          error: e
        })
      );
      continue;
    }
    if (!intent?.id) {
      incrementReminderReason(summary, "no_next_manual_first_intent");
      continue;
    }

    if (!forceTest) {
      const userGapMs = minUserWideGapMs(cadence);
      try {
        const userLastAny = await fetchLastAutoReminderSentAtForUserAny(supabaseAdmin, prefs.user_id);
        if (userLastAny != null && now.getTime() - userLastAny < userGapMs) {
          incrementReminderReason(summary, "cooldown_active");
          continue;
        }
      } catch (e) {
        summary.errors.push(
          cronErrorSummary({
            userId: prefs.user_id,
            step: "user_last_event",
            reason: "notification_lookup_failed",
            error: e
          })
        );
        continue;
      }
    }

    const channels = [];
    if (prefs.email_enabled) channels.push("email");
    if (!forceTest && prefs.sms_enabled) channels.push("sms");

    let cachedEmail = null;
    for (const channel of channels) {
      if (!isProviderConfigured(channel, env)) {
        incrementReminderReason(summary, `${channel}_provider_not_configured`);
        continue;
      }

      try {
        const preview = await buildNextPaymentReminderPreview({
          supabaseAdmin,
          userId: prefs.user_id,
          channel,
          getIntentAmount,
          preferredLanguage: prefs.preferred_language
        });

        let to = null;
        if (channel === "email") {
          if (!prefs.consent_email_at) {
            incrementReminderReason(summary, "email_consent_missing");
            continue;
          }
          cachedEmail = cachedEmail || (await fetchAuthUserEmail(supabaseAdmin, prefs.user_id));
          to = cachedEmail;
        } else {
          if (!prefs.phone_number || !prefs.consent_sms_at) {
            incrementReminderReason(summary, "sms_consent_or_phone_missing");
            continue;
          }
          to = prefs.phone_number;
        }
        if (!to) {
          incrementReminderReason(summary, `${channel}_recipient_missing`);
          continue;
        }

        summary.eligible += 1;
        const sendResult = await doSendReminder({ channel, to, preview, env, http });
        if (sendResult.sent) {
          await insertAutoReminderEvent(supabaseAdmin, {
            user_id: prefs.user_id,
            intent_id: intent.id,
            channel,
            preview,
            metadata: forceTest ? { force_test: true } : undefined
          });
          summary.sent += 1;
          break;
        }
        incrementReminderReason(summary, "provider_returned_not_sent");
      } catch (e) {
        summary.errors.push(
          cronErrorSummary({
            userId: prefs.user_id,
            channel,
            reason: "provider_send_failed",
            error: e
          })
        );
      }
    }
  }

  return { ok: true, ...summary };
}

/** @deprecated use runDuePaymentReminders */
async function sendDuePaymentReminders(deps) {
  return runDuePaymentReminders(deps);
}

const PAID_BALANCE_THRESHOLD_TX = 0.01;

function formatMoneyTransactionalEmail(amount, lang) {
  const n = Math.round((safeNumber(amount) + Number.EPSILON) * 100) / 100;
  try {
    return new Intl.NumberFormat(lang === "es" ? "es-MX" : "en-US", {
      style: "currency",
      currency: "USD"
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function buildPaymentRecordedTransactionalCopy(lang, amount, debtNameRaw) {
  const name = visibleDebtName(debtNameRaw);
  const amt = formatMoneyTransactionalEmail(amount, lang);
  if (lang === "es") {
    return {
      subject: "¡Pago registrado en DebtYa!",
      body: `¡Buen trabajo! Registramos tu pago de ${amt} hacia ${name}.\nTu progreso fue actualizado en DebtYa.\n\nRecuerda: DebtYa no mueve dinero ni ejecuta pagos. Tú hiciste el pago fuera de DebtYa y nosotros actualizamos tu progreso.`
    };
  }
  return {
    subject: "Payment recorded in DebtYa!",
    body: `Great job! We recorded your ${amt} payment toward ${name}.\nYour progress was updated in DebtYa.\n\nReminder: DebtYa does not move money or make payments. You made the payment outside DebtYa and we updated your progress.`
  };
}

function buildDebtPaidOffTransactionalCopy(lang, debtNameRaw) {
  const name = visibleDebtName(debtNameRaw);
  if (lang === "es") {
    return {
      subject: "¡Felicidades! Pagaste una deuda completa 🎉",
      body: `¡Excelente trabajo! ${name} aparece como pagada en DebtYa.\nEsto es un gran avance en tu plan para salir de deudas.\nLa movimos a Deudas pagadas y recalculamos tu próximo paso.`
    };
  }
  return {
    subject: "Congrats! You paid off a debt 🎉",
    body: `Great work! ${name} now shows as paid off in DebtYa.\nThis is a major step forward in your debt payoff plan.\nWe moved it to Paid debts and recalculated your next step.`
  };
}

/**
 * Transactional emails after a manual payment is recorded (never throws).
 * Dedupes via intent metadata keys payment_recorded_email_sent_at / debt_paid_celebration_email_sent_at.
 */
async function sendTransactionalPaymentCelebrationEmails(deps) {
  const {
    supabaseAdmin,
    userId,
    userEmail,
    intentId,
    amount,
    debtNameDisplay,
    previousBalance,
    nextBalance,
    previousDebtStatus,
    preferredLanguageHint,
    env = process.env,
    http = axios,
    mergeIntentMetadata,
    appError,
    sendEmailFn
  } = deps;

  const sendMail =
    typeof sendEmailFn === "function" ? sendEmailFn : (opts) => sendEmailReminder({ ...opts, env, http });

  const logErr =
    typeof appError === "function"
      ? (...args) => {
          try {
            appError(...args);
          } catch (_) {}
        }
      : () => {};

  const out = { ok: true, skipped: false, payment_email: false, celebration: false };

  if (!userEmail || !String(userEmail).includes("@")) {
    out.skipped = true;
    out.reason = "no_user_email";
    return out;
  }
  if (!isProviderConfigured("email", env)) {
    out.skipped = true;
    out.reason = "email_provider_not_configured";
    return out;
  }
  if (!intentId || !supabaseAdmin || typeof mergeIntentMetadata !== "function") {
    out.skipped = true;
    out.reason = "missing_deps";
    return out;
  }

  let prefs = defaultNotificationPreferences(userId);
  try {
    prefs = await fetchNotificationPreferences(supabaseAdmin, userId);
  } catch (e) {
    logErr("fetchNotificationPreferences (transactional):", e);
  }
  const prefsLang = prefs.preferred_language === "es" ? "es" : "en";
  const hintRaw = preferredLanguageHint;
  const lang =
    hintRaw != null && String(hintRaw).trim() !== ""
      ? normalizePreferredLanguage(hintRaw)
      : prefsLang;

  const { data: intentRow, error: loadMetaErr } = await supabaseAdmin
    .from("payment_intents")
    .select("metadata")
    .eq("id", intentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (loadMetaErr || !intentRow) {
    out.ok = false;
    out.reason = "intent_load_failed";
    return out;
  }

  const meta0 = parseMetadata(intentRow.metadata);
  if (meta0.payment_recorded_email_sent_at) {
    out.skipped = true;
    out.reason = "payment_email_already_sent";
    return out;
  }

  const prevPaid =
    String(previousDebtStatus || "").toLowerCase() === "paid" &&
    safeNumber(previousBalance) <= PAID_BALANCE_THRESHOLD_TX;
  const nextPaid = safeNumber(nextBalance) <= PAID_BALANCE_THRESHOLD_TX;

  if (prevPaid && nextPaid) {
    out.skipped = true;
    out.reason = "already_fully_paid_noop";
    return out;
  }

  const payCopy = buildPaymentRecordedTransactionalCopy(lang, amount, debtNameDisplay);
  try {
    await sendMail({
      to: userEmail,
      preview: { subject: payCopy.subject, email_body: payCopy.body },
      env,
      http
    });
    out.payment_email = true;
  } catch (e) {
    logErr("transactional payment-recorded email failed:", e);
    out.payment_email_error = e && e.message ? String(e.message) : String(e);
    return out;
  }

  try {
    await mergeIntentMetadata({ payment_recorded_email_sent_at: new Date().toISOString() });
  } catch (e) {
    logErr("mergeIntentMetadata after payment-recorded email:", e);
  }

  if (!nextPaid) {
    return out;
  }

  const { data: intentRow2 } = await supabaseAdmin
    .from("payment_intents")
    .select("metadata")
    .eq("id", intentId)
    .eq("user_id", userId)
    .maybeSingle();
  const meta1 = parseMetadata(intentRow2?.metadata);
  if (meta1.debt_paid_celebration_email_sent_at) {
    return out;
  }

  const celCopy = buildDebtPaidOffTransactionalCopy(lang, debtNameDisplay);
  try {
    await sendMail({
      to: userEmail,
      preview: { subject: celCopy.subject, email_body: celCopy.body },
      env,
      http
    });
    out.celebration = true;
  } catch (e) {
    logErr("transactional debt-paid celebration email failed:", e);
    out.celebration_error = e && e.message ? String(e.message) : String(e);
    return out;
  }

  try {
    await mergeIntentMetadata({ debt_paid_celebration_email_sent_at: new Date().toISOString() });
  } catch (e) {
    logErr("mergeIntentMetadata after celebration email:", e);
  }

  return out;
}

module.exports = {
  VALID_CHANNELS,
  VALID_REMINDER_FREQUENCIES,
  defaultNotificationPreferences,
  normalizePreferredLanguage,
  parsePreferredLanguageHintFromHttp,
  normalizeNotificationPreferences,
  validateNotificationPreferencesInput,
  fetchNotificationPreferences,
  buildReminderDebugState,
  buildNextPaymentReminderPreview,
  isProviderConfigured,
  providerState,
  sendReminder,
  runDuePaymentReminders,
  sendDuePaymentReminders,
  normalizePhoneNumber,
  normalizeReminderFrequency,
  minGapMsForCadence,
  minUserWideGapMs,
  isTuesdayFridayReminderDay,
  isWithinReminderTimeWindow,
  resolveDebtYaReminderFromAddress,
  canSendSmsRemindersLive,
  resolveNotificationEventMessage,
  NOTIFICATION_EVENT_MESSAGE_FALLBACK,
  sendEmailReminder,
  visibleDebtName,
  buildPaymentRecordedTransactionalCopy,
  buildDebtPaidOffTransactionalCopy,
  sendTransactionalPaymentCelebrationEmails
};
