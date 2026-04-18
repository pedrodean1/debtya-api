const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SEND_BY_EMAIL = new Map();
const SEND_BY_IP = new Map();
const VERIFY_BY_EMAIL = new Map();
const LOGIN_VERIFY_BY_EMAIL = new Map();

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

/** Cliente anon nuevo por petición (evita contaminar sesión entre requests en el singleton del servidor). */
function createFreshAnonAuthClient(deps) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = deps;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function registerAuthSignupRoutes(app, deps) {
  const { supabaseAdmin, jsonError, appError } = deps;

  app.post("/auth/signup/send-verification-code", async (req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        appError("[auth/signup/send-code] Resend env ausente o vacio (tras trim)", {
          RESEND_API_KEY_len: RESEND_API_KEY.length,
          RESEND_FROM_EMAIL_len: RESEND_FROM_EMAIL.length,
          has_RESEND_API_KEY: Object.prototype.hasOwnProperty.call(process.env, "RESEND_API_KEY"),
          has_RESEND_FROM_EMAIL: Object.prototype.hasOwnProperty.call(process.env, "RESEND_FROM_EMAIL")
        });
        return jsonError(res, 503, "Envío de correo no configurado (RESEND_API_KEY / RESEND_FROM_EMAIL).");
      }

      const emailRaw = req.body?.email;
      const email = normalizeEmail(emailRaw);
      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, "Correo no válido.");
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      if (!bumpRate(SEND_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, "Demasiados códigos para este correo. Espera un poco e inténtalo de nuevo.");
      }
      if (!bumpRate(SEND_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, "Demasiadas solicitudes. Inténtalo más tarde.");
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
        return jsonError(res, 500, "No se pudo guardar el código. Revisa la tabla signup_verification_codes en Supabase.");
      }

      try {
        await sendResendEmail({
          to: email,
          subject: "Tu código de verificación DebtYa",
          text: `Tu código de verificación DebtYa es: ${code}\n\nVálido durante 15 minutos. Si no solicitaste registrarte, ignora este mensaje.`,
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/signup/send-code] Resend:", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);
        return jsonError(res, 502, "No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.");
      }

      return res.json({
        ok: true,
        message: "Si el correo es válido, recibirás un código en unos instantes."
      });
    } catch (e) {
      appError("[auth/signup/send-code]", e);
      return jsonError(res, 500, "Error enviando código.");
    }
  });

  app.post("/auth/login/send-verification-code", async (req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }
      const anonAuth = createFreshAnonAuthClient(deps);
      if (!anonAuth) {
        return jsonError(res, 500, "Supabase anon no configurado");
      }

      const { apiKey: RESEND_API_KEY, fromEmail: RESEND_FROM_EMAIL } = readResendEnv();
      if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
        appError("[auth/login/send-code] Resend env ausente o vacio (tras trim)", {
          RESEND_API_KEY_len: RESEND_API_KEY.length,
          RESEND_FROM_EMAIL_len: RESEND_FROM_EMAIL.length,
          has_RESEND_API_KEY: Object.prototype.hasOwnProperty.call(process.env, "RESEND_API_KEY"),
          has_RESEND_FROM_EMAIL: Object.prototype.hasOwnProperty.call(process.env, "RESEND_FROM_EMAIL")
        });
        return jsonError(res, 503, "Envío de correo no configurado (RESEND_API_KEY / RESEND_FROM_EMAIL).");
      }

      const emailRaw = req.body?.email;
      const email = normalizeEmail(emailRaw);
      const password = String(req.body?.password || "");
      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, "Correo no válido.");
      }
      if (!password) {
        return jsonError(res, 400, "Contraseña requerida.");
      }

      const rawIp = String(req.headers["x-forwarded-for"] || "");
      const ip = rawIp.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

      const { data: signData, error: signErr } = await anonAuth.auth.signInWithPassword({ email, password });
      if (signErr || !signData?.session) {
        appError("[auth/login/send-code] signInWithPassword fallo", signErr?.message || signErr || "sin session");
        return jsonError(res, 401, "Email o contraseña incorrectos.");
      }

      if (!bumpRate(SEND_BY_EMAIL, email, SEND_EMAIL_WINDOW_MS, SEND_EMAIL_MAX)) {
        return jsonError(res, 429, "Demasiados códigos para este correo. Espera un poco e inténtalo de nuevo.");
      }
      if (!bumpRate(SEND_BY_IP, ip, SEND_IP_WINDOW_MS, SEND_IP_MAX)) {
        return jsonError(res, 429, "Demasiadas solicitudes. Inténtalo más tarde.");
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
        return jsonError(res, 500, "No se pudo guardar el código. Revisa la tabla signup_verification_codes en Supabase.");
      }

      try {
        await sendResendEmail({
          to: email,
          subject: "Tu código para iniciar sesión en DebtYa",
          text: `Tu código para iniciar sesión en DebtYa es: ${code}\n\nVálido durante 15 minutos. Si no fuiste tú, cambia tu contraseña.`,
          apiKey: RESEND_API_KEY,
          fromEmail: RESEND_FROM_EMAIL
        });
      } catch (mailErr) {
        appError("[auth/login/send-code] Resend:", mailErr.message || mailErr);
        await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);
        return jsonError(res, 502, "No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.");
      }

      return res.json({
        ok: true,
        message: "Si el correo y la contraseña son correctos, recibirás un código en unos instantes."
      });
    } catch (e) {
      appError("[auth/login/send-code]", e);
      return jsonError(res, 500, "Error enviando código.");
    }
  });

  app.post("/auth/login/complete", async (req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, "Correo no válido.");
      }
      if (!password) {
        return jsonError(res, 400, "Contraseña requerida.");
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, "El código debe ser de 6 dígitos.");
      }

      if (!bumpRate(LOGIN_VERIFY_BY_EMAIL, email, VERIFY_WINDOW_MS, VERIFY_MAX)) {
        return jsonError(res, 429, "Demasiados intentos. Solicita un código nuevo.");
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
        return jsonError(res, 500, "Error verificando código.");
      }
      const row = rows && rows[0];
      if (!row?.code) {
        return jsonError(res, 400, "Código incorrecto o caducado. Solicita uno nuevo.");
      }

      if (!codesEqualTimingSafe(row.code, code)) {
        return jsonError(res, 400, "Código incorrecto o caducado. Solicita uno nuevo.");
      }

      await supabaseAdmin.from("signup_verification_codes").delete().eq("email", email);

      const anonAuth = createFreshAnonAuthClient(deps);
      if (!anonAuth) {
        return jsonError(res, 500, "Supabase anon no configurado");
      }

      const { data: signData, error: signErr } = await anonAuth.auth.signInWithPassword({ email, password });
      if (signErr || !signData?.session) {
        appError("[auth/login/complete] signInWithPassword fallo", signErr?.message || signErr || "sin session");
        return jsonError(res, 401, "Email o contraseña incorrectos.");
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
      return jsonError(res, 500, "Error iniciando sesión.");
    }
  });

  app.post("/auth/signup/complete", async (req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }

      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");
      const code = String(req.body?.code || "").trim();

      if (!isValidEmailShape(email)) {
        return jsonError(res, 400, "Correo no válido.");
      }
      if (!signupPasswordMeetsPolicy(password)) {
        return jsonError(res, 400, "La contraseña no cumple los requisitos mínimos.");
      }
      if (!/^\d{6}$/.test(code)) {
        return jsonError(res, 400, "El código debe ser de 6 dígitos.");
      }

      if (!bumpRate(VERIFY_BY_EMAIL, email, VERIFY_WINDOW_MS, VERIFY_MAX)) {
        return jsonError(res, 429, "Demasiados intentos. Solicita un código nuevo.");
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
        return jsonError(res, 500, "Error verificando código.");
      }
      const row = rows && rows[0];
      if (!row?.code) {
        return jsonError(res, 400, "Código incorrecto o caducado. Solicita uno nuevo.");
      }

      if (!codesEqualTimingSafe(row.code, code)) {
        return jsonError(res, 400, "Código incorrecto o caducado. Solicita uno nuevo.");
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
          return jsonError(res, 409, "Ese correo ya está registrado. Inicia sesión.");
        }
        appError("[auth/signup/complete] createUser:", createErr);
        return jsonError(res, 400, msg || "No se pudo crear la cuenta.");
      }

      return res.json({
        ok: true,
        user_id: created?.user?.id || null
      });
    } catch (e) {
      appError("[auth/signup/complete]", e);
      return jsonError(res, 500, "Error completando el registro.");
    }
  });
}

module.exports = { registerAuthSignupRoutes };
