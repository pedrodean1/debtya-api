/**
 * Comprueba variables de entorno requeridas sin imprimir secretos.
 * Uso: node scripts/validate-env.js
 * Con NODE_ENV=production o RENDER=true exige mas claves criticas.
 */

if (process.env.CI !== "true") {
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
}

const isProd = process.env.NODE_ENV === "production";
/** Render define RENDER=true; asi el servicio no arranca sin anon aunque NODE_ENV no este definido. */
const isProdLike = isProd || process.env.RENDER === "true";

const always = ["SUPABASE_URL"];

const prodExtra = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CRON_SECRET"
];

function missing(keys) {
  return keys.filter((k) => {
    const v = process.env[k];
    if (v !== undefined && String(v).trim() !== "") return false;
    if (k === "SUPABASE_ANON_KEY") {
      const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (svc !== undefined && String(svc).trim() !== "") return false;
    }
    return true;
  });
}

const need = [...always, ...(isProdLike ? prodExtra : [])];
const absent = missing(need);

if (absent.length) {
  console.error(
    "[validate-env] Faltan variables:",
    absent.join(", "),
    isProdLike ? "(production o Render)" : ""
  );
  process.exit(1);
}

console.log("[validate-env] OK", isProdLike ? "(production o Render)" : "");
