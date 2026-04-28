const crypto = require("crypto");
const { createSpinwheelClient, spinwheelErrorMessageFromJson } = require("../lib/spinwheel-client");
const {
  readSpinwheelApiSecret,
  readSpinwheelEnv,
  readSpinwheelKeyStatus,
  isSpinwheelConfigured,
  readSpinwheelApiBaseUrl,
  readSpinwheelSecureApiBaseUrl,
  readSpinwheelWebhookSecret
} = require("../lib/spinwheel-env");
const {
  getSpinwheelMappingForUser,
  upsertSpinwheelUserFromApiResponse,
  updateSpinwheelUserRawResponse
} = require("../lib/spinwheel-users");
const { validateDebtCreatePayload } = require("../lib/validation");
const {
  importDebtsFromSpinwheelApi,
  spinwheelRawResponseHasDebtProfileData
} = require("../lib/spinwheel-debt-import");
const { createSpinwheelPaymentIntent } = require("../lib/spinwheel-payments");

function spinwheelInfo(req, ...parts) {
  const rid = req && req.requestId ? req.requestId : "-";
  console.log("[Spinwheel]", rid, ...parts);
}

function safeTimingEqualString(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function spinwheelFacingHttpMessage(error) {
  const mr = error && error.spinwheel_response;
  const parsed = mr && typeof mr === "object" ? spinwheelErrorMessageFromJson(mr) : null;
  if (parsed) return parsed;
  const m = error && error.message;
  return typeof m === "string" ? m : String(m || "");
}

/**
 * Asegura extUserId = usuario DebYa (Supabase). Evita que un cliente reutilice otro extUserId.
 */
function mergeExtUserIdForConnect(body, debtyaUserId) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  const incoming = b.extUserId != null ? String(b.extUserId).trim() : "";
  if (incoming && incoming !== String(debtyaUserId)) {
    const err = new Error("extUserId no coincide con la sesión");
    err.status = 400;
    err.code = "spinwheel_ext_user_mismatch";
    throw err;
  }
  b.extUserId = String(debtyaUserId);
  return b;
}

function assertSpinwheelUserIdParam(spinwheelUserId) {
  const id = String(spinwheelUserId || "").trim();
  if (!id) {
    const err = new Error("spinwheelUserId requerido");
    err.status = 400;
    throw err;
  }
  return id;
}

function registerSpinwheelRoutes(app, deps) {
  const { requireUser, jsonError, isUuid, appError, supabaseAdmin, safeNumber } = deps;

  let clientCache = { cacheKey: "", client: null };

  function getClient() {
    const secret = readSpinwheelApiSecret();
    if (!secret) return null;
    const apiBase = readSpinwheelApiBaseUrl();
    const secureBase = readSpinwheelSecureApiBaseUrl();
    const cacheKey = `${secret}|${apiBase}|${secureBase}`;
    if (clientCache.cacheKey !== cacheKey) {
      clientCache.cacheKey = cacheKey;
      clientCache.client = createSpinwheelClient({
        apiSecret: secret,
        apiBaseUrl: apiBase,
        secureApiBaseUrl: secureBase
      });
    }
    return clientCache.client;
  }

  async function resolveSpinwheelUserIdForRequest(req, res) {
    const env = readSpinwheelEnv();
    const p = String(req.params.spinwheelUserId || "").trim();
    if (p === "me") {
      const row = await getSpinwheelMappingForUser(supabaseAdmin, req.user.id, env);
      if (!row) {
        jsonError(res, 404, "Sin vínculo Spinwheel para este entorno", {
          code: "spinwheel_mapping_not_found",
          environment: env
        });
        return null;
      }
      return String(row.spinwheel_user_id);
    }
    if (!isUuid(p)) {
      jsonError(res, 400, "spinwheelUserId inválido (usa UUID o me)", {});
      return null;
    }
    const row = await getSpinwheelMappingForUser(supabaseAdmin, req.user.id, env);
    if (row && String(row.spinwheel_user_id) !== p) {
      jsonError(res, 403, "spinwheelUserId no coincide con tu vínculo guardado", {
        code: "spinwheel_user_id_forbidden"
      });
      return null;
    }
    return p;
  }

  async function persistSpinwheelResponse(req, spinwheelUserIdForUpdate, spinwheelBody) {
    const env = readSpinwheelEnv();
    try {
      const upserted = await upsertSpinwheelUserFromApiResponse(supabaseAdmin, {
        debtyaUserId: req.user.id,
        spinwheelBody,
        environment: env
      });
      if (upserted.upserted) {
        return { saved: true, mode: "upsert", row: upserted.row };
      }
      if (spinwheelUserIdForUpdate) {
        const updated = await updateSpinwheelUserRawResponse(supabaseAdmin, {
          debtyaUserId: req.user.id,
          spinwheelUserId: spinwheelUserIdForUpdate,
          spinwheelBody,
          environment: env
        });
        if (updated.error) {
          return { saved: false, mode: "update", error: updated.error };
        }
        if (updated.updated) {
          return { saved: true, mode: "update", row: updated.row };
        }
      }
      return {
        saved: false,
        mode: "skip",
        reason: upserted.reason || null,
        error: upserted.error || null
      };
    } catch (e) {
      spinwheelInfo(req, "persist.error", { message: e && e.message ? e.message : String(e) });
      return { saved: false, mode: "error", message: e && e.message ? String(e.message) : String(e) };
    }
  }

  app.get("/spinwheel/status", (_req, res) => {
    const configured = isSpinwheelConfigured();
    const st = readSpinwheelKeyStatus();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    return res.json({
      ok: true,
      spinwheel_configured: configured,
      spinwheel_key_source: st.key_source,
      spinwheel_env: configured ? readSpinwheelEnv() : null,
      spinwheel_api_base_host: configured ? new URL(readSpinwheelApiBaseUrl()).host : null,
      spinwheel_secure_base_host: configured ? new URL(readSpinwheelSecureApiBaseUrl()).host : null
    });
  });

  app.get("/spinwheel/me", requireUser, async (req, res) => {
    try {
      const env = readSpinwheelEnv();
      const row = await getSpinwheelMappingForUser(supabaseAdmin, req.user.id, env);
      if (!row) {
        return jsonError(res, 404, "Sin vínculo Spinwheel para este entorno", {
          code: "spinwheel_mapping_not_found",
          environment: env
        });
      }
      return res.json({ ok: true, environment: env, mapping: row });
    } catch (e) {
      appError("[Spinwheel] GET /spinwheel/me", e && e.message ? e.message : e);
      return jsonError(res, 500, "Error cargando vínculo Spinwheel", {
        details: e && e.message ? String(e.message) : String(e)
      });
    }
  });

  /**
   * Webhook entrante (configura la URL en Spinwheel apuntando a esta ruta en tu API pública).
   * Autenticación: cabecera `x-debtya-spinwheel-webhook` == SPINWHEEL_WEBHOOK_SECRET (obligatoria si el secreto está definido).
   */
  app.post("/spinwheel/webhook", (req, res) => {
    try {
      const expected = readSpinwheelWebhookSecret();
      if (!expected) {
        return jsonError(res, 503, "Webhook Spinwheel deshabilitado: define SPINWHEEL_WEBHOOK_SECRET", {
          hint: "Configura el mismo valor en la cabecera x-debtya-spinwheel-webhook para validar llamadas."
        });
      }
      const got = String(req.get("x-debtya-spinwheel-webhook") || "").trim();
      if (!got || !safeTimingEqualString(got, expected)) {
        return jsonError(res, 401, "Webhook no autorizado", {});
      }
      const body = req.body && typeof req.body === "object" ? req.body : {};
      spinwheelInfo(req, "webhook.event", {
        type: body.type || body.eventType || null,
        eventId: body.eventId || body.id || null
      });
      return res.status(200).json({ ok: true, received: true });
    } catch (e) {
      appError("[Spinwheel] webhook", e && e.message ? e.message : e);
      return jsonError(res, 500, "Error procesando webhook Spinwheel", {
        details: e && e.message ? String(e.message) : String(e)
      });
    }
  });

  function requireSpinwheelClient(res) {
    const c = getClient();
    if (!c) {
      jsonError(res, 503, "Spinwheel no configurado", { code: "spinwheel_not_configured" });
      return null;
    }
    return c;
  }

  app.post("/spinwheel/connect/sms", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    try {
      const body = mergeExtUserIdForConnect(req.body, req.user.id);
      const out = await client.requestDetailed("POST", "/v1/users/connect/sms", body, "default");
      const persist = await persistSpinwheelResponse(req, null, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      spinwheelInfo(req, "connect.sms.error", { message: spinwheelFacingHttpMessage(e) });
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel connect/sms falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/users/:spinwheelUserId/connect/sms/verify", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    const targetId = await resolveSpinwheelUserIdForRequest(req, res);
    if (!targetId) return undefined;
    try {
      const out = await client.requestDetailed(
        "POST",
        `/v1/users/${encodeURIComponent(targetId)}/connect/sms/verify`,
        req.body && typeof req.body === "object" ? req.body : {},
        "default"
      );
      const persist = await persistSpinwheelResponse(req, targetId, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel SMS verify falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/connect/kba", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    try {
      const body = mergeExtUserIdForConnect(req.body, req.user.id);
      const out = await client.requestDetailed("POST", "/v1/users/connect/kba", body, "secure");
      const persist = await persistSpinwheelResponse(req, null, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel connect/kba falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/users/:spinwheelUserId/connect/kba", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    const targetId = await resolveSpinwheelUserIdForRequest(req, res);
    if (!targetId) return undefined;
    try {
      const out = await client.requestDetailed(
        "POST",
        `/v1/users/${encodeURIComponent(targetId)}/connect/kba`,
        req.body && typeof req.body === "object" ? req.body : {},
        "secure"
      );
      const persist = await persistSpinwheelResponse(req, targetId, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel KBA (usuario) falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/users/:spinwheelUserId/debt-profile", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    const targetId = await resolveSpinwheelUserIdForRequest(req, res);
    if (!targetId) return undefined;
    try {
      const out = await client.requestDetailed(
        "POST",
        `/v1/users/${encodeURIComponent(targetId)}/debtProfile`,
        req.body && typeof req.body === "object" ? req.body : {},
        "default"
      );
      const persist = await persistSpinwheelResponse(req, targetId, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel debtProfile falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/users/:spinwheelUserId/liabilities/refresh", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    const targetId = await resolveSpinwheelUserIdForRequest(req, res);
    if (!targetId) return undefined;
    try {
      const out = await client.requestDetailed(
        "POST",
        `/v1/users/${encodeURIComponent(targetId)}/liabilities/refresh`,
        req.body && typeof req.body === "object" ? req.body : {},
        "default"
      );
      const persist = await persistSpinwheelResponse(req, targetId, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel liabilities/refresh falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.get("/spinwheel/users/:spinwheelUserId/liabilities/refresh/:extRequestId", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    const targetId = await resolveSpinwheelUserIdForRequest(req, res);
    if (!targetId) return undefined;
    const extRequestId = assertSpinwheelUserIdParam(req.params.extRequestId);
    if (!isUuid(extRequestId)) {
      return jsonError(res, 400, "extRequestId debe ser UUID", {});
    }
    try {
      const out = await client.requestDetailed(
        "GET",
        `/v1/users/${encodeURIComponent(targetId)}/liabilities/refresh/${encodeURIComponent(extRequestId)}`,
        undefined,
        "default"
      );
      const persist = await persistSpinwheelResponse(req, targetId, out.body);
      return res.status(out.status).json({ ok: true, spinwheel: out.body, mapping_persist: persist });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel liabilities refresh status falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/credit-cards/brands", requireUser, async (req, res) => {
    const client = requireSpinwheelClient(res);
    if (!client) return undefined;
    try {
      const out = await client.requestDetailed(
        "POST",
        "/v1/creditCards/brands",
        req.body && typeof req.body === "object" ? req.body : {},
        "secure"
      );
      return res.status(out.status).json({ ok: true, spinwheel: out.body });
    } catch (e) {
      const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 502;
      return jsonError(res, status, "Spinwheel creditCards/brands falló", {
        details: spinwheelFacingHttpMessage(e),
        spinwheel_http_status: e.spinwheel_http_status || null
      });
    }
  });

  app.post("/spinwheel/prepare-payment", requireUser, async (req, res) => {
    const env = readSpinwheelEnv();
    try {
      const intentId =
        req.body && req.body.intent_id != null
          ? String(req.body.intent_id).trim()
          : req.body && req.body.intentId != null
            ? String(req.body.intentId).trim()
            : "";
      if (!intentId || !isUuid(intentId)) {
        return jsonError(res, 400, "intent_id inválido o faltante", { code: "intent_id_invalid" });
      }

      const { data: intent, error: intentErr } = await supabaseAdmin
        .from("payment_intents")
        .select("*")
        .eq("id", intentId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (intentErr) throw intentErr;
      if (!intent) {
        return jsonError(res, 404, "Intent no encontrado", { code: "intent_not_found" });
      }

      if (String(intent.source || "").toLowerCase() !== "spinwheel") {
        return jsonError(res, 400, "Solo intents con source spinwheel", { code: "intent_not_spinwheel" });
      }

      const extId = String(intent.external_id || "").trim();
      if (!extId) {
        return jsonError(res, 400, "Intent Spinwheel sin external_id (liability)", {
          code: "spinwheel_intent_missing_external_id"
        });
      }

      const mapping = await getSpinwheelMappingForUser(supabaseAdmin, req.user.id, env);
      if (!mapping || !mapping.spinwheel_user_id) {
        return jsonError(res, 404, "Sin vínculo Spinwheel para este entorno", {
          code: "spinwheel_mapping_not_found",
          environment: env
        });
      }

      const { payload_preview } = createSpinwheelPaymentIntent(intent, {
        debtyaUserId: req.user.id,
        spinwheelUserId: String(mapping.spinwheel_user_id),
        safeNumber
      });

      spinwheelInfo(req, "prepare-payment.ok", { intent_id: intentId });
      return res.json({ ok: true, prepared: true, payload_preview });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      spinwheelInfo(req, "prepare-payment.error", { message: msg });
      return jsonError(res, 500, "Error preparando pago Spinwheel", { details: msg });
    }
  });

  app.post("/spinwheel/import-debts", requireUser, async (req, res) => {
    const env = readSpinwheelEnv();
    try {
      const mapping = await getSpinwheelMappingForUser(supabaseAdmin, req.user.id, env);
      if (!mapping || !mapping.spinwheel_user_id) {
        return jsonError(res, 404, "Sin vínculo Spinwheel para este entorno", {
          code: "spinwheel_mapping_not_found",
          environment: env
        });
      }
      const useCachedDebtProfile =
        spinwheelRawResponseHasDebtProfileData(mapping.spinwheel_debt_profile_raw) ||
        spinwheelRawResponseHasDebtProfileData(mapping.raw_response);
      let client = null;
      if (!useCachedDebtProfile) {
        client = requireSpinwheelClient(res);
        if (!client) return undefined;
      }
      const summary = await importDebtsFromSpinwheelApi(supabaseAdmin, {
        debtyaUserId: req.user.id,
        spinwheelUserId: String(mapping.spinwheel_user_id),
        client,
        cachedSpinwheelDebtProfileRaw: mapping.spinwheel_debt_profile_raw,
        cachedRawResponse: mapping.raw_response,
        safeNumber,
        validateDebtCreatePayload
      });
      if (!summary.ok) {
        return jsonError(res, 502, summary.error || "Import Spinwheel falló", { details: summary });
      }
      return res.json({ ok: true, ...summary });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      spinwheelInfo(req, "import-debts.error", { message: msg });
      if (
        /spinwheel_external_id|spinwheel_debt_profile_raw|uq_debts_user_source_spinwheel|unique constraint|duplicate key|column|does not exist|schema cache/i.test(
          msg
        )
      ) {
        return jsonError(res, 503, "Falta migración SQL en Supabase (debts / spinwheel_users Spinwheel)", {
          details: msg
        });
      }
      return jsonError(res, 500, "Error importando deudas Spinwheel", { details: msg });
    }
  });
}

module.exports = { registerSpinwheelRoutes };
