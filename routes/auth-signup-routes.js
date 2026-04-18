const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SEND_BY_EMAIL = new Map();
const SEND_BY_IP = new Map();
const VERIFY_BY_EMAIL = new Map();
const LOGIN_VERIFY_BY_EMAIL = new Map();
const PW_RESET_BY_EMAIL = new Map();
const PW_RESET_BY_IP = new Map();
const PW_RESET_SESSION_SEND_BY_EMAIL = new Map();
const PW_RESET_SESSION_VERIFY_BY_UID = new Map();
const PW_FINISH_SEND_BY_EMAIL = new Map();
const PW_FINISH_VERIFY_BY_EMAIL = new Map();

const SEND_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const SEND_EMAIL_MAX = 3;
const SEND_IP_WINDOW_MS = 60 * 60 * 1000;
const SEND_IP_MAX = 20;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX = 12;
const CODE_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_SHORTLINK_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_HEX_BYTES = 20;

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
      `Tap the link below to set a new password.\n\n${link}\n\nOn the next page, press "Continue to reset password" once (this avoids email scanners breaking the link). Then choose a new password on DebtYa and confirm with a code we send to this email.\n\nIf you did not request this, you can ignore this email.`,
    pw_reset_session_email_subject: "Your DebtYa password reset code",
    pw_reset_session_email_body: (code) =>
      `Your DebtYa password reset code is: ${code}\n\nIt is valid for 15 minutes. If you did not request a password change, ignore this message and secure your account.`,
    err_pw_reset_session_unauthorized: "Sign in again using the reset link from your email.",
    err_pw_reset_session_update_failed: "Could not update the password. Try again or request a new reset link.",
    err_pw_finish_db: "Password reset storage is not ready. Ask the admin to run sql/create_password_reset_finish.sql in Supabase.",
    err_pw_finish_token: "Invalid or expired reset step. Request a new password reset email."
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
      `Usa el enlace de abajo para elegir una nueva contraseña.\n\n${link}\n\nEn la siguiente pantalla, pulsa una vez el boton azul "Continue to reset password" (así los bots de seguridad del correo no rompen el enlace). Luego elige una nueva contraseña en DebtYa y confirma con un codigo que enviamos a este correo.\n\nSi no lo pediste, ignora este mensaje.`,
    pw_reset_session_email_subject: "Tu codigo para restablecer la contraseña en DebtYa",
    pw_reset_session_email_body: (code) =>
      `Tu codigo para restablecer la contraseña en DebtYa es: ${code}\n\nVálido durante 15 minutos. Si no fuiste tú, ignora este mensaje y protege tu cuenta.`,
    err_pw_reset_session_unauthorized: "Vuelve a entrar con el enlace de restablecimiento que te enviamos por correo.",
    err_pw_reset_session_update_failed: "No se pudo actualizar la contraseña. Inténtalo de nuevo o pide un nuevo enlace.",
    err_pw_finish_db: "Falta configurar el almacenamiento del reset. El admin debe ejecutar sql/create_password_reset_finish.sql en Supabase.",
    err_pw_finish_token: "Este paso no es válido o caducó. Pide un nuevo correo de restablecimiento."
  }
};

/** Cliente anon nuevo por petición (evita contaminar sesión entre requests en el singleton del servidor). */
function createFreshAnonAuthClient(deps) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = deps;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function isLocalhostBase(base) {
  const s = String(base || "").trim().toLowerCase();
  if (!s) return true;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    const h = u.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return /localhost|127\.0\.0\.1/.test(s);
  }
}

function requestAppearsLocal(req) {
  if (!req || typeof req.get !== "function") return false;
  const host = String(req.get("host") || "").toLowerCase();
  if (host === "localhost" || host.startsWith("localhost:")) return true;
  if (host === "127.0.0.1" || host.startsWith("127.0.0.1:")) return true;
  const origin = String(req.get("origin") || "").toLowerCase();
  return origin.includes("localhost") || origin.includes("127.0.0.1");
}

function firstNonLocalhostBase(...candidates) {
  for (const c of candidates) {
    const s = String(c || "").trim().replace(/\/+$/, "");
    if (s && !isLocalhostBase(s)) return s;
  }
  return "";
}

function buildPasswordResetFinishUrl(baseNoTrailing) {
  const s = String(baseNoTrailing || "")
    .trim()
    .replace(/\/+$/, "");
  const root = s || "https://www.debtya.com";
  if (!/^https?:\/\//i.test(root)) {
    return `https://${root.replace(/^\/+/, "")}/password-reset.html`;
  }
  return `${root}/password-reset.html`;
}

/**
 * Si redirect_to apunta al SPA en raíz, lo reescribimos al "good" de resolvePasswordResetRedirect.
 * Importante: NO devolver false solo por llevar password-reset.html: si el host es www/debtya.com
 * (marketing/estático), hay que reescribir para que Supabase redirija al mismo host que la API
 * (p. ej. onrender); si no, el usuario acaba en www/password-reset.html/# sin tokens.
 */
function shouldRewriteRecoveryRedirectToPasswordPage(href) {
  const s = String(href || "").trim();
  if (!s) return true;
  if (isLocalhostBase(s)) return true;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://debtya.invalid${s.startsWith("/") ? "" : "/"}${s}`);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    const h = u.hostname.toLowerCase();
    const marketingHost = h === "www.debtya.com" || h === "debtya.com";
    if (marketingHost && /password-reset\.html/i.test(s)) return true;
    if (/password-reset\.html/i.test(s)) return false;
    return path === "/" || path === "/index.html";
  } catch {
    return false;
  }
}

/**
 * Añade ?debtya_pw_recovery=1 (marca opcional para el HTML dedicado).
 */
function withDebtyaPwRecoveryQuery(href) {
  const raw = String(href || "").trim();
  if (!raw) return "https://www.debtya.com/password-reset.html?debtya_pw_recovery=1";
  const hasProto = /^https?:\/\//i.test(raw);
  try {
    const u = new URL(hasProto ? raw : `https://${raw.replace(/^\/+/, "")}`);
    u.searchParams.set("debtya_pw_recovery", "1");
    return u.toString();
  } catch {
    return raw.includes("debtya_pw_recovery")
      ? raw
      : `${raw.replace(/\/+$/, "")}${raw.includes("?") ? "&" : "?"}debtya_pw_recovery=1`;
  }
}

function readBearerAccessToken(req) {
  const h = String(req.headers?.authorization ?? req.headers?.Authorization ?? "").trim();
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1].trim() : "";
}

function extractUserIdFromGenerateLinkData(linkData) {
  if (!linkData || typeof linkData !== "object") return "";
  const u = linkData.user;
  if (u && typeof u === "object" && u.id) return String(u.id);
  return "";
}

/**
 * UUID del usuario para el flujo API de reset: primero generateLink; si falta, admin users por email o listUsers.
 */
async function resolveAuthUserIdForRecovery(supabaseAdmin, deps, email, linkData) {
  const fromGen = extractUserIdFromGenerateLinkData(linkData);
  if (fromGen) return fromGen;
  const norm = normalizeEmail(email);
  if (!isValidEmailShape(norm)) return "";
  const baseUrl = String(deps.SUPABASE_URL || "").replace(/\/+$/, "");
  const svc = String(deps.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (baseUrl && svc) {
    try {
      const tryUrl = `${baseUrl}/auth/v1/admin/users?email=eq.${encodeURIComponent(norm)}&per_page=1`;
      const res = await fetch(tryUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${svc}`,
          apikey: svc
        }
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const arr = Array.isArray(body.users) ? body.users : null;
        const first = arr && arr[0];
        if (first?.id) return String(first.id);
      }
    } catch (_) {}
  }
  try {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
      if (error || !data?.users) break;
      const hit = data.users.find((u) => normalizeEmail(u.email) === norm);
      if (hit?.id) return String(hit.id);
      if (data.users.length < 100) break;
    }
  } catch (_) {}
  return "";
}

/**
 * URL post-reset (redirect_to de Supabase). En producción ignora FRONTEND_URL/APP_BASE_URL si son localhost
 * (suelen quedar copiados del .env local en Render y rompen el flujo al redirigir al navegador del usuario).
 */
function resolvePasswordResetRedirect(deps, req) {
  const forced = String(process.env.DEBTYA_PASSWORD_RESET_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (forced && !isLocalhostBase(forced) && !requestAppearsLocal(req)) {
    return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(forced));
  }

  const publicApi = String(process.env.DEBTYA_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (publicApi && (!isLocalhostBase(publicApi) || requestAppearsLocal(req))) {
    return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(publicApi));
  }

  const pwLinkBase = String(process.env.PASSWORD_RESET_LINK_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (pwLinkBase && (!isLocalhostBase(pwLinkBase) || requestAppearsLocal(req))) {
    return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(pwLinkBase));
  }

  const fe = String(deps.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  const app = String(deps.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  let fromDeps = "";
  if (typeof deps.getBaseUrl === "function") {
    try {
      fromDeps = String(deps.getBaseUrl(req) || "").trim().replace(/\/+$/, "");
    } catch (_) {}
  }
  const fromForwarded = derivePublicOriginFromRequest(req);

  let base = "";
  if (requestAppearsLocal(req)) {
    base = fe || app || fromForwarded || fromDeps || "http://localhost:3000";
  } else {
    // Host real de la API primero: redirect_to de Supabase no debe ir solo a www (estatico sin el flujo API).
    base =
      firstNonLocalhostBase(
        fromForwarded,
        fe,
        app,
        fromDeps,
        "https://www.debtya.com",
        "https://debtya.com"
      ) || "https://www.debtya.com";
  }
  return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(base));
}

/**
 * redirect_to para enlaces recovery de Supabase: prioriza SIEMPRE origen API conocido
 * (env + Host de esta peticion) antes que FRONTEND_URL/www, para no redirigir al marketing con hash vacio.
 */
function resolveSupabaseRecoveryRedirectStrict(deps, req) {
  const forced = String(process.env.DEBTYA_PASSWORD_RESET_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (forced && !isLocalhostBase(forced) && !requestAppearsLocal(req)) {
    return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(forced));
  }
  let apiRoot = String(echoDebtyaApiBaseForClient(deps, req) || derivePublicOriginFromRequest(req) || "")
    .trim()
    .replace(/\/+$/, "");
  if (!apiRoot && req && !requestAppearsLocal(req)) {
    const host = String(req.get("x-forwarded-host") || req.get("host") || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (host && (host.includes("onrender.com") || host.endsWith(".onrender.com"))) {
      const xf = String(req.get("x-forwarded-proto") || "")
        .split(",")[0]
        .trim();
      const p = xf === "http" || xf === "https" ? xf : String(req.protocol || "https").replace(/:$/, "");
      const proto = p === "http" ? "http" : "https";
      apiRoot = `${proto}://${host}`.replace(/\/+$/, "");
    }
  }
  if (apiRoot && (!isLocalhostBase(apiRoot) || requestAppearsLocal(req))) {
    return withDebtyaPwRecoveryQuery(buildPasswordResetFinishUrl(apiRoot));
  }
  return resolvePasswordResetRedirect(deps, req);
}

function isLikelySupabaseRecoveryVerifyUrl(href) {
  const raw = String(href || "");
  const low = raw.toLowerCase();
  if (low.includes("type=recovery") || low.includes("type%3drecovery")) return true;
  try {
    const u = new URL(raw);
    const t = String(u.searchParams.get("type") || "").toLowerCase();
    if (t === "recovery") return true;
    const h = u.hostname.toLowerCase();
    if (h.endsWith(".supabase.co") && (u.searchParams.has("token") || u.searchParams.has("token_hash"))) return true;
    if (/\/auth\/v1\/verify\b/i.test(u.pathname)) return true;
    if (/\/verify\b/i.test(u.pathname) && (u.searchParams.has("token") || u.searchParams.has("token_hash"))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Fuerza redirect_to en el action_link de Supabase si falta o apunta a localhost.
 * En produccion, en enlaces recovery de verificacion, redirect_to se fija siempre al strict API-first
 * (evita quedar www/password-reset.html/# sin sesion).
 */
function rewriteSupabaseRecoveryActionUrl(targetUrl, deps, req) {
  const raw = String(targetUrl || "");
  if (!raw) return raw;
  const goodStrict = resolveSupabaseRecoveryRedirectStrict(deps, req);
  try {
    const u = new URL(raw);
    if (!isLikelySupabaseRecoveryVerifyUrl(raw)) {
      const good = resolvePasswordResetRedirect(deps, req);
      const cur = u.searchParams.get("redirect_to");
      if (!cur || String(cur).trim() === "") {
        if (!requestAppearsLocal(req)) u.searchParams.set("redirect_to", good);
        return u.toString();
      }
      let dec = cur;
      try {
        dec = decodeURIComponent(cur);
      } catch (_) {}
      if (isLocalhostBase(dec) || isLocalhostBase(cur)) {
        u.searchParams.set("redirect_to", good);
        return u.toString();
      }
      if (
        !requestAppearsLocal(req) &&
        (shouldRewriteRecoveryRedirectToPasswordPage(dec) || shouldRewriteRecoveryRedirectToPasswordPage(cur))
      ) {
        u.searchParams.set("redirect_to", good);
      }
      return u.toString();
    }

    if (requestAppearsLocal(req)) {
      const good = resolvePasswordResetRedirect(deps, req);
      const cur = u.searchParams.get("redirect_to");
      if (!cur || String(cur).trim() === "") {
        u.searchParams.set("redirect_to", good);
        return u.toString();
      }
      let dec = cur;
      try {
        dec = decodeURIComponent(cur);
      } catch (_) {}
      if (isLocalhostBase(dec) || isLocalhostBase(cur)) {
        u.searchParams.set("redirect_to", good);
        return u.toString();
      }
      if (shouldRewriteRecoveryRedirectToPasswordPage(dec) || shouldRewriteRecoveryRedirectToPasswordPage(cur)) {
        u.searchParams.set("redirect_to", good);
      }
      return u.toString();
    }

    u.searchParams.set("redirect_to", goodStrict);
    appError("[auth/recovery] redirect_to fijado (recovery verify, prod)", {
      verify_host: u.hostname,
      redirect_to_len: goodStrict.length
    });
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Origen publico del host que atendio esta peticion (no APP_BASE_URL).
 * getBaseUrl() en server prioriza APP_BASE_URL y oculta el host real de la API.
 */
function derivePublicOriginFromRequest(req) {
  if (!req || typeof req.get !== "function") return "";
  const xfProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const proto =
    xfProto === "https" || xfProto === "http" ? xfProto : String(req.protocol || "https").replace(/:$/, "");
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

/** URL publica de la API para que el cliente guarde DEBTYA_API_BASE (evita www estatico). */
function echoDebtyaApiBaseForClient(deps, req) {
  const a = String(process.env.DEBTYA_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (a && (!isLocalhostBase(a) || requestAppearsLocal(req))) return a;
  const b = String(process.env.PASSWORD_RESET_LINK_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (b && (!isLocalhostBase(b) || requestAppearsLocal(req))) return b;
  const d = derivePublicOriginFromRequest(req);
  return d || "";
}

function setDebtyaApiBaseResponseHeader(res, deps, req) {
  const v = echoDebtyaApiBaseForClient(deps, req);
  if (!v) return;
  try {
    res.setHeader("Debtya-Api-Base", v);
  } catch (_) {}
}

/** Base pública del clic en el correo (API). Opcional: PASSWORD_RESET_LINK_BASE. */
function resolveRecoverClickBase(deps, req) {
  const explicit = String(process.env.PASSWORD_RESET_LINK_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  if (explicit && (!isLocalhostBase(explicit) || requestAppearsLocal(req))) {
    return explicit;
  }

  const publicApi = String(process.env.DEBTYA_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (publicApi && (!isLocalhostBase(publicApi) || requestAppearsLocal(req))) {
    return publicApi;
  }

  const app = String(deps.APP_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const fromForwarded = derivePublicOriginFromRequest(req);
  let fromDeps = "";
  try {
    fromDeps = String(deps.getBaseUrl(req) || "")
      .trim()
      .replace(/\/+$/, "");
  } catch (_) {
    fromDeps = "";
  }

  if (!requestAppearsLocal(req)) {
    // Host real de esta peticion primero: el correo debe apuntar donde corre Node (/auth/recover).
    return (
      firstNonLocalhostBase(
        fromForwarded,
        app,
        fromDeps,
        "https://www.debtya.com",
        "https://debtya.com"
      ) || "https://www.debtya.com"
    );
  }
  if (app) return app;
  return fromDeps || fromForwarded || "";
}

function htmlRecoverLinkInvalid() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.5}a{color:#2563eb}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Reset link invalid or expired</h1><p>Request a new reset from the DebtYa sign-in screen.</p><p><a href="/">Continue to DebtYa</a></p></body></html>`;
}

function htmlRecoverMissingTable() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa — setup</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.55}a{color:#2563eb}code{font-size:0.88rem}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Password reset storage missing</h1><p>The database table for short reset links is not installed (or RLS is blocking the API).</p><p>Ask your admin to run in Supabase SQL Editor:</p><p><code>sql/create_password_reset_shortlinks.sql</code></p><p>and if the table already exists:</p><p><code>sql/disable_rls_password_reset_shortlinks.sql</code></p><p>Then request a <strong>new</strong> reset email.</p><p><a href="/">Back to DebtYa</a></p></body></html>`;
}

function normalizeRecoverTokenParam(raw) {
  if (raw == null) return "";
  const v = Array.isArray(raw) ? raw[0] : raw;
  return String(v).replace(/\s+/g, "").trim();
}

function isRecoverTokenHexFormat(token) {
  return /^[a-fA-F0-9]{40}$/.test(token);
}

function isMissingPasswordResetTable(err) {
  if (!err) return false;
  const msg = String(err.message || "").toLowerCase();
  const code = String(err.code || "");
  if (code === "42P01") return true;
  if (code === "PGRST205") return true;
  if (msg.includes("password_reset_shortlinks") && (msg.includes("does not exist") || msg.includes("not find"))) return true;
  if (msg.includes("schema cache") && msg.includes("password_reset_shortlinks")) return true;
  return false;
}

function absoluteAuthRecoverPostUrl(req) {
  const root = derivePublicOriginFromRequest(req);
  if (!root) return "/auth/recover";
  return `${root}/auth/recover`;
}

function escapeHtmlAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlRecoverConfirmForm(token, postAction) {
  const safe = escapeHtmlAttr(token);
  const action = escapeHtmlAttr(postAction || "/auth/recover");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa — password reset</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.5}button{font:inherit;padding:0.65rem 1.1rem;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer}button:hover{background:#1d4ed8}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Reset your password</h1><p>Confirm to open the secure DebtYa reset page. (This step avoids broken links from email scanners.)</p><form method="post" action="${action}"><input type="hidden" name="t" value="${safe}" /><p><button type="submit">Continue to reset password</button></p></form><p style="font-size:0.9rem;color:#555"><a href="/">Back to DebtYa</a></p></body></html>`;
}

async function fetchPasswordResetRow(supabaseAdmin, token) {
  const nowIso = new Date().toISOString();
  const { data: rows, error: selErr } = await supabaseAdmin
    .from("password_reset_shortlinks")
    .select("target_url, email, user_id")
    .eq("token", token)
    .gt("expires_at", nowIso)
    .limit(1);
  return { row: rows && rows[0], selErr };
}

function isMissingPasswordResetFinishTable(err) {
  if (!err) return false;
  const msg = String(err.message || "").toLowerCase();
  const code = String(err.code || "");
  if (code === "42P01") return true;
  if (code === "PGRST205") return true;
  if (msg.includes("password_reset_finish") && (msg.includes("does not exist") || msg.includes("not find"))) return true;
  if (msg.includes("schema cache") && msg.includes("password_reset_finish")) return true;
  return false;
}

async function fetchPasswordResetFinishRow(supabaseAdmin, token) {
  const nowIso = new Date().toISOString();
  const { data: rows, error: selErr } = await supabaseAdmin
    .from("password_reset_finish")
    .select("email, user_id")
    .eq("token", token)
    .gt("expires_at", nowIso)
    .limit(1);
  return { row: rows && rows[0], selErr };
}

/**
 * Origen publico de ESTA API para redirects (finish reset). No usar resolveRecoverClickBase primero:
 * suele devolver www y entonces /auth/reset-password cae en el marketing (SPA) en vez de Node.
 */
function absolutePublicApiOrigin(deps, req) {
  const d = String(derivePublicOriginFromRequest(req) || "")
    .trim()
    .replace(/\/+$/, "");
  if (d && !isLocalhostBase(d)) return d;
  const e = String(echoDebtyaApiBaseForClient(deps, req) || "")
    .trim()
    .replace(/\/+$/, "");
  if (e && !isLocalhostBase(e)) return e;
  return String(resolveRecoverClickBase(deps, req) || "")
    .trim()
    .replace(/\/+$/, "");
}

function maskEmailForDisplay(email) {
  const e = normalizeEmail(email);
  const at = e.indexOf("@");
  if (at < 2) return e;
  return `${e.slice(0, 2)}…${e.slice(at)}`;
}

function htmlPasswordResetFinishInvalid() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.5}a{color:#2563eb}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">Reset link invalid or expired</h1><p>Request a new reset from the DebtYa sign-in screen.</p><p><a href="/">Continue to DebtYa</a></p></body></html>`;
}

function htmlPasswordResetFinishMissingTable(lang) {
  const isEs = lang === "es";
  const body = isEs
    ? "<p>Falta la tabla <code>password_reset_finish</code> en Supabase. El administrador debe ejecutar <code>sql/create_password_reset_finish.sql</code> y volver a pedir un correo de restablecimiento.</p>"
    : "<p>The <code>password_reset_finish</code> table is missing. Ask your admin to run <code>sql/create_password_reset_finish.sql</code> in Supabase, then request a new reset email.</p>";
  return `<!DOCTYPE html><html lang="${isEs ? "es" : "en"}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>DebtYa</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;color:#111;line-height:1.55}a{color:#2563eb}code{font-size:0.88rem}</style></head><body><h1 style="font-size:1.2rem;font-weight:600">${isEs ? "Configuración incompleta" : "Setup incomplete"}</h1>${body}<p><a href="/">${isEs ? "Volver a DebtYa" : "Back to DebtYa"}</a></p></body></html>`;
}

/** Página servida por la API: nueva contraseña + código sin Supabase en el navegador. */
function htmlPasswordResetFinishPage(apiOrigin, finishToken, lang, emailMasked) {
  const es = lang === "es";
  const title = es ? "Nueva contraseña — DebtYa" : "New password — DebtYa";
  const h1 = es ? "Elige una contraseña nueva" : "Choose a new password";
  const sub = es
    ? "Te enviaremos un código de 6 dígitos a tu correo. Luego guarda la nueva contraseña."
    : "We will email you a 6-digit code. Then save your new password.";
  const lblPw = es ? "Contraseña nueva" : "New password";
  const lblPw2 = es ? "Confirmar" : "Confirm";
  const lblCode = es ? "Código del correo" : "Code from email";
  const btnSend = es ? "Enviar código al correo" : "Email me a code";
  const btnSave = es ? "Guardar contraseña" : "Save password";
  const back = es ? "Volver a DebtYa" : "Back to DebtYa";
  const api = JSON.stringify(apiOrigin || "");
  const tok = JSON.stringify(finishToken || "");
  const lg = JSON.stringify(lang || "en");
  const emJs = JSON.stringify(emailMasked || "");
  return `<!DOCTYPE html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtmlAttr(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#1e293b;border-radius:14px;padding:28px;max-width:420px;width:100%}h1{font-size:1.2rem;margin:0 0 10px;color:#fff}.sub{font-size:0.9rem;color:#94a3b8;line-height:1.45;margin:0 0 14px}label{display:block;font-size:0.82rem;margin:12px 0 6px;color:#cbd5e1}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:1rem}button{width:100%;margin-top:12px;padding:12px;border-radius:8px;border:0;font-weight:600;cursor:pointer;font-size:0.95rem}.btn-p{background:#2563eb;color:#fff}.btn-p:hover{background:#1d4ed8}.btn-l{background:#334155;color:#e2e8f0}.msg{margin-top:14px;padding:10px 12px;border-radius:8px;font-size:0.9rem}.msg.ok{background:#14532d;color:#bbf7d0}.msg.err{background:#7f1d1d;color:#fecaca}.em{font-size:0.88rem;color:#93c5fd;margin-bottom:8px;word-break:break-all}a{color:#60a5fa;font-size:0.88rem}.hidden{display:none!important}</style></head><body><main class="card"><h1>${escapeHtmlAttr(h1)}</h1><p class="sub">${escapeHtmlAttr(sub)}</p><div class="em" id="em"></div><label for="p1">${escapeHtmlAttr(lblPw)}</label><input id="p1" type="password" autocomplete="new-password"/><label for="p2">${escapeHtmlAttr(lblPw2)}</label><input id="p2" type="password" autocomplete="new-password"/><label for="cd">${escapeHtmlAttr(lblCode)}</label><input id="cd" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" style="letter-spacing:0.12em"/><button type="button" class="btn-l" id="bS">${escapeHtmlAttr(btnSend)}</button><button type="button" class="btn-p" id="bC">${escapeHtmlAttr(btnSave)}</button><div id="mg" class="msg hidden"></div><p style="margin-top:14px"><a href="/">${escapeHtmlAttr(back)}</a></p></main><script>(function(){var API=${api},TOKEN=${tok},LANG=${lg},EM=${emJs};function pol(pw){if(typeof pw!=="string"||pw.length<8)return false;if(!/[A-Z]/.test(pw))return false;if(!/[a-z]/.test(pw))return false;if(!/[0-9]/.test(pw))return false;if(!/[^A-Za-z0-9]/.test(pw))return false;return true;}function msg(t,k){var m=document.getElementById("mg");m.textContent=t||"";m.classList.remove("hidden","ok","err");m.classList.add(k==="err"?"err":"ok");}function hide(){document.getElementById("mg").classList.add("hidden");}document.getElementById("em").textContent=EM||"";document.getElementById("bS").onclick=async function(){hide();try{var r=await fetch(API+"/auth/password-reset/finish/send-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TOKEN,lang:LANG})});var j=await r.json().catch(function(){return{};});if(!r.ok)throw new Error([j.error,j.details].filter(Boolean).join(" — ")||("HTTP "+r.status));msg(j.message||(LANG==="es"?"Revisa tu correo.":"Check your email."),"ok");}catch(e){msg(e.message||String(e),"err");}};document.getElementById("bC").onclick=async function(){hide();try{var p1=document.getElementById("p1").value.trim();var p2=document.getElementById("p2").value.trim();var c=document.getElementById("cd").value.trim();if(!p1||!p2)throw new Error(LANG==="es"?"Escribe ambas contraseñas.":"Enter both passwords.");if(p1!==p2)throw new Error(LANG==="es"?"No coinciden.":"Passwords do not match.");if(!pol(p1))throw new Error(LANG==="es"?"La contraseña debe tener 8+ caracteres, mayúscula, minúscula, número y símbolo.":"Password needs 8+ chars with upper, lower, number and symbol.");if(!/^\\d{6}$/.test(c))throw new Error(LANG==="es"?"El código son 6 dígitos.":"Code must be 6 digits.");var r=await fetch(API+"/auth/password-reset/finish/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TOKEN,password:p1,code:c,lang:LANG})});var j=await r.json().catch(function(){return{};});if(!r.ok)throw new Error([j.error,j.details].filter(Boolean).join(" — ")||("HTTP "+r.status));msg(j.message||(LANG==="es"?"Listo. Redirigiendo…":"Done. Redirecting…"),"ok");setTimeout(function(){location.href="/";},800);}catch(e){msg(e.message||String(e),"err");}};})();</script></body></html>`;
}

function registerAuthSignupRoutes(app, deps) {
  const { supabaseAdmin, jsonError, appError } = deps;

  /** GET: solo muestra confirmación; el enlace real se consume en POST (evita bots de correo que vacían el token). */
  app.get("/auth/recover", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      const token = normalizeRecoverTokenParam(req.query?.t);
      if (!isRecoverTokenHexFormat(token)) {
        appError("[auth/recover GET] token formato invalido", { len: token.length });
        return res.status(400).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!supabaseAdmin) {
        return res.status(500).type("text/plain").send("Server misconfiguration.");
      }
      const { row, selErr } = await fetchPasswordResetRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/recover GET] select", logSupabaseErr("select", selErr));
        if (isMissingPasswordResetTable(selErr)) {
          return res.status(503).type("text/html; charset=utf-8").send(htmlRecoverMissingTable());
        }
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!row?.target_url) {
        appError("[auth/recover GET] sin fila para token", { token_prefix: token.slice(0, 4) });
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      const postAction = absoluteAuthRecoverPostUrl(req);
      return res.status(200).type("text/html; charset=utf-8").send(htmlRecoverConfirmForm(token, postAction));
    } catch (e) {
      appError("[auth/recover GET]", e);
      return res.status(500).type("text/plain").send("Error.");
    }
  });

  app.post("/auth/recover", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      const token = normalizeRecoverTokenParam(req.body?.t);
      if (!isRecoverTokenHexFormat(token)) {
        appError("[auth/recover POST] token formato invalido", { len: token.length });
        return res.status(400).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!supabaseAdmin) {
        return res.status(500).type("text/plain").send("Server misconfiguration.");
      }
      const { row, selErr } = await fetchPasswordResetRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/recover POST] select", logSupabaseErr("select", selErr));
        if (isMissingPasswordResetTable(selErr)) {
          return res.status(503).type("text/html; charset=utf-8").send(htmlRecoverMissingTable());
        }
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }
      if (!row?.target_url) {
        appError("[auth/recover POST] sin fila para token", { token_prefix: token.slice(0, 4) });
        return res.status(410).type("text/html; charset=utf-8").send(htmlRecoverLinkInvalid());
      }

      const emailRow = row.email ? normalizeEmail(row.email) : "";
      let uidRow = row.user_id ? String(row.user_id) : "";
      if (emailRow && isValidEmailShape(emailRow) && !uidRow) {
        uidRow = await resolveAuthUserIdForRecovery(supabaseAdmin, deps, emailRow, {});
      }
      if (emailRow && isValidEmailShape(emailRow) && uidRow) {
        const finishToken = crypto.randomBytes(PASSWORD_RESET_TOKEN_HEX_BYTES).toString("hex");
        const finExpires = new Date(Date.now() + PASSWORD_RESET_SHORTLINK_TTL_MS).toISOString();
        const { error: finInsErr } = await supabaseAdmin.from("password_reset_finish").insert({
          token: finishToken,
          email: emailRow,
          user_id: uidRow,
          expires_at: finExpires
        });
        if (!finInsErr) {
          const base = absolutePublicApiOrigin(deps, req) || resolveRecoverClickBase(deps, req);
          if (base) {
            await supabaseAdmin.from("password_reset_shortlinks").delete().eq("token", token);
            const next = `${String(base).replace(/\/+$/, "")}/auth/reset-password?t=${encodeURIComponent(finishToken)}`;
            try {
              const bu = new URL(next.startsWith("http") ? next : `https://${next}`);
              appError("[auth/recover POST] redirect_finish_flow", { next_host: bu.hostname, path: bu.pathname });
            } catch (e2) {
              appError("[auth/recover POST] redirect_finish_flow_parse", e2?.message || e2);
            }
            return res.redirect(302, next);
          }
          await supabaseAdmin.from("password_reset_finish").delete().eq("token", finishToken);
        } else {
          appError("[auth/recover POST] insert password_reset_finish", logSupabaseErr("insert finish", finInsErr));
          if (isMissingPasswordResetFinishTable(finInsErr)) {
            await supabaseAdmin.from("password_reset_shortlinks").delete().eq("token", token);
            const lang = resolveAuthLang({}, req);
            return res.status(503).type("text/html; charset=utf-8").send(htmlPasswordResetFinishMissingTable(lang));
          }
        }
      }

      if (emailRow && isValidEmailShape(emailRow) && !uidRow) {
        appError("[auth/recover POST] sin user_id para password_reset_finish (revisa SUPABASE_* y migraciones)", {
          emailLen: emailRow.length
        });
      }

      await supabaseAdmin.from("password_reset_shortlinks").delete().eq("token", token);
      const finalUrl = rewriteSupabaseRecoveryActionUrl(row.target_url, deps, req);
      try {
        const fu = new URL(String(finalUrl));
        const rawRt = fu.searchParams.get("redirect_to") || "";
        let rtOrigin = "";
        try {
          const dec = (() => {
            try {
              return decodeURIComponent(rawRt);
            } catch (_) {
              return rawRt;
            }
          })();
          if (dec) rtOrigin = new URL(dec.startsWith("http") ? dec : `https://x.invalid${dec.startsWith("/") ? "" : "/"}${dec}`).origin;
        } catch (_) {}
        appError("[auth/recover POST] legacy_redirect_supabase_action_link", {
          action_host: fu.hostname,
          redirect_to_origin: rtOrigin || null,
          api_origin_hint: echoDebtyaApiBaseForClient(deps, req) || derivePublicOriginFromRequest(req) || null
        });
      } catch (logErr) {
        appError("[auth/recover POST] legacy_redirect_supabase_action_link_parse", logErr?.message || logErr);
      }
      return res.redirect(302, finalUrl);
    } catch (e) {
      appError("[auth/recover POST]", e);
      return res.status(500).type("text/plain").send("Error.");
    }
  });

  /** Pantalla HTML en la API (sin depender del front ni de Supabase redirect). */
  app.get("/auth/reset-password", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      if (!supabaseAdmin) {
        return res.status(500).type("text/plain").send("Server misconfiguration.");
      }
      const lang = resolveAuthLang(req.query, req);
      const token = normalizeRecoverTokenParam(req.query?.t);
      if (!isRecoverTokenHexFormat(token)) {
        return res.status(400).type("text/html; charset=utf-8").send(htmlPasswordResetFinishInvalid());
      }
      const { row, selErr } = await fetchPasswordResetFinishRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/reset-password GET] select", logSupabaseErr("select", selErr));
        if (isMissingPasswordResetFinishTable(selErr)) {
          return res.status(503).type("text/html; charset=utf-8").send(htmlPasswordResetFinishMissingTable(lang));
        }
        return res.status(410).type("text/html; charset=utf-8").send(htmlPasswordResetFinishInvalid());
      }
      if (!row?.email) {
        return res.status(410).type("text/html; charset=utf-8").send(htmlPasswordResetFinishInvalid());
      }
      const origin = absolutePublicApiOrigin(deps, req) || resolveRecoverClickBase(deps, req);
      if (!origin) {
        return res.status(500).type("text/plain").send("Could not resolve public URL.");
      }
      const page = htmlPasswordResetFinishPage(origin, token, lang, maskEmailForDisplay(row.email));
      return res.status(200).type("text/html; charset=utf-8").send(page);
    } catch (e) {
      appError("[auth/reset-password GET]", e);
      return res.status(500).type("text/plain").send("Error.");
    }
  });

  app.post("/auth/password-reset/request", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    const neutralJson = () => {
      setDebtyaApiBaseResponseHeader(res, deps, req);
      return res.json({ ok: true, message: tAuth(lang, "msg_pw_reset_neutral") });
    };

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
      const actionLinkRaw = props.action_link || props.actionLink || "";
      if (!actionLinkRaw) {
        appError("[auth/password-reset] sin action_link", { keys: Object.keys(props) });
        return neutralJson();
      }
      const actionLink = rewriteSupabaseRecoveryActionUrl(actionLinkRaw, deps, req);

      const clickBase = resolveRecoverClickBase(deps, req);
      const shortToken = crypto.randomBytes(PASSWORD_RESET_TOKEN_HEX_BYTES).toString("hex");
      const shortExpires = new Date(Date.now() + PASSWORD_RESET_SHORTLINK_TTL_MS).toISOString();
      let linkForEmail = actionLink;
      if (clickBase) {
        const insertShort = {
          token: shortToken,
          target_url: actionLink,
          expires_at: shortExpires
        };
        const uidResolved = await resolveAuthUserIdForRecovery(supabaseAdmin, deps, email, linkData);
        if (uidResolved) {
          insertShort.email = email;
          insertShort.user_id = uidResolved;
        }
        let { error: shortErr } = await supabaseAdmin.from("password_reset_shortlinks").insert(insertShort);
        if (shortErr && (insertShort.email || insertShort.user_id)) {
          const msg = String(shortErr.message || shortErr.code || "").toLowerCase();
          if (
            msg.includes("column") ||
            msg.includes("schema") ||
            msg.includes("could not find") ||
            msg.includes("does not exist")
          ) {
            const { error: shortErr2 } = await supabaseAdmin.from("password_reset_shortlinks").insert({
              token: shortToken,
              target_url: actionLink,
              expires_at: shortExpires
            });
            shortErr = shortErr2;
          }
        }
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

  /** Código por email usando token de paso final (tabla password_reset_finish), sin Supabase en el navegador. */
  app.post("/auth/password-reset/finish/send-code", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const token = normalizeRecoverTokenParam(req.body?.token);
      if (!isRecoverTokenHexFormat(token)) {
        return jsonError(res, 400, tAuth(lang, "err_pw_finish_token"));
      }
      const { row: fin, selErr } = await fetchPasswordResetFinishRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/pw-finish/send-code] select", logSupabaseErr("select", selErr));
        if (isMissingPasswordResetFinishTable(selErr)) {
          return jsonError(res, 503, tAuth(lang, "err_pw_finish_db"));
        }
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      if (!fin?.email) {
        return jsonError(res, 400, tAuth(lang, "err_pw_finish_token"));
      }
      const emailNorm = normalizeEmail(fin.email);

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        return jsonError(res, 503, tAuth(lang, "err_resend_not_configured"));
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      if (!bumpRate(PW_FINISH_SEND_BY_EMAIL, emailNorm, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_email"));
      }
      if (!bumpRate(SEND_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_rate_ip"));
      }

      const code = randomSixDigitCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", emailNorm);

      const { error: insErr } = await supabaseAdmin.from("signup_verification_codes").insert({
        email: emailNorm,
        code,
        expires_at: expiresAt
      });
      if (insErr) {
        appError("[auth/pw-finish/send-code] insert code", logSupabaseErr("insert", insErr));
        return jsonError(res, 500, tAuth(lang, "err_code_save_failed"));
      }

      try {
        await sendResendEmail({
          to: emailNorm,
          subject: tAuth(lang, "pw_reset_session_email_subject"),
          text: (lang === "es" ? AUTH_I18N.es.pw_reset_session_email_body : AUTH_I18N.en.pw_reset_session_email_body)(
            code
          ),
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/pw-finish/send-code] Resend", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", emailNorm);
        return jsonError(res, 502, tAuth(lang, "err_mail_send_failed"));
      }

      return res.json({
        ok: true,
        message: lang === "es" ? "Revisa tu correo para el código de 6 dígitos." : "Check your email for the 6-digit code."
      });
    } catch (e) {
      appError("[auth/pw-finish/send-code]", e);
      return jsonError(res, 500, tAuth(lang, "err_generic_send_code"));
    }
  });

  app.post("/auth/password-reset/finish/complete", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const token = normalizeRecoverTokenParam(req.body?.token);
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!isRecoverTokenHexFormat(token)) {
        return jsonError(res, 400, tAuth(lang, "err_pw_finish_token"));
      }
      if (!signupPasswordMeetsPolicy(password)) {
        return jsonError(res, 400, tAuth(lang, "err_password_policy"));
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_digits"));
      }

      const { row: fin, selErr } = await fetchPasswordResetFinishRow(supabaseAdmin, token);
      if (selErr) {
        appError("[auth/pw-finish/complete] select finish", logSupabaseErr("select", selErr));
        if (isMissingPasswordResetFinishTable(selErr)) {
          return jsonError(res, 503, tAuth(lang, "err_pw_finish_db"));
        }
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      if (!fin?.email || !fin?.user_id) {
        return jsonError(res, 400, tAuth(lang, "err_pw_finish_token"));
      }
      const emailNorm = normalizeEmail(fin.email);
      const uid = String(fin.user_id);

      if (!bumpRate(PW_FINISH_VERIFY_BY_EMAIL, emailNorm, VERIFY_WINDOW_MS, VERIFY_MAX)) {
        return jsonError(res, 429, tAuth(lang, "err_too_many_verify"));
      }

      const nowIso = new Date().toISOString();
      const { data: rows, error: cErr } = await supabaseAdmin
        .from("signup_verification_codes")
        .select("id, code, expires_at")
        .eq("email", emailNorm)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(1);

      if (cErr) {
        appError("[auth/pw-finish/complete] select code", logSupabaseErr("select", cErr));
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      const crow = rows && rows[0];
      if (!crow?.code || !codesEqualTimingSafe(crow.code, code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", emailNorm);

      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, { password });
      if (updErr) {
        appError("[auth/pw-finish/complete] updateUserById", logSupabaseErr("updateUserById", updErr));
        return jsonError(res, 400, tAuth(lang, "err_pw_reset_session_update_failed"));
      }

      await supabaseAdmin.from("password_reset_finish").delete().eq("token", token);

      return res.json({
        ok: true,
        message: lang === "es" ? "Contraseña actualizada." : "Password updated."
      });
    } catch (e) {
      appError("[auth/pw-finish/complete]", e);
      return jsonError(res, 500, tAuth(lang, "err_pw_reset_session_update_failed"));
    }
  });

  /**
   * Tras abrir el enlace de recuperación de Supabase (sesión temporal), envía un código de 6 dígitos al correo.
   * Authorization: Bearer <access_token de la sesión actual>.
   */
  app.post("/auth/password-reset/session/send-code", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const accessToken = readBearerAccessToken(req);
      if (!accessToken) {
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }
      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
      if (userErr || !userData?.user?.email) {
        appError(
          "[auth/pw-reset-session/send-code] getUser",
          userErr ? logSupabaseErr("getUser", userErr) : "sin user"
        );
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }
      const email = normalizeEmail(userData.user.email);
      if (!isValidEmailShape(email)) {
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        return jsonError(res, 503, tAuth(lang, "err_resend_not_configured"));
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      if (!bumpRate(PW_RESET_SESSION_SEND_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
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
        appError("[auth/pw-reset-session/send-code] insert failed", logSupabaseErr("insert", insErr));
        return jsonError(res, 500, tAuth(lang, "err_code_save_failed"));
      }

      try {
        await sendResendEmail({
          to: email,
          subject: tAuth(lang, "pw_reset_session_email_subject"),
          text: (lang === "es" ? AUTH_I18N.es.pw_reset_session_email_body : AUTH_I18N.en.pw_reset_session_email_body)(
            code
          ),
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/pw-reset-session/send-code] Resend:", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);
        return jsonError(res, 502, tAuth(lang, "err_mail_send_failed"));
      }

      return res.json({
        ok: true,
        message:
          lang === "es"
            ? "Si la sesión es válida, recibirás un código de 6 dígitos en tu correo."
            : "If your session is valid, you will receive a 6-digit code shortly."
      });
    } catch (e) {
      appError("[auth/pw-reset-session/send-code]", e);
      return jsonError(res, 500, tAuth(lang, "err_generic_send_code"));
    }
  });

  /**
   * Verifica el código y fija la nueva contraseña (admin). La sesión del cliente sigue siendo válida.
   */
  app.post("/auth/password-reset/session/complete", async (req, res) => {
    const lang = resolveAuthLang(req.body, req);
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, tAuth(lang, "err_supabase_not_configured"));
      }
      const accessToken = readBearerAccessToken(req);
      if (!accessToken) {
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!signupPasswordMeetsPolicy(password)) {
        return jsonError(res, 400, tAuth(lang, "err_password_policy"));
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_digits"));
      }

      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
      if (userErr || !userData?.user?.email) {
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }
      const email = normalizeEmail(userData.user.email);
      const uid = String(userData.user.id || "");
      if (!uid) {
        return jsonError(res, 401, tAuth(lang, "err_pw_reset_session_unauthorized"));
      }

      if (!bumpRate(PW_RESET_SESSION_VERIFY_BY_UID, uid, VERIFY_WINDOW_MS, VERIFY_MAX)) {
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
        appError("[auth/pw-reset-session/complete] select failed", logSupabaseErr("select", selErr));
        return jsonError(res, 500, tAuth(lang, "err_verify_db"));
      }
      const row = rows && rows[0];
      if (!row?.code || !codesEqualTimingSafe(row.code, code)) {
        return jsonError(res, 400, tAuth(lang, "err_code_bad_or_expired"));
      }

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(uid, { password });
      if (updErr) {
        appError("[auth/pw-reset-session/complete] updateUserById", logSupabaseErr("updateUserById", updErr));
        return jsonError(res, 400, tAuth(lang, "err_pw_reset_session_update_failed"));
      }

      return res.json({
        ok: true,
        message: lang === "es" ? "Contraseña actualizada." : "Password updated."
      });
    } catch (e) {
      appError("[auth/pw-reset-session/complete]", e);
      return jsonError(res, 500, tAuth(lang, "err_pw_reset_session_update_failed"));
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
