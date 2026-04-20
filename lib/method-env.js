/**
 * Lectura unificada de configuración Method (process.env).
 * - Se evalúa en tiempo de petición.
 * - Alias por nombres distintos en Render/plantillas.
 * - Normaliza BOM, zero-width, espacios y comillas envolventes.
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

const METHOD_KEY_CANDIDATES = [
  "METHOD_API_KEY",
  "DEBTYA_METHOD_API_KEY",
  "METHOD_APIKEY",
  "METHODFI_API_KEY",
  "METHOD_FI_API_KEY",
  "METHOD_SECRET_KEY",
  "METHOD_SECRET"
];

function readFirstEnv(candidates) {
  for (const key of candidates) {
    const raw = process.env[key];
    const val = normalizeSecretInput(raw);
    if (val) return { value: val, key };
  }
  return { value: "", key: null };
}

/**
 * Clave API Method (Bearer). Orden de prioridad.
 * @returns {string}
 */
function readMethodApiKey() {
  return readFirstEnv(METHOD_KEY_CANDIDATES).value;
}

/**
 * Estado de deteccion sin exponer secreto.
 * @returns {{configured:boolean,key_source:string|null,key_length:number}}
 */
function readMethodKeyStatus() {
  const hit = readFirstEnv(METHOD_KEY_CANDIDATES);
  return {
    configured: !!hit.value,
    key_source: hit.key,
    key_length: hit.value.length
  };
}

/**
 * @returns {boolean}
 */
function isMethodConfigured() {
  return readMethodApiKey().length > 0;
}

/**
 * @returns {string}
 */
function readMethodEnv() {
  const raw =
    process.env.METHOD_ENV ||
    process.env.DEBTYA_METHOD_ENV ||
    process.env.METHODFI_ENV ||
    process.env.METHOD_FI_ENV ||
    "production";
  const s = normalizeSecretInput(raw).toLowerCase();
  if (s === "sandbox") return "sandbox";
  if (s === "dev" || s === "development") return "dev";
  return "production";
}

/**
 * @returns {string}
 */
function readMethodApiVersion() {
  const raw =
    process.env.METHOD_API_VERSION ||
    process.env.DEBTYA_METHOD_API_VERSION ||
    process.env.METHODFI_API_VERSION ||
    process.env.METHOD_FI_API_VERSION ||
    "2025-12-01";
  const s = normalizeSecretInput(raw);
  return s || "2025-12-01";
}

module.exports = {
  readMethodApiKey,
  readMethodEnv,
  readMethodApiVersion,
  isMethodConfigured,
  readMethodKeyStatus
};
