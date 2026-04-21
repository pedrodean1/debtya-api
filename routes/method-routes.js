const { createMethodClient, computePaymentCapable, methodErrorMessageFromJson } = require("../lib/method-client");
const { readMethodApiKey, readMethodEnv, readMethodApiVersion, isMethodConfigured, readMethodKeyStatus } = require("../lib/method-env");

function methodInfo(req, ...parts) {
  const rid = req && req.requestId ? req.requestId : "-";
  console.log("[Method]", rid, ...parts);
}

function methodFacingHttpMessage(error) {
  const mr = error && error.method_response;
  const parsed = mr && typeof mr === "object" ? methodErrorMessageFromJson(mr) : null;
  if (parsed) return parsed;
  if (mr && typeof mr === "object") {
    const legacy =
      mr.message ||
      mr.error ||
      (typeof mr.error === "object" && mr.error?.message ? String(mr.error.message) : null);
    if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  }
  const m = error && error.message;
  return typeof m === "string" ? m : String(m || "");
}

function methodLiabilityToDebtType(liability) {
  const t = String((liability && liability.type) || "").toLowerCase();
  if (t.includes("credit_card") || t === "credit_card") return "credit_card";
  if (t.includes("student")) return "loan";
  if (t.includes("mortgage") || t.includes("loan")) return "loan";
  return "other";
}

function debtNameFromMethodAccount(acc) {
  const li = acc && acc.liability ? acc.liability : null;
  const name = li && li.name ? String(li.name).trim() : "";
  if (name) return name;
  const mask = li && li.mask ? String(li.mask).trim() : "";
  if (mask) return `Deuda · ****${mask}`;
  return "Deuda Method";
}

function summarizeEntityPayload(payload) {
  const i = payload && payload.individual && typeof payload.individual === "object" ? payload.individual : {};
  const a = payload && payload.address && typeof payload.address === "object" ? payload.address : null;
  return {
    type: payload && payload.type ? String(payload.type) : null,
    has_first_name: !!(i.first_name && String(i.first_name).trim()),
    has_last_name: !!(i.last_name && String(i.last_name).trim()),
    has_phone: !!(i.phone && String(i.phone).trim()),
    has_email: !!(i.email && String(i.email).trim()),
    has_dob: !!(i.dob && String(i.dob).trim()),
    has_address: !!a
  };
}

function pruneEmptyObjectFields(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === "string" && !String(v).trim()) continue;
    out[k] = v;
  }
  return out;
}

function looksLikeMethodEntityId(s) {
  const v = String(s || "").trim();
  return /^ent_[A-Za-z0-9]+$/.test(v);
}

function safeJsonPreview(obj, maxLen) {
  const n = Math.max(200, Number(maxLen) || 8000);
  try {
    const s = JSON.stringify(obj);
    if (s.length <= n) return s;
    return `${s.slice(0, n)}…(truncated,len=${s.length})`;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Columna de `debts` ausente según Postgres o PostgREST (varios formatos de mensaje).
 */
function extractMissingDebtsColumnName(err) {
  const msg = String(err?.message || err?.details || err?.hint || err || "");
  let m = msg.match(/column\s+(?:"?[\w]+\.)?(\w+)\s+does\s+not\s+exist/i);
  if (m) return m[1].toLowerCase();
  m = msg.match(/could\s+not\s+find\s+the\s+'(\w+)'\s+column\s+of\s+'debts'/i);
  if (m) return m[1].toLowerCase();
  m = msg.match(/could\s+not\s+find\s+the\s+"(\w+)"\s+column\s+of\s+"debts"/i);
  if (m) return m[1].toLowerCase();
  m = msg.match(/'(\w+)'\s+column\s+of\s+'debts'\s+in\s+the\s+schema\s+cache/i);
  if (m) return m[1].toLowerCase();
  m = msg.match(/column\s+'(\w+)'\s+is\s+not\s+present\s+in\s+schema\s+cache/i);
  if (m) return m[1].toLowerCase();
  return null;
}

/**
 * Actualiza debts tolerando columnas ausentes (esquemas viejos).
 * @returns {{ methodRows: number, stripRows: number }}
 */
async function unlinkDebtsFromMethodForReset(supabaseAdmin, userId, now, isMissingTableColumnError, methodInfo, req) {
  const stripColFromPatch = (patch, col) => {
    if (!col || !patch || typeof patch !== "object") return patch;
    const next = { ...patch };
    delete next[col];
    return next;
  };

  async function updateDebtsAdaptive(initialPatch, build) {
    let patch = { ...initialPatch };
    for (let i = 0; i < 14; i += 1) {
      const q0 = supabaseAdmin.from("debts").update(patch);
      const { data, error } = await build(q0);
      if (!error) {
        methodInfo(req, "reset.debts_update_ok", {
          attempt: i,
          patch_keys: Object.keys(patch)
        });
        return { data: Array.isArray(data) ? data : [], error: null };
      }
      const col = extractMissingDebtsColumnName(error);
      methodInfo(req, "reset.debts_update_error", {
        attempt: i,
        patch_keys: Object.keys(patch),
        missing_column: col,
        message_preview: String(error?.message || "").slice(0, 220)
      });
      if (col && Object.prototype.hasOwnProperty.call(patch, col)) {
        patch = stripColFromPatch(patch, col);
        const keys = Object.keys(patch).filter((k) => k !== "updated_at");
        if (keys.length === 0) return { data: [], error: null };
        continue;
      }
      return { data: [], error };
    }
    return { data: [], error: new Error("debts: demasiados reintentos al adaptar columnas") };
  }

  let nMethod = 0;
  const fullPatch = {
    source: "manual",
    method_account_id: null,
    method_entity_id: null,
    payment_capable: false,
    updated_at: now
  };
  let r1 = await updateDebtsAdaptive(fullPatch, (q) => q.eq("user_id", userId).eq("source", "method").select("id"));
  if (r1.error && isMissingTableColumnError(r1.error, "debts", "source")) {
    const fallbackPatch = stripColFromPatch(fullPatch, "source");
    r1 = await updateDebtsAdaptive(fallbackPatch, (q) =>
      q.eq("user_id", userId).not("method_account_id", "is", null).select("id")
    );
    if (r1.error && extractMissingDebtsColumnName(r1.error) === "method_account_id") {
      r1 = { data: [], error: null };
    }
  }
  if (r1.error) {
    methodInfo(req, "reset.debts_method_phase_skipped", { message: r1.error.message });
    r1 = { data: [], error: null };
  }
  nMethod = r1.data.length;

  const colsPatch = {
    method_account_id: null,
    method_entity_id: null,
    payment_capable: false,
    updated_at: now
  };

  const stripBuilders = [
    (q) => q.eq("user_id", userId).not("method_account_id", "is", null).select("id"),
    (q) => q.eq("user_id", userId).not("method_entity_id", "is", null).select("id"),
    (q) => q.eq("user_id", userId).or("method_entity_id.not.is.null,method_account_id.not.is.null").select("id")
  ];
  let nStrip = 0;
  let lastStripErr = null;
  for (let si = 0; si < stripBuilders.length; si += 1) {
    const rTry = await updateDebtsAdaptive(colsPatch, stripBuilders[si]);
    if (!rTry.error) nStrip += rTry.data.length;
    else {
      lastStripErr = rTry.error;
      methodInfo(req, "reset.debts_strip_try", { index: si, message: rTry.error.message });
    }
  }
  if (lastStripErr && nStrip === 0) {
    methodInfo(req, "reset.debts_strip_all_variants_failed", { message: lastStripErr.message });
  }

  return { methodRows: nMethod, stripRows: nStrip };
}

async function unlinkDebtsFromMethodForResetSafe(supabaseAdmin, userId, now, isMissingTableColumnError, methodInfo, req) {
  try {
    return await unlinkDebtsFromMethodForReset(
      supabaseAdmin,
      userId,
      now,
      isMissingTableColumnError,
      methodInfo,
      req
    );
  } catch (e) {
    methodInfo(req, "reset.debts_unlink_exception", { message: e && e.message ? String(e.message) : String(e) });
    return { methodRows: 0, stripRows: 0 };
  }
}

function extractMethodEntityId(input) {
  if (!input || typeof input !== "object") return null;
  const tryId = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  };
  const direct = tryId(input.id);
  if (direct && looksLikeMethodEntityId(direct)) return direct;
  const alt = tryId(input.entity_id || input.entityId);
  if (alt && looksLikeMethodEntityId(alt)) return alt;

  const candidates = [input.data, input.entity, input.result, input.response, input.record, input.resource, input.payload];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const id1 = tryId(c.id);
    if (id1 && looksLikeMethodEntityId(id1)) return id1;
    const id2 = tryId(c.entity_id || c.entityId);
    if (id2 && looksLikeMethodEntityId(id2)) return id2;
    if (c.entity && typeof c.entity === "object") {
      const id3 = tryId(c.entity.id);
      if (id3 && looksLikeMethodEntityId(id3)) return id3;
    }
    if (c.data && typeof c.data === "object") {
      const id4 = tryId(c.data.id);
      if (id4 && looksLikeMethodEntityId(id4)) return id4;
    }
  }
  if (Array.isArray(input.data) && input.data[0]) {
    const row = input.data[0];
    if (row && typeof row === "object") {
      const id5 = tryId(row.id);
      if (id5 && looksLikeMethodEntityId(id5)) return id5;
      if (id5) return id5;
    }
  }
  const seen = new Set();
  function scanForEntId(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 8) return null;
    if (seen.has(obj)) return null;
    seen.add(obj);
    const idH = tryId(obj.id);
    if (idH && looksLikeMethodEntityId(idH)) return idH;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && looksLikeMethodEntityId(v)) return v.trim();
      if (v && typeof v === "object") {
        const hit = scanForEntId(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
  const scanned = scanForEntId(input, 0);
  if (scanned) return scanned;
  if (direct) return direct;
  return null;
}

function registerMethodRoutes(app, deps) {
  const { requireUser, supabaseAdmin, jsonError, appError, safeNumber, isUuid, isMissingTableColumnError } = deps;

  let methodClientCache = { cacheKey: "", client: null };

  function getClient() {
    const apiKey = readMethodApiKey();
    if (!apiKey) return null;
    const methodEnv = readMethodEnv();
    const apiVersion = readMethodApiVersion();
    const cacheKey = `${apiKey}|${methodEnv}|${apiVersion}`;
    if (methodClientCache.cacheKey !== cacheKey) {
      methodClientCache.cacheKey = cacheKey;
      methodClientCache.client = createMethodClient({
        apiKey,
        methodEnv,
        apiVersion
      });
    }
    return methodClientCache.client;
  }

  app.get("/method/status", (_req, res) => {
    const configured = isMethodConfigured();
    const methodStatus = readMethodKeyStatus();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    return res.json({
      ok: true,
      has_method_api_key: methodStatus.configured,
      method_key_source: methodStatus.key_source,
      method_configured: configured,
      method_env: configured ? readMethodEnv() : null,
      method_api_version: configured ? readMethodApiVersion() : null
    });
  });

  async function resolveEntityRow(userId, entityRef) {
    if (!entityRef) {
      const { data, error } = await supabaseAdmin
        .from("method_entities")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data && data[0]) || null;
    }
    const ref = String(entityRef).trim();
    if (ref.startsWith("ent_")) {
      const { data, error } = await supabaseAdmin
        .from("method_entities")
        .select("*")
        .eq("user_id", userId)
        .eq("method_entity_id", ref)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
    if (isUuid(ref)) {
      const { data, error } = await supabaseAdmin
        .from("method_entities")
        .select("*")
        .eq("user_id", userId)
        .eq("id", ref)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
    return null;
  }

  app.get("/method/entities", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("method_entities")
        .select("id, method_entity_id, environment, status, connect_last_status, connect_last_id, created_at, updated_at")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.json({ ok: true, data: data || [] });
    } catch (error) {
      appError("[Method] GET /method/entities", req.requestId || null, error.message);
      return jsonError(res, 500, "Error cargando entidades Method", { details: error.message });
    }
  });

  app.post("/method/entities/reset", requireUser, async (req, res) => {
    const userId = req.user.id;
    try {
      methodInfo(req, "reset.start", { user_id: userId });
      const now = new Date().toISOString();
      const { methodRows: nMethodDebts, stripRows: nStripDebts } = await unlinkDebtsFromMethodForResetSafe(
        supabaseAdmin,
        userId,
        now,
        isMissingTableColumnError,
        methodInfo,
        req
      );
      methodInfo(req, "reset.debts_phase_counts", {
        method_debt_rows: nMethodDebts,
        strip_debt_rows: nStripDebts
      });

      const { error: delSessErr } = await supabaseAdmin.from("method_connect_sessions").delete().eq("user_id", userId);
      if (delSessErr) throw delSessErr;

      const { error: delAcctErr } = await supabaseAdmin.from("method_accounts").delete().eq("user_id", userId);
      if (delAcctErr) throw delAcctErr;

      const { data: removedEntities, error: delEntErr } = await supabaseAdmin
        .from("method_entities")
        .delete()
        .eq("user_id", userId)
        .select("id, method_entity_id");
      if (delEntErr) throw delEntErr;

      const { error: payErr } = await supabaseAdmin.from("method_payments").delete().eq("user_id", userId);
      if (payErr && !String(payErr.message || "").toLowerCase().includes("relation") && !String(payErr.message || "").toLowerCase().includes("does not exist")) {
        appError("[Method] reset method_payments delete", req.requestId || null, payErr.message);
      }

      const nEnt = Array.isArray(removedEntities) ? removedEntities.length : 0;
      const debtsTouched = nMethodDebts + nStripDebts;
      methodInfo(req, "reset.done", {
        user_id: userId,
        removed_entities: nEnt,
        debts_unlinked_or_stripped: debtsTouched
      });
      return res.json({
        ok: true,
        data: {
          removed_entities: nEnt,
          removed_method_entity_ids: (removedEntities || []).map((r) => r.method_entity_id).filter(Boolean),
          debts_unlinked: debtsTouched,
          reset_debts_adapter: "v3-schema-cache"
        }
      });
    } catch (error) {
      appError("[Method] POST /method/entities/reset", req.requestId || null, error.message);
      return jsonError(res, 500, "No se pudo limpiar Method en tu cuenta", { details: error.message });
    }
  });

  app.post("/method/entities", requireUser, async (req, res) => {
    const mc = getClient();
    if (!mc) {
      return jsonError(res, 503, "Method no está configurado en el servidor", { code: "method_not_configured" });
    }
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const individual = body.individual && typeof body.individual === "object" ? body.individual : {};
      const address = body.address && typeof body.address === "object" ? body.address : undefined;

      const individualRaw = {
        first_name: individual.first_name != null ? String(individual.first_name).trim() : null,
        last_name: individual.last_name != null ? String(individual.last_name).trim() : null,
        phone: individual.phone != null ? String(individual.phone).trim() : null,
        email: individual.email != null ? String(individual.email).trim() : null,
        dob: individual.dob != null ? String(individual.dob).trim() : null
      };
      const individualClean = pruneEmptyObjectFields(individualRaw);
      const payload = {
        type: "individual",
        individual: individualClean,
        ...(address ? { address: pruneEmptyObjectFields(address) } : {})
      };

      methodInfo(req, "create_entity.request", summarizeEntityPayload(payload));
      const created = await mc.createIndividualEntityDetailed(payload);
      const entity = created ? created.body : null;
      const methodEntityId = extractMethodEntityId(entity);
      const rawPreview =
        created && typeof created.rawBody === "string" ? String(created.rawBody).slice(0, 800) : null;
      methodInfo(
        req,
        "create_entity.response",
        {
          http_status: created ? created.status : null,
          body_type: entity === null ? "null" : Array.isArray(entity) ? "array" : typeof entity,
          top_level_keys: entity && typeof entity === "object" ? Object.keys(entity).slice(0, 25) : [],
          detected_entity_id: methodEntityId,
          raw_body_preview: rawPreview
        }
      );
      methodInfo(req, "create_entity.parsed_json", safeJsonPreview(entity, 16000));
      if (created && typeof created.rawBody === "string" && created.rawBody.length) {
        methodInfo(req, "create_entity.method_raw_body", String(created.rawBody).slice(0, 16000));
      }
      if (!methodEntityId) {
        appError(
          "[Method] create_entity sin id usable",
          req.requestId || null,
          safeJsonPreview(
            {
              http_status: created ? created.status : null,
              parsed_body_keys: entity && typeof entity === "object" ? Object.keys(entity) : [],
              parsed_body: entity,
              raw_body_head: created && typeof created.rawBody === "string" ? created.rawBody.slice(0, 16000) : null
            },
            20000
          )
        );
        const st = created ? created.status : null;
        return jsonError(res, 502, "Method respondió sin un entity id usable", {
          method_http_status: st,
          details: `La respuesta no trae un id de entidad reconocible (se espera ent_* en id, entity_id o anidados comunes).${st != null ? ` Method HTTP ${st}.` : ""}`
        });
      }

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("method_entities")
        .insert({
          user_id: req.user.id,
          method_entity_id: methodEntityId,
          environment: readMethodEnv(),
          status: entity.status || null,
          metadata: { last_create_response: entity },
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (insErr) {
        appError("[Method] insert method_entities", req.requestId || null, insErr.message);
        return jsonError(res, 500, "No se pudo guardar la entidad Method en base de datos", {
          details: insErr.message,
          hint: "Ejecuta sql/method_debtya_hybrid.sql en Supabase si faltan tablas."
        });
      }

      methodInfo(req, "entity_created", methodEntityId);
      return res.json({ ok: true, data: { row: inserted, method: entity } });
    } catch (error) {
      const status = error.status && Number(error.status) >= 400 ? Number(error.status) : 502;
      const rawPrev =
        error.method_raw_body && typeof error.method_raw_body === "string"
          ? String(error.method_raw_body).slice(0, 16000)
          : null;
      const respDump =
        error.method_response && typeof error.method_response === "object"
          ? safeJsonPreview(error.method_response, 12000)
          : null;
      methodInfo(req, "create_entity.method_http_error", {
        method_http_status: error.method_http_status || error.status || null,
        message: error.message,
        raw_body_preview: rawPrev,
        method_response_json: respDump
      });
      appError(
        "[Method] POST /method/entities fallo",
        req.requestId || null,
        error.message,
        {
          method_http_status: error.method_http_status || error.status || null,
          method_keys:
            error.method_response && typeof error.method_response === "object"
              ? Object.keys(error.method_response).slice(0, 40)
              : [],
          raw_body_preview: rawPrev,
          method_response_json: respDump
        }
      );
      const clientDetails = methodFacingHttpMessage(error);
      const mst = error.method_http_status || error.status || null;
      const detailStr = typeof clientDetails === "string" ? clientDetails : JSON.stringify(clientDetails);
      return jsonError(res, status >= 500 ? 502 : status, "Error creando entidad Method", {
        details: mst != null ? `${detailStr} (Method HTTP ${mst})` : detailStr,
        method_http_status: mst
      });
    }
  });

  app.post("/method/entities/:entityRef/connect", requireUser, async (req, res) => {
    const mc = getClient();
    if (!mc) {
      return jsonError(res, 503, "Method no está configurado en el servidor", { code: "method_not_configured" });
    }
    try {
      const row = await resolveEntityRow(req.user.id, req.params.entityRef);
      if (!row || !row.method_entity_id) {
        return jsonError(res, 404, "Entidad Method no encontrada para este usuario");
      }
      const methodEntityId = String(row.method_entity_id).trim();
      const entityPath = `/entities/${encodeURIComponent(methodEntityId)}`;
      const entityUrl = `${mc.baseUrl}${entityPath}`;
      try {
        const entityBody = await mc.getEntity(methodEntityId);
        methodInfo(req, "connect.entity_probe_ok", {
          method_http: `GET ${entityUrl}`,
          method_entity_id: methodEntityId,
          top_keys: entityBody && typeof entityBody === "object" ? Object.keys(entityBody).slice(0, 20) : []
        });
      } catch (probeErr) {
        const pmst = probeErr.method_http_status || probeErr.status || null;
        const rawPrev =
          probeErr.method_raw_body && typeof probeErr.method_raw_body === "string"
            ? String(probeErr.method_raw_body).slice(0, 4000)
            : null;
        const pdetails = methodFacingHttpMessage(probeErr);
        const pdump =
          probeErr.method_response && typeof probeErr.method_response === "object"
            ? safeJsonPreview(probeErr.method_response, 8000)
            : null;
        methodInfo(req, "connect.entity_probe_failed", {
          method_http_status: pmst,
          method_http: `GET ${entityUrl}`,
          message: probeErr.message,
          method_response_json: pdump,
          raw_body_preview: rawPrev
        });
        appError("[Method] GET entity antes de Connect fallo", req.requestId || null, probeErr.message, {
          method_http_status: pmst,
          method_response_json: pdump,
          raw_body_preview: rawPrev
        });
        const pstatus =
          probeErr.status && Number(probeErr.status) >= 400 && Number(probeErr.status) < 600
            ? Number(probeErr.status)
            : 502;
        const detailLine = pmst != null ? `${pdetails} (Method HTTP ${pmst})` : pdetails;
        return jsonError(res, pstatus >= 500 ? 502 : pstatus, "Method rechazó la entidad antes de Connect", {
          details: `${detailLine}. Si es 401, la clave o el entorno no coinciden con Method; si es 404, el ent_ no existe en ese entorno.`,
          method_http_status: pmst,
          method_env: readMethodEnv(),
          method_api_version: readMethodApiVersion(),
          probe: "GET /entities/:id"
        });
      }
      const connectPath = `/entities/${encodeURIComponent(methodEntityId)}/connect`;
      const connectUrl = `${mc.baseUrl}${connectPath}`;
      methodInfo(req, "connect.request", {
        method_http: `POST ${connectUrl}`,
        method_entity_id: methodEntityId,
        method_env: readMethodEnv(),
        method_api_version: mc.apiVersion,
        outbound_payload: "{}"
      });
      const detailed = await mc.createConnectDetailed(methodEntityId);
      const connect = detailed.body;
      methodInfo(req, "connect.method_response", {
        http_status: detailed.status,
        body_keys: connect && typeof connect === "object" ? Object.keys(connect).slice(0, 40) : [],
        connect_id: connect && connect.id ? String(connect.id) : null,
        connect_status: connect && connect.status ? String(connect.status) : null,
        has_element_token: !!(connect && (connect.element_token || connect.token)),
        has_url_field: !!(connect && (connect.url || connect.connect_url || connect.link))
      });
      methodInfo(req, "connect.method_raw_body", String(detailed.rawBody || "").slice(0, 16000));

      const { error: upErr } = await supabaseAdmin
        .from("method_entities")
        .update({
          connect_last_id: connect && connect.id ? String(connect.id) : null,
          connect_last_status: connect && connect.status ? String(connect.status) : null,
          updated_at: new Date().toISOString()
        })
        .eq("id", row.id)
        .eq("user_id", req.user.id);

      if (upErr) appError("[Method] update method_entities connect", req.requestId || null, upErr.message);

      const { error: logErr } = await supabaseAdmin.from("method_connect_sessions").insert({
        user_id: req.user.id,
        method_entity_id: methodEntityId,
        method_connect_id: connect && connect.id ? String(connect.id) : "unknown",
        status: connect && connect.status ? String(connect.status) : null,
        account_ids: connect && Array.isArray(connect.accounts) ? connect.accounts : null,
        error: connect && connect.error ? connect.error : null
      });
      if (logErr) appError("[Method] log method_connect_sessions", req.requestId || null, logErr.message);

      methodInfo(req, "connect_ran", methodEntityId, connect && connect.status);
      return res.json({ ok: true, data: connect });
    } catch (error) {
      const mst = error.method_http_status || error.status || null;
      const rawPrev =
        error.method_raw_body && typeof error.method_raw_body === "string"
          ? String(error.method_raw_body).slice(0, 4000)
          : null;
      const clientDetails = methodFacingHttpMessage(error);
      const detailStr = typeof clientDetails === "string" ? clientDetails : JSON.stringify(clientDetails);
      const respDump =
        error.method_response && typeof error.method_response === "object"
          ? safeJsonPreview(error.method_response, 12000)
          : null;
      methodInfo(req, "connect.method_error", {
        method_http_status: mst,
        message: error.message,
        method_response_json: respDump,
        raw_body_preview: rawPrev
      });
      appError("[Method] POST connect fallo", req.requestId || null, error.message, {
        method_http_status: mst,
        method_response_json: respDump,
        raw_body_preview: rawPrev
      });
      const low = String(detailStr || "").toLowerCase();
      let hint = "";
      if (low.includes("consent") && low.includes("unavailable")) {
        hint =
          " Revisa en dashboard.methodfi.com que tu organizacion tenga habilitado Connect (consentimiento de cuentas / liabilities) para el mismo entorno (sandbox/production) y API version que usa esta app.";
      } else if (mst === 401 && low.includes("authorization") && low.includes("invalid")) {
        hint =
          " Comprueba que METHOD_API_KEY en Render sea solo el valor sk_… (sin prefijo Bearer). Si GET /entities ya funcionaba en logs y Connect sigue en 401, abre ticket con Method con el request_id.";
      }
      const status =
        error.status && Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 502;
      return jsonError(res, status >= 500 ? 502 : status, "Error ejecutando Method Connect", {
        details: (mst != null ? `${detailStr} (Method HTTP ${mst})` : detailStr) + hint,
        method_http_status: mst,
        method_env: readMethodEnv(),
        method_api_version: readMethodApiVersion()
      });
    }
  });

  app.post("/method/accounts/sync", requireUser, async (req, res) => {
    const mc = getClient();
    if (!mc) {
      return jsonError(res, 503, "Method no está configurado en el servidor", { code: "method_not_configured" });
    }
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const row = await resolveEntityRow(req.user.id, body.method_entity_id || body.entity_ref || null);
      if (!row || !row.method_entity_id) {
        return jsonError(res, 404, "Entidad Method no encontrada. Crea una entidad primero.");
      }

      const syncQuery = { page_limit: 100 };
      methodInfo(req, "sync_accounts.request", {
        endpoint: "GET /accounts",
        holder_id: row.method_entity_id,
        query: { holder_id: row.method_entity_id, type: "liability", page_limit: syncQuery.page_limit }
      });
      const listed = await mc.listLiabilityAccounts(row.method_entity_id, syncQuery);
      const rows = listed && Array.isArray(listed.data) ? listed.data : [];
      methodInfo(req, "sync_accounts.method_response", {
        holder_id: row.method_entity_id,
        account_count: rows.length
      });

      const now = new Date().toISOString();
      let upserted = 0;
      for (const acc of rows) {
        if (!acc || !acc.id) continue;
        const payCap = computePaymentCapable(acc);
        const { error: upErr } = await supabaseAdmin.from("method_accounts").upsert(
          {
            user_id: req.user.id,
            method_entity_id: row.method_entity_id,
            method_account_id: String(acc.id),
            holder_id: acc.holder_id || row.method_entity_id,
            status: acc.status || null,
            account_type: acc.type || "liability",
            liability: acc.liability || null,
            products: acc.products || null,
            payment_capable: payCap,
            raw_snapshot: acc,
            last_synced_at: now,
            updated_at: now
          },
          { onConflict: "method_account_id" }
        );
        if (upErr) {
          if (isMissingTableColumnError && isMissingTableColumnError(upErr, "method_accounts", "method_account_id")) {
            return jsonError(res, 500, "Faltan tablas Method en Supabase", {
              details: upErr.message,
              hint: "Ejecuta sql/method_debtya_hybrid.sql"
            });
          }
          throw upErr;
        }
        upserted += 1;
      }

      methodInfo(req, "sync_accounts", row.method_entity_id, `count=${upserted}`);
      return res.json({ ok: true, data: { synced: upserted, method_entity_id: row.method_entity_id } });
    } catch (error) {
      const mst = error.method_http_status || error.status || null;
      const rawPrev =
        error.method_raw_body && typeof error.method_raw_body === "string"
          ? String(error.method_raw_body).slice(0, 4000)
          : null;
      const clientDetails = methodFacingHttpMessage(error);
      const detailStr = typeof clientDetails === "string" ? clientDetails : JSON.stringify(clientDetails);
      methodInfo(req, "sync_accounts.method_error", {
        method_http_status: mst,
        message: error.message,
        raw_body_preview: rawPrev
      });
      appError("[Method] POST /method/accounts/sync", req.requestId || null, error.message, {
        method_http_status: mst,
        raw_body_preview: rawPrev
      });
      const status =
        error.status && Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 502;
      return jsonError(res, status >= 500 ? 502 : status, "Error sincronizando cuentas Method", {
        details: mst != null ? `${detailStr} (Method HTTP ${mst})` : detailStr,
        method_http_status: mst
      });
    }
  });

  app.get("/method/accounts", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("method_accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return res.json({ ok: true, data: data || [] });
    } catch (error) {
      appError("[Method] GET /method/accounts", req.requestId || null, error.message);
      return jsonError(res, 500, "Error listando cuentas Method", { details: error.message });
    }
  });

  app.patch("/method/accounts/:methodAccountId", requireUser, async (req, res) => {
    try {
      const methodAccountId = String(req.params.methodAccountId || "").trim();
      if (!methodAccountId) {
        return jsonError(res, 400, "method_account_id inválido");
      }
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.payment_capable === undefined) {
        return jsonError(res, 400, "Indica payment_capable (true/false)");
      }
      const pc = body.payment_capable;
      const payment_capable = pc === true || pc === "true";
      const { data, error } = await supabaseAdmin
        .from("method_accounts")
        .update({
          payment_capable,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", req.user.id)
        .eq("method_account_id", methodAccountId)
        .select()
        .single();
      if (error) throw error;
      if (!data) {
        return jsonError(res, 404, "Cuenta Method no encontrada");
      }
      return res.json({ ok: true, data });
    } catch (error) {
      appError("[Method] PATCH /method/accounts", req.requestId || null, error.message);
      return jsonError(res, 500, "Error actualizando cuenta Method", { details: error.message });
    }
  });

  app.post("/method/import-debt", requireUser, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const methodAccountId = String(body.method_account_id || "").trim();
      if (!methodAccountId) {
        return jsonError(res, 400, "method_account_id es obligatorio");
      }

      const { data: ma, error: maErr } = await supabaseAdmin
        .from("method_accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("method_account_id", methodAccountId)
        .maybeSingle();
      if (maErr) throw maErr;
      if (!ma) {
        return jsonError(res, 404, "Cuenta Method no encontrada; sincroniza primero.");
      }

      if (ma.imported_debt_id && isUuid(String(ma.imported_debt_id))) {
        const { data: existing, error: exErr } = await supabaseAdmin
          .from("debts")
          .select("*")
          .eq("user_id", req.user.id)
          .eq("id", ma.imported_debt_id)
          .maybeSingle();
        if (!exErr && existing) {
          return res.json({ ok: true, data: existing, reused: true });
        }
      }

      const { data: dup, error: dupErr } = await supabaseAdmin
        .from("debts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("method_account_id", methodAccountId)
        .eq("is_active", true)
        .maybeSingle();
      if (dupErr) throw dupErr;
      if (dup && dup.id) {
        return res.json({ ok: true, data: dup, reused: true });
      }

      const accSnap = ma.raw_snapshot && typeof ma.raw_snapshot === "object" ? ma.raw_snapshot : {};
      const li = accSnap.liability || ma.liability || {};
      const name = debtNameFromMethodAccount({ liability: li });
      const type = methodLiabilityToDebtType(li);
      const payment_capable = Boolean(ma.payment_capable);

      const balance = body.balance !== undefined ? safeNumber(body.balance) : 0;
      const apr = body.apr !== undefined ? safeNumber(body.apr) : 0;
      const minimum_payment = body.minimum_payment !== undefined ? safeNumber(body.minimum_payment) : 0;
      const due_day = body.due_day ? Number(body.due_day) : null;

      const insertPayload = {
        user_id: req.user.id,
        name,
        balance,
        apr,
        minimum_payment,
        due_day,
        type,
        source: "method",
        method_account_id: methodAccountId,
        method_entity_id: ma.method_entity_id || null,
        payment_capable,
        goal_note: body.goal_note != null ? String(body.goal_note) : null,
        is_active: true,
        updated_at: new Date().toISOString()
      };

      const { data: debt, error: dErr } = await supabaseAdmin.from("debts").insert(insertPayload).select().single();
      if (dErr) {
        if (isMissingTableColumnError && isMissingTableColumnError(dErr, "debts", "source")) {
          return jsonError(res, 500, "Faltan columnas nuevas en debts (source / method_*)", {
            details: dErr.message,
            hint: "Ejecuta sql/method_debtya_hybrid.sql"
          });
        }
        throw dErr;
      }

      const { error: linkErr } = await supabaseAdmin
        .from("method_accounts")
        .update({
          imported_debt_id: debt.id,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", req.user.id)
        .eq("method_account_id", methodAccountId);
      if (linkErr) appError("[Method] link imported_debt_id", req.requestId || null, linkErr.message);

      methodInfo(req, "import_debt", debt.id, methodAccountId);
      return res.json({ ok: true, data: debt });
    } catch (error) {
      appError("[Method] POST /method/import-debt", req.requestId || null, error.message);
      return jsonError(res, 500, "Error importando deuda desde Method", { details: error.message });
    }
  });
}

module.exports = { registerMethodRoutes };
