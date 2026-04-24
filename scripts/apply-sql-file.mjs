/**
 * Ejecuta un archivo .sql contra Postgres (p. ej. URI de Supabase: Settings → Database).
 * Uso: node scripts/apply-sql-file.mjs sql/add_debts_spinwheel_columns_if_missing.sql
 * Requiere: DATABASE_URL en .env (o en el entorno).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || "";
const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Uso: node scripts/apply-sql-file.mjs <ruta-al.sql>");
  process.exit(1);
}
if (!url) {
  console.error(
    "Falta DATABASE_URL (o SUPABASE_DATABASE_URL). Añade en .env la URI de Postgres del proyecto (Supabase → Settings → Database → Connection string → URI)."
  );
  process.exit(1);
}

const sqlPath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
const sql = fs.readFileSync(sqlPath, "utf8");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  console.log("OK:", sqlPath);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
