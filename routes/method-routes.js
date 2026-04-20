const { createMethodClient, computePaymentCapable } = require("../lib/method-client");
const { readMethodApiKey, readMethodEnv, readMethodApiVersion, isMethodConfigured, readMethodKeyStatus } = require("../lib/method-env");

function methodInfo(req, ...parts) {
  const rid = req && req.requestId ? req.requestId : "-";
  console.log("[Method]", rid, ...parts);
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

function registerMethodRoutes(app, deps) {
  const { requireUser, supabaseAdmin, jsonError, appError, safeNumber, isUuid, isMissingTableColumnError } = deps;

  let methodClientCache = { key: "", client: null };

  function getClient() {
    const apiKey = readMethodApiKey();
    if (!apiKey) return null;
    if (methodClientCache.key !== apiKey) {
      methodClientCache.key = apiKey;
      methodClientCache.client = createMethodClient({
        apiKey,
        methodEnv: readMethodEnv(),
        apiVersion: readMethodApiVersion()
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

  app.post("/method/entities", requireUser, async (req, res) => {
    const mc = getClient();
    if (!mc) {
      return jsonError(res, 503, "Method no está configurado en el servidor", { code: "method_not_configured" });
    }
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const individual = body.individual && typeof body.individual === "object" ? body.individual : {};
      const address = body.address && typeof body.address === "object" ? body.address : undefined;

      const payload = {
        type: "individual",
        individual: {
          first_name: individual.first_name != null ? String(individual.first_name).trim() : null,
          last_name: individual.last_name != null ? String(individual.last_name).trim() : null,
          phone: individual.phone != null ? String(individual.phone).trim() : null,
          email: individual.email != null ? String(individual.email).trim() : null,
          dob: individual.dob != null ? String(individual.dob).trim() : null
        },
        ...(address ? { address } : {})
      };

      const entity = await mc.createIndividualEntity(payload);
      const methodEntityId = entity && entity.id ? String(entity.id) : null;
      if (!methodEntityId) {
        return jsonError(res, 502, "Respuesta inválida de Method al crear entidad");
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
      appError("[Method] POST /method/entities fallo", req.requestId || null, error.message);
      return jsonError(res, status >= 500 ? 502 : status, "Error creando entidad Method", {
        details: error.message
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
      const connect = await mc.createConnect(row.method_entity_id);

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
        method_entity_id: row.method_entity_id,
        method_connect_id: connect && connect.id ? String(connect.id) : "unknown",
        status: connect && connect.status ? String(connect.status) : null,
        account_ids: connect && Array.isArray(connect.accounts) ? connect.accounts : null,
        error: connect && connect.error ? connect.error : null
      });
      if (logErr) appError("[Method] log method_connect_sessions", req.requestId || null, logErr.message);

      methodInfo(req, "connect_ran", row.method_entity_id, connect && connect.status);
      return res.json({ ok: true, data: connect });
    } catch (error) {
      const status = error.status && Number(error.status) >= 400 ? Number(error.status) : 502;
      appError("[Method] POST connect fallo", req.requestId || null, error.message);
      return jsonError(res, status >= 500 ? 502 : status, "Error ejecutando Method Connect", {
        details: error.message
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

      const listed = await mc.listLiabilityAccounts(row.method_entity_id, { limit: 100 });
      const rows = listed && Array.isArray(listed.data) ? listed.data : [];

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
      appError("[Method] POST /method/accounts/sync", req.requestId || null, error.message);
      return jsonError(res, 500, "Error sincronizando cuentas Method", { details: error.message });
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
