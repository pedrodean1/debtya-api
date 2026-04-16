/**
 * Comprueba variables de entorno requeridas sin imprimir secretos.
 * Uso: node scripts/validate-env.js
 * Con NODE_ENV=production exige mas claves criticas.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const isProd = process.env.NODE_ENV === "production";

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
    return v === undefined || String(v).trim() === "";
  });
}

const need = [...always, ...(isProd ? prodExtra : [])];
const absent = missing(need);

if (absent.length) {
  console.error(
    "[validate-env] Faltan variables:",
    absent.join(", "),
    isProd ? "(modo production)" : ""
  );
  process.exit(1);
}

console.log("[validate-env] OK", isProd ? "(production)" : "");
