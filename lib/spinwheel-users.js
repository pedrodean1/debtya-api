const { readSpinwheelEnv } = require("./spinwheel-env");
const { spinwheelRawResponseHasDebtProfileData } = require("./spinwheel-debt-import");
const { isUuid } = require("./validation");

/**
 * Extrae Spinwheel `userId` desde cuerpo típico `{ status, data: { userId, ... } }`.
 * @param {unknown} spinwheelBody
 * @returns {string|null} UUID Spinwheel o null
 */
function extractSpinwheelUserIdFromApiResponse(spinwheelBody) {
  if (!spinwheelBody || typeof spinwheelBody !== "object") return null;
  const data = /** @type {any} */ (spinwheelBody).data;
  if (!data || typeof data !== "object") return null;
  const uid = data.userId != null ? String(data.userId).trim() : "";
  if (!uid || !isUuid(uid)) return null;
  return uid;
}

/**
 * @param {unknown} spinwheelBody
 * @returns {string|null}
 */
function extractConnectionStatusFromApiResponse(spinwheelBody) {
  if (!spinwheelBody || typeof spinwheelBody !== "object") return null;
  const data = /** @type {any} */ (spinwheelBody).data;
  if (!data || typeof data !== "object") return null;
  const cs = data.connectionStatus;
  return typeof cs === "string" && cs.trim() ? cs.trim() : null;
}

/**
 * @param {string|null} connectionStatus
 * @returns {string}
 */
function mapConnectionStatusToRowStatus(connectionStatus) {
  const cs = String(connectionStatus || "").toUpperCase();
  if (cs === "SUCCESS") return "active";
  if (cs === "FAILED") return "failed";
  if (cs === "IN_PROGRESS") return "linking";
  return "active";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabaseAdmin
 * @param {string} debtyaUserId
 * @param {"sandbox"|"production"} environment
 */
async function getSpinwheelMappingForUser(supabaseAdmin, debtyaUserId, environment) {
  const { data, error } = await supabaseAdmin
    .from("spinwheel_users")
    .select(
      "id, user_id, spinwheel_user_id, environment, status, raw_response, spinwheel_debt_profile_raw, created_at, updated_at"
    )
    .eq("user_id", debtyaUserId)
    .eq("environment", environment)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Upsert por (user_id, environment). Actualiza spinwheel_user_id si Spinwheel lo devuelve.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabaseAdmin
 * @param {{ debtyaUserId: string, spinwheelBody: unknown, environment?: "sandbox"|"production" }} opts
 * @returns {{ upserted: boolean, row?: object, reason?: string, error?: string }}
 */
async function upsertSpinwheelUserFromApiResponse(supabaseAdmin, opts) {
  const debtyaUserId = String(opts.debtyaUserId || "").trim();
  const environment = opts.environment || readSpinwheelEnv();
  const spinwheelBody = opts.spinwheelBody;
  const swId = extractSpinwheelUserIdFromApiResponse(spinwheelBody);
  if (!swId) {
    return { upserted: false, reason: "no_spinwheel_user_id_in_response" };
  }
  const conn = extractConnectionStatusFromApiResponse(spinwheelBody);
  const status = mapConnectionStatusToRowStatus(conn);
  const now = new Date().toISOString();
  const row = {
    user_id: debtyaUserId,
    spinwheel_user_id: swId,
    environment,
    status,
    raw_response: spinwheelBody && typeof spinwheelBody === "object" ? spinwheelBody : null,
    updated_at: now
  };
  if (spinwheelRawResponseHasDebtProfileData(spinwheelBody)) {
    row.spinwheel_debt_profile_raw = spinwheelBody;
  }
  const { data, error } = await supabaseAdmin
    .from("spinwheel_users")
    .upsert(row, { onConflict: "user_id,environment" })
    .select(
      "id, user_id, spinwheel_user_id, environment, status, raw_response, spinwheel_debt_profile_raw, created_at, updated_at"
    )
    .single();
  if (error) {
    const code = error.code != null ? String(error.code) : "";
    const msg = error.message || String(error);
    if (code === "23505") {
      return { upserted: false, reason: "duplicate_spinwheel_user_id", error: msg };
    }
    return { upserted: false, reason: "db_error", error: msg };
  }
  return { upserted: true, row: data };
}

/**
 * Actualiza status (siempre). Solo pisa raw_response / spinwheel_debt_profile_raw si el body es debt profile;
 * verify/connect no borran el perfil cacheado ni el snapshot de perfil en columna dedicada.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabaseAdmin
 * @param {{ debtyaUserId: string, spinwheelUserId: string, spinwheelBody: unknown, environment?: "sandbox"|"production" }} opts
 */
async function updateSpinwheelUserRawResponse(supabaseAdmin, opts) {
  const debtyaUserId = String(opts.debtyaUserId || "").trim();
  const spinwheelUserId = String(opts.spinwheelUserId || "").trim();
  const environment = opts.environment || readSpinwheelEnv();
  const spinwheelBody = opts.spinwheelBody;
  const conn = extractConnectionStatusFromApiResponse(spinwheelBody);
  const status = mapConnectionStatusToRowStatus(conn);
  const patch = {
    status,
    updated_at: new Date().toISOString()
  };
  if (spinwheelRawResponseHasDebtProfileData(spinwheelBody)) {
    patch.raw_response = spinwheelBody && typeof spinwheelBody === "object" ? spinwheelBody : null;
    patch.spinwheel_debt_profile_raw = spinwheelBody;
  }
  const { data, error } = await supabaseAdmin
    .from("spinwheel_users")
    .update(patch)
    .eq("user_id", debtyaUserId)
    .eq("environment", environment)
    .eq("spinwheel_user_id", spinwheelUserId)
    .select(
      "id, user_id, spinwheel_user_id, environment, status, raw_response, spinwheel_debt_profile_raw, created_at, updated_at"
    )
    .maybeSingle();
  if (error) {
    return { updated: false, error: error.message || String(error) };
  }
  return { updated: !!data, row: data || null };
}

module.exports = {
  extractSpinwheelUserIdFromApiResponse,
  extractConnectionStatusFromApiResponse,
  mapConnectionStatusToRowStatus,
  getSpinwheelMappingForUser,
  upsertSpinwheelUserFromApiResponse,
  updateSpinwheelUserRawResponse
};
