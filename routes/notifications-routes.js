const {
  VALID_CHANNELS,
  buildNextPaymentReminderPreview,
  fetchNotificationPreferences,
  isProviderConfigured,
  normalizeNotificationPreferences,
  sendReminder,
  validateNotificationPreferencesInput
} = require("../lib/notifications");

function inferLang(req) {
  const b = String(req.body?.lang || "").trim().toLowerCase();
  if (b === "es" || b === "en") return b;
  const al = String(req.headers["accept-language"] || "").toLowerCase();
  if (al.startsWith("es")) return "es";
  return "en";
}

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
  const { requireUser, supabaseAdmin, jsonError, getIntentAmount, appError } = deps;

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
        lang: inferLang(req)
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
      const missingProvider = channels.some((channel) => !isProviderConfigured(channel, process.env));
      for (const channel of channels) {
        assertChannelOptIn(channel, prefs, req.user);
        previews.push(
          await buildNextPaymentReminderPreview({
            supabaseAdmin,
            userId: req.user.id,
            channel,
            getIntentAmount,
            lang: inferLang(req)
          })
        );
      }

      if (missingProvider) {
        return res.json({
          ok: true,
          sent: false,
          warning: "Notification provider is not configured; returning preview only.",
          preview: previews[0],
          previews
        });
      }

      const results = [];
      for (const preview of previews) {
        const to = assertChannelOptIn(preview.channel, prefs, req.user);
        results.push(await sendReminder({ channel: preview.channel, to, preview }));
      }
      return res.json({
        ok: true,
        sent: results.some((r) => r.sent),
        preview: previews[0],
        previews,
        results
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      const clientMsg = status >= 400 && status < 500 && error.message ? error.message : "Could not send test reminder";
      if (appError) appError("[notifications/send-test]", error.message);
      return jsonError(res, status, clientMsg, status >= 500 ? { details: error.message } : {});
    }
  });
}

module.exports = { registerNotificationRoutes };
