const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SEND_BY_EMAIL = new Map();
const SEND_BY_IP = new Map();
const VERIFY_BY_EMAIL = new Map();
const LOGIN_VERIFY_BY_EMAIL = new Map();
const PW_RESET_BY_EMAIL = new Map();
const PW_RESET_BY_IP = new Map();

const SEND_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const SEND_EMAIL_MAX = 3;
const SEND_IP_WINDOW_MS = 60 * 60 * 1000;
const SEND_IP_MAX = 20;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX = 12;
const CODE_TTL_MS = 15 * 60 * 1000;

function bumpRate(map, key, windowMs, max) {
  const now = Date.now();
  let row = map.get(key);
  if (!row || now - row.start > windowMs) {
    row = { start: now, n: 0 };
  }
  row.n += 1;
  map.set(key, row);
  return row.n <= max;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function isValidEmailShape(email) {
  const s = normalizeEmail(email);
  if (s.length < 5 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function signupPasswordMeetsPolicy(pw) {
  if (typeof pw !== "string" || pw.length < 8) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}

function randomSixDigitCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

/** Lee Resend en cada petición (evita valores vacíos “congelados” al arranque) y recorta espacios. */
function readResendEnv() {
  const apiKey = String(process.env.RESEND_API_KEY ?? "").trim();
  const fromEmail = String(process.env.RESEND_FROM_EMAIL ?? "").trim();
  return { apiKey, fromEmail };
}

async function sendResendEmail({ to, subject, text, apiKey, fromEmail }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject,
      text
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.message || body?.error || res.statusText || "Resend error";
    throw new Error(msg);
  }
  return body;
}

/** Comparación en tiempo constante para códigos de 6 dígitos almacenados en texto. */
function codesEqualTimingSafe(stored, submitted) {
  const a = String(stored || "").trim();
  const b = String(submitted || "").trim();
  if (a.length !== 6 || b.length !== 6) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function logSupabaseErr(scope, err) {
  if (!err || typeof err !== "object") {
    return String(err);
  }
  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint
  };
}

/** Idioma UI: el cliente envía `lang: "en" | "es"`; si falta, se infiere de Accept-Language; por defecto en. */
function resolveAuthLang(body, req) {
  const raw = String(body?.lang ?? "")
    .trim()
    .toLowerCase();
  if (raw === "es" || raw.startsWith("es")) return "es";
  if (raw === "en" || raw.startsWith("en")) return "en";
  const accept = String(req?.headers?.["accept-language"] || "").toLowerCase();
  if (accept.includes("es")) return "es";
  return "en";
}

function tAuth(lang, key) {
  const pack = lang === "es" ? AUTH_I18N.es : AUTH_I18N.en;
  return pack[key] ?? AUTH_I18N.en[key] ?? key;
}

const AUTH_I18N = {
  en: {
    err_supabase_not_configured: "Supabase is not configured.",
    err_supabase_anon_not_configured: "Supabase anon client is not configured.",
    err_resend_not_configured: "Email sending is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL).",
    err_invalid_email: "Invalid email address.",
    err_password_required: "Password is required.",
    err_rate_email: "Too many codes for this email. Wait a bit and try again.",
    err_rate_ip: "Too many requests. Try again later.",
    err_code_save_failed: "Could not save the code. Check the signup_verification_codes table in Supabase.",
    err_mail_send_failed: "Could not send the email. Try again in a few minutes.",
    err_generic_send_code: "Error sending the code.",
    msg_signup_code_sent: "If the email is valid, you will receive a code shortly.",
    err_bad_credentials: "Incorrect email or password.",
    msg_login_code_sent: "If your email and password are correct, you will receive a code shortly.",
    err_code_digits: "The code must be 6 digits.",
    err_too_many_verify: "Too many attempts. Request a new code.",
    err_verify_db: "Error verifying the code.",
    err_code_bad_or_expired: "Incorrect or expired code. Request a new one.",
    err_login_session: "Error signing in.",
    err_password_policy: "The password does not meet the minimum requirements.",
    err_email_registered: "That email is already registered. Sign in.",
    err_create_account_generic: "Could not create the account.",
    err_complete_signup: "Error completing registration.",
    signup_email_subject: "Your DebtYa verification code",
    signup_email_body: (code) =>
      `Your DebtYa verification code is: ${code}\n\nIt is valid for 15 minutes. If you did not request an account, ignore this message.`,
    login_email_subject: "Your code to sign in to DebtYa",
    login_email_body: (code) =>
      `Your code to sign in to DebtYa is: ${code}\n\nIt is valid for 15 minutes. If this was not you, change your password.`,
    msg_pw_reset_neutral:
      "If an account exists for this address, you will receive an email with a reset link shortly.",
    pw_reset_email_subject: "Reset your DebtYa password",
    pw_reset_email_body: (link) =>
      `Tap the link below to set a new password. It expires in about an hour.\n\n${link}\n\nOn the next page, press "Continue to reset password" once (this avoids email scanners breaking the link).\n\nIf you did not request this, you can ignore this email.`
  },
  es: {
    err_supabase_not_configured: "Supabase no configurado",
    err_supabase_anon_not_configured: "Supabase anon no configurado",
    err_resend_not_configured: "Envío de correo no configurado (RESEND_API_KEY / RESEND_FROM_EMAIL).",
    err_invalid_email: "Correo no válido.",
    err_password_required: "Contraseña requerida.",
    err_rate_email: "Demasiados códigos para este correo. Espera un poco e inténtalo de nuevo.",
    err_rate_ip: "Demasiadas solicitudes. Inténtalo más tarde.",
    err_code_save_failed: "No se pudo guardar el código. Revisa la tabla signup_verification_codes en Supabase.",
    err_mail_send_failed: "No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.",
    err_generic_send_code: "Error enviando código.",
    msg_signup_code_sent: "Si el correo es válido, recibirás un código en unos instantes.",
    err_bad_credentials: "Email o contraseña incorrectos.",
    msg_login_code_sent: "Si el correo y la contraseña son correctos, recibirás un código en unos instantes.",
    err_code_digits: "El código debe ser de 6 dígitos.",
    err_too_many_verify: "Demasiados intentos. Solicita un código nuevo.",
    err_verify_db: "Error verificando código.",
    err_code_bad_or_expired: "Código incorrecto o caducado. Solicita uno nuevo.",
    err_login_session: "Error iniciando sesión.",
    err_password_policy: "La contraseña no cumple los requisitos mínimos.",
    err_email_registered: "Ese correo ya está registrado. Inicia sesión.",
    err_create_account_generic: "No se pudo crear la cuenta.",
    err_complete_signup: "Error completando el registro.",
    signup_email_subject: "Tu código de verificación DebtYa",
    signup_email_body: (code) =>
      `Tu código de verificación DebtYa es: ${code}\n\nVálido durante 15 minutos. Si no solicitaste registrarte, ignora este mensaje.`,
    login_email_subject: "Tu código para iniciar sesión en DebtYa",
    login_email_body: (code) =>
      `Tu código para iniciar sesión en DebtYa es: ${code}\n\nVálido durante 15 minutos. Si no fuiste tú, cambia tu contraseña.`,
    msg_pw_reset_neutral:
      "Si existe una cuenta con este correo, recibirás un enlace para restablecer la contraseña en unos instantes.",
    pw_reset_email_subject: "Restablece tu contraseña de DebtYa",
    pw_reset_email_body: (link) =>
      `Usa el enlace de abajo para elegir una nueva contraseña. Caduca en aproximadamente una hora.\n\n${link}\n\nEn la siguiente pantalla, pulsa una vez el boton azul "Continue to reset password" (así los bots de seguridad del correo no rompen el enlace).\n\nSi no lo pediste, ignora este mensaje.`
  }
};

/** Cliente anon nuevo por petición (evita contaminar sesión entre requests en el singleton del servidor). */
function createFreshAnonAuthClient(deps) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = deps;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** URL post-reset: FRONTEND_URL > APP_BASE_URL > host de la petición > debtya.com (debe estar en Redirect URLs de Supabase). */
function resolvePasswordResetRedirect(deps, req) {
  const fe = String(deps.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  const app = String(deps.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  let base = fe || app;
  if (!base && typeof deps.getBaseUrl === "function") {
    try {
      base = String(deps.getBaseUrl(req) || "").trim().replace(/\/+$/, "");
    } catch (_) {
      base = "";
    }
  }
  const b = base || "https://www.debtya.com";
  return `${b}/`;
}

/** Base pública del clic en el correo (API). Opcional: PASSWORD_RESET_LINK_BASE. */
function resolveRecoverClickBase(deps, req) {
  const explicit = String(process.env.PASSWORD_RESET_LINK_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;
  const app = String(deps.APP_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (app) return app;
  try {
    return String(deps.getBaseUrl(req) || "")
      .trim()
      .replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

function htmlRecoverLinkInvalid() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.5}a{color:#2563eb}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Reset link invalid or expired</h1><p>Request a new reset from the DebtYa sign-in screen.</p><p><a href="/">Continue to DebtYa</a></p></body></html>`;
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlRecoverConfirmForm(token) {
  const safe = escapeHtmlAttr(token);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa — password reset</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.5}button{font:inherit;padding:0.65rem 1.1rem;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer}button:hover{background:#1d4ed8}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Reset your password</h1><p>Confirm to open the secure DebtYa reset page. (This step avoids broken links from email scanners.)</p><form method="post" action="/auth/recover"><input type="hidden" name="t" value="${safe}" /><p><button type="submit">Continue to reset password</button></p></form><p style="font-size:0.9rem;color:#555"><a href="/">Back to DebtYa</a></p></body></html>`;
}

async function fetchPasswordResetRow(supabaseAdmin, token) {
  const nowIso = new Date().toISOString();
  const { data: rows, error: selErr } = await supabaseAdmin
    .from("password_reset_shortlinks")
    .select("target_url")
    .eq("token", token)
    .gt("expires_at", nowIso)
    .limit(1);
  return { row: rows && rows[0], selErr };
}

function registerAuthSignupRoutes(app, deps) {
  const { supabaseAdmin, jsonError, appError } = deps;

  /** GET: solo muestra confirmación; el enlace real se consume en POST (evita bots de correo que vacían el token). */
  app.get("/auth/recover", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      const token = String(req.query.t || "").trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        return res.status(400).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!supabaseAdmin) {
        return res.status(500).type("text/plain").send("Server misconfiguration.");
      }
      const { row, selErr } = await fetchPasswordResetRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/recover GET] select", logSupabaseErr("select", selErr));
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!row?.target_url) {
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      return res.status(200).type("text/html; charset=utf-8").send(htmlRecoverConfirmForm(token));
    } catch (e) {
      appError("[auth/recover GET]", e);
      return res.status(500).type("text/plain").send("Error.");
    }
  });

  app.post("/auth/recover", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      const token = String(req.body?.t || "").trim();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        return res.status(400).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!supabaseAdmin) {
        return res.status(500).type("text/plain").send("Server misconfiguration.");
      }
      const { row, selErr } = await fetchPasswordResetRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/recover POST] select", logSupabaseErr("select", selErr));
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!row?.target_url) {
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      await supabaseAdmin.from("password_reset_shortlinks").delete().eq("token", token);
      return res.redirect(302, row.target_url);
    } catch (e) {
      appError("[auth/recover POST]", e);
      return res.status(500).type("text/plain").send("Error.");
    }
  });

  app.post("/auth/password-reset/request", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    const neutralJson = () => res.json({ ok: true, message: tAuth(lang, "msg_pw_reset_neutral") });

    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        appError("[auth/password-reset] Resend env ausente o vacio (tras trim)", {
          RESEND_API_KEY_len: RESEND_API_KEY.length,
          RESEND_FROM_EMAIL_len: RESEND_FROM_EMAIL.length
        });
        return jsonError(res, 503, tAuth(lang, "err_resend_not_configured"));
      }

      const email = normalizeEmail(req.body?.email);
      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, tAuth(lang, "err_invalid_email"));
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      if (!bumpRate(PW_RESET_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_email"));
      }
      if (!bumpRate(PW_RESET_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_ip"));
      }

      const redirectTo = resolvePasswordResetRedirect(deps, req);

      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo }
      });

      if (linkErr || !linkData?.properties) {
        appError(
          "[auth/password-reset] generateLink fallo",
          linkErr ? logSupabaseErr("generateLink", linkErr) : "sin properties"
        );
        return neutralJson();
      }

      const props = linkData.properties || {};
      const actionLink = props.action_link || props.actionLink || "";
      if (!actionLink) {
        appError("[auth/password-reset] sin action_link", { keys: Object.keys(props) });
        return neutralJson();
      }

      const clickBase = resolveRecoverClickBase(deps, req);
      const shortToken = crypto.randomBytes(18).toString("base64url");
      const shortExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      let linkForEmail = actionLink;
      if (clickBase) {
        const { error: shortErr } = await supabaseAdmin.from("password_reset_shortlinks").insert({
          token: shortToken,
          target_url: actionLink,
          expires_at: shortExpires
        });
        if (!shortErr) {
          linkForEmail = `${clickBase}/auth/recover?t=${encodeURIComponent(shortToken)}`;
        } else {
          appError(
            "[auth/password-reset] shortlink insert (tabla password_reset_shortlinks?)",
            logSupabaseErr("insert shortlink", shortErr)
          );
        }
      }

      try {
        await sendResendEmail({
          to: email,
          subject: tAuth(lang, "pw_reset_email_subject"),
          text: (lang === "es" ? AUTH_I18N.es.pw_reset_email_body : AUTH_I18N.en.pw_reset_email_body)(linkForEmail),
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/password-reset] Resend:", mailErr.message || mailErr);
        return jsonError(res, 502, tAuth(lang, "err_mail_send_failed"));
      }

      return neutralJson();
    } catch (e) {
      appError("[auth/password-reset]", e);
      return jsonError(res, 500, tAuth(lang, "err_generic_send_code"));
    }
  });

  app.post("/auth/signup/send-verification-code", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        appError("[auth/signup/send-code] Resend env ausente o vacio (tras trim)", {
          RESEND_API_KEY_len: RESEND_API_KEY.length,
          RESEND_FROM_EMAIL_len: RESEND_FROM_EMAIL.length,
          has_RESEND_API_KEY: Object.prototype.hasOwnProperty.call(process.env, "RESEND_API_KEY"),
          has_RESEND_FROM_EMAIL: Object.prototype.hasOwnProperty.call(process.env, "RESEND_FROM_EMAIL")
        });
        return jsonError(res, 503, tAuth(lang, "err_resend_not_configured"));
      }

      const emailRaw = req.body?.email;
      const email = normalizeEmail(emailRaw);
      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, tAuth(lang, "err_invalid_email"));
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      if (!bumpRate(SEND_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_email"));
      }
      if (!bumpRate(SEND_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_ip"));
      }

      const code = randomSixDigitCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const { error: insErr } = await supabaseAdmin.from("signup_verification_codes").insert({
        email,
        code,
        expires_at: expiresAt
      });
      if (insErr) {
        appError("[auth/signup/send-code] insert signup_verification_codes failed", logSupabaseErr("insert", insErr));
        return jsonError(res, 500, tAuth(lang, "err_code_save_failed"));
      }

      try {
        await sendResendEmail({
          to: email,
          subject: tAuth(lang, "signup_email_subject"),
          text: (lang === "es" ? AUTH_I18N.es.signup_email_body : AUTH_I18N.en.signup_email_body)(code),
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/signup/send-code] Resend:", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);
        return jsonError(res, 502, tAuth(lang, "err_mail_send_failed"));
      }

      return res.json({
        ok: true,
        message: tAuth(lang, "msg_signup_code_sent")
      });
    } catch (e) {
      appError("[auth/signup/send-code]", e);
      return jsonError(res, 500, tAuth(lang, "err_generic_send_code"));
    }
  });

  app.post("/auth/login/send-verification-code", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const anonAuth = createFreshAnonAuthClient(deps);
      if (!anonAuth) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_anon_not_configured"));
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        appError("[auth/login/send-code] Resend env ausente o vacio (tras trim)", {
          RESEND_API_KEY_len: RESEND_API_KEY.length,
          RESEND_FROM_EMAIL_len: RESEND_FROM_EMAIL.length,
          has_RESEND_API_KEY: Object.prototype.hasOwnProperty.call(process.env, "RESEND_API_KEY"),
          has_RESEND_FROM_EMAIL: Object.prototype.hasOwnProperty.call(process.env, "RESEND_FROM_EMAIL")
        });
        return jsonError(res, 503, tAuth(lang, "err_resend_not_configured"));
      }

      const emailRaw = req.body?.email;
      const email = normalizeEmail(emailRaw);
      const password = String(req.body?.password || "");
      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, tAuth(lang, "err_invalid_email"));
      }
      if (!password) {
        return jsonError(res, 400, tAuth(lang, "err_password_required"));
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      const { data: signData, error: signErr } = await anonAuth.auth.signInWithPassword({ email, password });
      if (signErr || !signData?.session) {
        appError("[auth/login/send-code] signInWithPassword fallo", signErr?.message || signErr || "sin session");
        return jsonError(res, 401, tAuth(lang, "err_bad_credentials"));
      }

      if (!bumpRate(SEND_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_email"));
      }
      if (!bumpRate(SEND_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_ip"));
      }

      const code = randomSixDigitCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const { error: insErr } = await supabaseAdmin.from("signup_verification_codes").insert({
        email,
        code,
        expires_at: expiresAt
      });
      if (insErr) {
        appError("[auth/login/send-code] insert signup_verification_codes failed", logSupabaseErr("insert", insErr));
        return jsonError(res, 500, tAuth(lang, "err_code_save_failed"));
      }

      try {
        await sendResendEmail({
          to: email,
          subject: tAuth(lang, "login_email_subject"),
          text: (lang === "es" ? AUTH_I18N.es.login_email_body : AUTH_I18N.en.login_email_body)(code),
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/login/send-code] Resend:", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);
        return jsonError(res, 502, tAuth(lang, "err_mail_send_failed"));
      }

      return res.json({
        ok: true,
        message: tAuth(lang, "msg_login_code_sent")
      });
    } catch (e) {
      appError("[auth/login/send-code]", e);
      return jsonError(res, 500, tAuth(lang, "err_generic_send_code"));
    }
  });

  app.post("/auth/login/complete", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, tAuth(lang, "err_invalid_email"));
      }
      if (!password) {
        return jsonError(res, 400, tAuth(lang, "err_password_required"));
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_digits"));
      }

      if (!bumpRate(LOGIN_VERIFY_BY_EMAIL, email, VERIFY_WINDOW_MS, VERIFY_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_too_many_verify"));
      }

      const nowIso = new Date().toISOString();
      const { data: rows, error: selErr } = await supabaseAdmin
        .from("signup_verification_codes")
        .select("id, code, expires_at")
        .eq("email", email)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1);

      if (selErr) {
        appError("[auth/login/complete] select signup_verification_codes failed", logSupabaseErr("select", selErr));
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      const row = rows && rows[0];
      if (!row?.code) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      if (!codesEqualTimingSafe(row.code, code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const anonAuth = createFreshAnonAuthClient(deps);
      if (!anonAuth) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_anon_not_configured"));
      }

      const { data: signData, error: signErr } = await anonAuth.auth.signInWithPassword({ email, password });
      if (signErr || !signData?.session) {
        appError("[auth/login/complete] signInWithPassword fallo", signErr?.message || signErr || "sin session");
        return jsonError(res, 401, tAuth(lang, "err_bad_credentials"));
      }

      const s = signData.session;
      return res.json({
        ok: true,
        session: {
          access_token: s.access_token,
          refresh_token: s.refresh_token,
          expires_in: s.expires_in,
          expires_at: s.expires_at,
          token_type: s.token_type,
          user: s.user
        }
      });
    } catch (e) {
      appError("[auth/login/complete]", e);
      return jsonError(res, 500, tAuth(lang, "err_login_session"));
    }
  });

  app.post("/auth/signup/complete", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }

      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, tAuth(lang, "err_invalid_email"));
      }
      if (!signupPasswordMeetsPolicy(password)) {
        return jsonError(res, 400, tAuth(lang, "err_password_policy"));
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_digits"));
      }

      if (!bumpRate(VERIFY_BY_EMAIL, email, VERIFY_WINDOW_MS, VERIFY_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_too_many_verify"));
      }

      const nowIso = new Date().toISOString();
      const { data: rows, error: selErr } = await supabaseAdmin
        .from("signup_verification_codes")
        .select("id, code, expires_at")
        .eq("email", email)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1);

      if (selErr) {
        appError("[auth/signup/complete] select signup_verification_codes failed", logSupabaseErr("select", selErr));
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      const row = rows && rows[0];
      if (!row?.code) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      if (!codesEqualTimingSafe(row.code, code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });

      if (createErr) {
        const msg = String(createErr.message || "");
        if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("registered")) {
          return jsonError(res, 409, tAuth(lang, "err_email_registered"));
        }
        appError("[auth/signup/complete] createUser:", createErr);
        return jsonError(res, 400, msg || tAuth(lang, "err_create_account_generic"));
      }

      return res.json({
        ok: true,
        user_id: created?.user?.id || null
      });
    } catch (e) {
      appError("[auth/signup/complete]", e);
      return jsonError(res, 500, tAuth(lang, "err_complete_signup"));
    }
  });
}

module.exports = { registerAuthSignupRoutes };
