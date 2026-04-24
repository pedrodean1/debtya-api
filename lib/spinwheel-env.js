/**
 * Configuración Spinwheel (solo process.env). Sin claves en código.
 * Prioriza alias útiles en Render / plantillas DebYa.
 */

function stripZeroWidthAndBom(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function stripSurroundingQuotes(s) {
  let v = String(s || "").trim();
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

function normalizeSecretInput(raw) {
  let s = stripZeroWidthAndBom(raw);
  s = stripSurroundingQuotes(s);
  return s.trim();
}

/** Evita `Authorization: Bearer Bearer ...` y valores multilinea. */
function normalizeBearerSecret(raw) {
  let v = normalizeSecretInput(raw);
  while (/^bearer\s+/i.test(v)) {
    v = v.replace(/^bearer\s+/i, "").trim();
  }
  const lines = v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  v = lines[0] || "";
  return v.replace(/\r$/, "").trim();
}

const SPINWHEEL_SECRET_CANDIDATES = [
  "SPINWHEEL_API_SECRET",
  "DEBTYA_SPINWHEEL_API_SECRET",
  "SPINWHEEL_SECRET_KEY",
  "SPINWHEEL_API_KEY"
];

function readFirstEnv(candidates) {
  for (const key of candidates) {
    const raw = process.env[key];
    const val = normalizeBearerSecret(raw);
    if (val) return { value: val, key };
  }
  return { value: "", key: null };
}

function readSpinwheelApiSecret() {
  return readFirstEnv(SPINWHEEL_SECRET_CANDIDATES).value;
}

function readSpinwheelKeyStatus() {
  const hit = readFirstEnv(SPINWHEEL_SECRET_CANDIDATES);
  return {
    configured: !!hit.value,
    key_source: hit.key,
    key_length: hit.value.length
  };
}

function isSpinwheelConfigured() {
  return readSpinwheelApiSecret().length > 0;
}

/**
 * @returns {"sandbox"|"production"}
 */
function readSpinwheelEnv() {
  const raw =
    process.env.SPINWHEEL_ENV ||
    process.env.DEBTYA_SPINWHEEL_ENV ||
    process.env.SPINWHEEL_API_ENV ||
    "sandbox";
  const s = normalizeSecretInput(raw).toLowerCase();
  if (s === "production" || s === "prod" || s === "live") return "production";
  return "sandbox";
}

function readSpinwheelBaseUrlOverride() {
  const raw = process.env.SPINWHEEL_BASE_URL || process.env.DEBTYA_SPINWHEEL_BASE_URL || "";
  return normalizeSecretInput(raw).replace(/\/+$/, "");
}

function readSpinwheelSecureBaseUrlOverride() {
  const raw =
    process.env.SPINWHEEL_SECURE_BASE_URL || process.env.DEBTYA_SPINWHEEL_SECURE_BASE_URL || "";
  return normalizeSecretInput(raw).replace(/\/+$/, "");
}

function defaultSpinwheelApiBase(spinEnv) {
  return spinEnv === "production" ? "https://api.spinwheel.io" : "https://sandbox-api.spinwheel.io";
}

function defaultSpinwheelSecureBase(spinEnv) {
  return spinEnv === "production"
    ? "https://secure-api.spinwheel.io"
    : "https://secure-sandbox-api.spinwheel.io";
}

function readSpinwheelApiBaseUrl() {
  const o = readSpinwheelBaseUrlOverride();
  if (o) return o;
  return defaultSpinwheelApiBase(readSpinwheelEnv());
}

function readSpinwheelSecureApiBaseUrl() {
  const o = readSpinwheelSecureBaseUrlOverride();
  if (o) return o;
  return defaultSpinwheelSecureBase(readSpinwheelEnv());
}

/** Secreto compartido opcional: cabecera `x-debtya-spinwheel-webhook` debe coincidir (comparación timing-safe). */
function readSpinwheelWebhookSecret() {
  return normalizeSecretInput(
    process.env.SPINWHEEL_WEBHOOK_SECRET || process.env.DEBTYA_SPINWHEEL_WEBHOOK_SECRET || ""
  );
}

module.exports = {
  readSpinwheelApiSecret,
  readSpinwheelEnv,
  readSpinwheelKeyStatus,
  isSpinwheelConfigured,
  readSpinwheelApiBaseUrl,
  readSpinwheelSecureApiBaseUrl,
  readSpinwheelWebhookSecret,
  normalizeBearerSecret,
  defaultSpinwheelApiBase,
  defaultSpinwheelSecureBase
};
