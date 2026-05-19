const axios = require("axios");
const {
  VALID_CHANNELS,
  buildNextPaymentReminderPreview,
  buildReminderDebugState,
  fetchNotificationPreferences,
  isProviderConfigured,
  normalizeNotificationPreferences,
  runDuePaymentReminders,
  sendReminder,
  validateNotificationPreferencesInput
} = require("../lib/notifications");

function choosePreviewChannel(reqBody, prefs) {
  const requested = String(reqBody?.channel || "").trim().toLowerCase();
  if (requested === "email" || requested === "sms") return requested;
  if (prefs?.preferred_channel === "sms") return "sms";
  return "email";
}

function channelsForSend(reqBody, prefs) {
  const requested = String(reqBody?.channel || "").trim().toLowerCase();
  if (requested === "email" || requested === "sms") return [requested];
  const preferred = VALID_CHANNELS.has(prefs?.preferred_channel) ? prefs.preferred_channel : "none";
  if (preferred === "both") return ["email", "sms"];
  if (preferred === "email" || preferred === "sms") return [preferred];
  if (prefs?.email_enabled) return ["email"];
  if (prefs?.sms_enabled) return ["sms"];
  return [];
}

function assertChannelOptIn(channel, prefs, user) {
  if (channel === "email") {
    if (!prefs.email_enabled) {
      const err = new Error("Email reminders are not enabled");
      err.status = 400;
      throw err;
    }
    if (!user?.email) {
      const err = new Error("No user email is available for this account");
      err.status = 400;
      throw err;
    }
    return user.email;
  }
  if (channel === "sms") {
    if (!prefs.sms_enabled || !prefs.consent_sms_at) {
      const err = new Error("SMS reminders are not enabled with consent");
      err.status = 400;
      throw err;
    }
    if (!prefs.phone_number) {
      const err = new Error("No SMS phone number is saved");
      err.status = 400;
      throw err;
    }
    return prefs.phone_number;
  }
  const err = new Error("Unsupported notification channel");
  err.status = 400;
  throw err;
}

function isMissingNotificationPreferencesTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "").toLowerCase();
  if (code === "42P01") return true;
  if (msg.includes("notification_preferences") && (msg.includes("does not exist") || msg.includes("schema cache")))
    return true;
  return false;
}

function registerNotificationRoutes(app, deps) {
  const { requireUser, requireCronSecret, supabaseAdmin, jsonError, getIntentAmount, appError, notificationNow } = deps;
  const currentReminderNow = () => {
    if (typeof notificationNow !== "function") return new Date();
    const value = notificationNow();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  };
  if (typeof requireCronSecret !== "function") {
    throw new Error("registerNotificationRoutes requires requireCronSecret in deps");
  }

  app.get("/notifications/preferences", requireUser, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      const data = await fetchNotificationPreferences(supabaseAdmin, req.user.id);
      return res.json({ ok: true, data });
    } catch (error) {
      if (isMissingNotificationPreferencesTable(error)) {
        return res.json({
          ok: true,
          data: normalizeNotificationPreferences(null, req.user.id),
          warning:
            "notification_preferences table is not installed yet. Apply sql/create_notification_preferences.sql in the Supabase SQL editor, then retry."
        });
      }
      return jsonError(res, 500, "Could not load notification preferences", {
        details: error.message
      });
    }
  });

  app.get("/notifications/reminder-debug", requireUser, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      const data = await buildReminderDebugState({
        supabaseAdmin,
        userId: req.user.id,
        getIntentAmount,
        env: process.env,
        now: currentReminderNow()
      });
      return res.json(data);
    } catch (error) {
      if (appError) appError("[notifications/reminder-debug]", "notification_debug_failed");
      return jsonError(res, 500, "Could not build reminder debug", {
        error_code: "notification_debug_failed"
      });
    }
  });

  app.post("/notifications/run-due-reminders", requireCronSecret, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      const forceTest = String(req.query?.forceTest || "").trim() === "1";
      const result = await runDuePaymentReminders({
        supabaseAdmin,
        getIntentAmount,
        env: process.env,
        http: axios,
        forceTest,
        now: currentReminderNow()
      });
      console.log(
        "[notifications/run-due-reminders]",
        JSON.stringify({
          force_test: !!forceTest,
          scanned: result.scanned || 0,
          eligible: result.eligible || 0,
          sent: result.sent || 0,
          skipped: result.skipped || 0,
          failures: Array.isArray(result.errors) ? result.errors.length : 0,
          reason_counts: result.reason_counts || {}
        })
      );
      return res.json(result);
    } catch (error) {
      if (appError) appError("[notifications/run-due-reminders]", "notification_cron_failed");
      return jsonError(res, 500, "Could not run due reminders", { details: "notification_cron_failed" });
    }
  });

  app.post("/notifications/preferences", requireUser, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      let existing = null;
      try {
        existing = await fetchNotificationPreferences(supabaseAdmin, req.user.id);
      } catch (loadErr) {
        if (loadErr?.code && String(loadErr.code) !== "PGRST116") throw loadErr;
      }

      const validation = validateNotificationPreferencesInput(req.body, existing, new Date().toISOString());
      if (validation.error) return jsonError(res, 400, validation.error);

      const payload = {
        user_id: req.user.id,
        ...validation.payload
      };

      const { data, error } = await supabaseAdmin
        .from("notification_preferences")
        .upsert(payload, { onConflict: "user_id" })
        .select("*")
        .single();
      if (error) throw error;
      return res.json({ ok: true, data: normalizeNotificationPreferences(data, req.user.id) });
    } catch (error) {
      if (isMissingNotificationPreferencesTable(error)) {
        return jsonError(
          res,
          503,
          "notification_preferences table is not installed. Apply sql/create_notification_preferences.sql in Supabase, then retry."
        );
      }
      return jsonError(res, 500, "Could not save notification preferences", {
        details: error.message
      });
    }
  });

  app.post("/notifications/preview-next-reminder", requireUser, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      let prefs;
      try {
        prefs = await fetchNotificationPreferences(supabaseAdmin, req.user.id);
      } catch (_) {
        prefs = normalizeNotificationPreferences(null, req.user.id);
      }
      const channel = choosePreviewChannel(req.body, prefs);
      const preview = await buildNextPaymentReminderPreview({
        supabaseAdmin,
        userId: req.user.id,
        channel,
        getIntentAmount,
        preferredLanguage: prefs.preferred_language
      });
      return res.json({ ok: true, preview });
    } catch (error) {
      return jsonError(res, error.status || 500, "Could not build reminder preview", {
        details: error.message
      });
    }
  });

  app.post("/notifications/send-test", requireUser, async (req, res) => {
    try {
      if (!supabaseAdmin) return jsonError(res, 500, "Supabase is not configured");
      let prefs;
      try {
        prefs = await fetchNotificationPreferences(supabaseAdmin, req.user.id);
      } catch (loadErr) {
        if (isMissingNotificationPreferencesTable(loadErr)) {
          return jsonError(
            res,
            503,
            "notification_preferences table is not installed. Apply sql/create_notification_preferences.sql in Supabase, then retry."
          );
        }
        throw loadErr;
      }
      const channels = channelsForSend(req.body, prefs);
      if (!channels.length) return jsonError(res, 400, "No reminder channel is enabled");

      const previews = [];
      const skipReasons = [];
      for (const channel of channels) {
        assertChannelOptIn(channel, prefs, req.user);
        previews.push(
          await buildNextPaymentReminderPreview({
            supabaseAdmin,
            userId: req.user.id,
            channel,
            getIntentAmount,
            preferredLanguage: prefs.preferred_language
          })
        );
      }

      const results = [];
      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];
        const preview = previews[i];
        if (!isProviderConfigured(channel, process.env)) {
          skipReasons.push(
            channel === "sms"
              ? "SMS sending is disabled or not configured yet."
              : "Email provider is not configured; skipped."
          );
          continue;
        }
        const to = assertChannelOptIn(channel, prefs, req.user);
        results.push(await sendReminder({ channel, to, preview, env: process.env }));
      }

      const sent = results.some((r) => r.sent);
      let warning;
      if (!sent && skipReasons.length) {
        warning = ["Notification provider is not configured; returning preview only.", ...skipReasons].join(" ");
      } else if (skipReasons.length) {
        warning = skipReasons.join(" ");
      }

      return res.json({
        ok: true,
        sent,
        ...(warning ? { warning } : {}),
        preview: previews[0],
        previews,
        results
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      const clientMsg = status >= 400 && status < 500 && error.message ? error.message : "Could not send test reminder";
      if (appError) appError("[notifications/send-test]", error.message);
      return jsonError(
        res,
        status,
        clientMsg,
        status >= 500 ? { error_code: "notifications_send_test_failed" } : {}
      );
    }
  });
}

module.exports = { registerNotificationRoutes };
