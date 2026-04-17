function registerPlaidRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    plaidClient,
    PLAID_PRODUCTS,
    PLAID_COUNTRY_CODES,
    PLAID_REDIRECT_URI,
    PLAID_ANDROID_PACKAGE_NAME,
    ensureProfile,
    getInstitutionName,
    upsertPlaidItem,
    getPlaidItemsForUser,
    stripPlaidItemSecretsForClient,
    fetchInstitutionLogoDataUrl,
    importPlaidAccountsForUser,
    getLatestPlaidItemForUser,
    disconnectPlaidItemForUser,
    insertTransactionsRaw,
    getBaseUrl,
    appError,
    appDebug,
    jsonError,
    normalizePlaidConnectionRole
  } = deps;

  function resolvePlaidItemRowId(row) {
    if (!row || typeof row !== "object") return null;
    const candidates = [
      row.plaid_item_id,
      row.item_id,
      row.plaidItemId,
      row.itemId,
      row.connection_item_id,
      row.plaid_connection_id
    ];
    for (const v of candidates) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return null;
  }

  app.get("/plaid/web", (req, res) => {
    const baseUrl = getBaseUrl(req);
    return res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DebtYa Plaid Web</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: Arial, sans-serif; background:#f7f7fb; padding:40px; }
    .card { max-width:560px; margin:auto; background:#fff; border-radius:16px; padding:24px; box-shadow:0 10px 30px rgba(0,0,0,.08); }
    button { background:#111827; color:white; border:0; border-radius:10px; padding:12px 18px; cursor:pointer; }
    pre { white-space:pre-wrap; background:#f3f4f6; padding:12px; border-radius:10px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>DebtYa - Conectar banco</h2>
    <p>Esta página usa Plaid Link Web.</p>
    <button id="connectBtn">Conectar banco</button>
    <pre id="output"></pre>
  </div>
  <script>
    const output = document.getElementById("output");
    const btn = document.getElementById("connectBtn");

    btn.onclick = async () => {
      const token = localStorage.getItem("debtya_access_token");
      if (!token) {
        output.textContent = "Falta debtya_access_token en localStorage.";
        return;
      }

      const r = await fetch("${baseUrl}/plaid/create_link_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        }
      });

      const data = await r.json();
      output.textContent = JSON.stringify(data, null, 2);

      if (!data.ok || !data.link_token) return;

      const handler = Plaid.create({
        token: data.link_token,
        onSuccess: async (public_token, metadata) => {
          const rr = await fetch("${baseUrl}/plaid/exchange_public_token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + token
            },
            body: JSON.stringify({ public_token, metadata })
          });
          const dd = await rr.json();
          output.textContent = JSON.stringify(dd, null, 2);
        },
        onExit: (err, metadata) => {
          output.textContent = JSON.stringify({ err, metadata }, null, 2);
        }
      });

      handler.open();
    };
  </script>
</body>
</html>
  `);
  });

  app.post("/plaid/create_link_token", requireUser, async (req, res) => {
    try {
      if (!plaidClient) {
        return jsonError(res, 500, "Plaid no configurado");
      }

      await ensureProfile(req.user.id);

      const request = {
        user: {
          client_user_id: req.user.id
        },
        client_name: "DebtYa",
        products: PLAID_PRODUCTS.split(",").map((x) => x.trim()),
        country_codes: PLAID_COUNTRY_CODES.split(",").map((x) => x.trim()),
        language: "es"
      };

      if (PLAID_REDIRECT_URI) {
        request.redirect_uri = PLAID_REDIRECT_URI;
      }

      if (PLAID_ANDROID_PACKAGE_NAME) {
        request.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
      }

      const response = await plaidClient.linkTokenCreate(request);

      return res.json({
        ok: true,
        link_token: response.data.link_token,
        expiration: response.data.expiration
      });
    } catch (error) {
      return jsonError(res, 500, "Error creando link token", {
        details: error.response?.data || error.message
      });
    }
  });

  app.post("/plaid/exchange_public_token", requireUser, async (req, res) => {
    try {
      if (!plaidClient) {
        return jsonError(res, 500, "Plaid no configurado");
      }

      const publicToken = req.body?.public_token || null;
      const metadata = req.body?.metadata || {};

      if (!publicToken) {
        return jsonError(res, 400, "Falta public_token");
      }

      const exchange = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken
      });

      const accessToken = exchange?.data?.access_token || null;
      const itemId = exchange?.data?.item_id || null;

      if (!accessToken || !itemId) {
        return jsonError(res, 500, "Plaid no devolvió access_token o item_id", {
          details: exchange?.data || null
        });
      }

      const institutionId = metadata?.institution?.institution_id || null;

      let institutionName = metadata?.institution?.name || null;

      if (!institutionName && institutionId) {
        try {
          institutionName = await getInstitutionName(institutionId);
        } catch (institutionError) {
          appError(
            "getInstitutionName ERROR:",
            institutionError?.response?.data || institutionError?.message || institutionError
          );
          institutionName = null;
        }
      }

      const connectionRole = normalizePlaidConnectionRole(req.body?.connection_role);

      const plaidItem = await upsertPlaidItem({
        userId: req.user.id,
        itemId,
        accessToken,
        institutionId,
        institutionName,
        connectionRole
      });

      return res.json({
        ok: true,
        item: {
          id: plaidItem?.id || null,
          plaid_item_id: plaidItem?.plaid_item_id || itemId,
          institution_id: plaidItem?.institution_id || institutionId,
          institution_name: plaidItem?.institution_name || institutionName,
          connection_role:
            plaidItem?.connection_role != null
              ? normalizePlaidConnectionRole(plaidItem.connection_role)
              : connectionRole
        }
      });
    } catch (error) {
      const raw =
        error?.response?.data ||
        error?.data ||
        error?.message ||
        null;

      const detailedMessage =
        raw?.error_message ||
        raw?.message ||
        raw?.error_code ||
        raw?.error_type ||
        (typeof raw === "string" ? raw : null) ||
        "Error intercambiando public_token";

      appError("exchange_public_token ERROR:", detailedMessage);
      appDebug("exchange_public_token ERROR RAW:", raw);

      return res.status(500).json({
        ok: false,
        error: detailedMessage,
        details: raw
      });
    }
  });

  app.post("/plaid/items/connection-role", requireUser, async (req, res) => {
    try {
      const plaidItemId = String(req.body?.plaid_item_id || "").trim();
      const role = normalizePlaidConnectionRole(req.body?.connection_role);
      if (!plaidItemId) {
        return jsonError(res, 400, "Falta plaid_item_id");
      }

      const { data, error } = await supabaseAdmin
        .from("plaid_items")
        .update({
          connection_role: role,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", req.user.id)
        .eq("plaid_item_id", plaidItemId)
        .select()
        .single();

      if (error) throw error;
      if (!data?.id) {
        const err = new Error("Conexion bancaria no encontrada");
        err.status = 404;
        throw err;
      }

      return res.json({
        ok: true,
        item: stripPlaidItemSecretsForClient(data)
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error actualizando rol del banco", {
        details: error.message
      });
    }
  });

  app.get("/plaid/items", requireUser, async (req, res) => {
    try {
      const items = await getPlaidItemsForUser(req.user.id);
      const stripped = (items || [])
        .filter((r) => r != null && typeof r === "object")
        .map(stripPlaidItemSecretsForClient)
        .filter((r) => r != null && typeof r === "object");
      const uniqueInstitutionIds = [
        ...new Set(
          stripped.map((row) => row?.institution_id).filter((id) => !!id)
        )
      ];
      const logoByInstitution = new Map();
      const logoWaitMs = 5000;
      const loadLogos = Promise.all(
        uniqueInstitutionIds.map(async (institutionId) => {
          try {
            const dataUrl = await fetchInstitutionLogoDataUrl(institutionId);
            logoByInstitution.set(institutionId, dataUrl);
          } catch {
            logoByInstitution.set(institutionId, null);
          }
        })
      );
      await Promise.race([
        loadLogos,
        new Promise((resolve) => {
          setTimeout(resolve, logoWaitMs);
        })
      ]);
      const data = stripped.map((row) => {
        const pid = resolvePlaidItemRowId(row);
        return {
          ...row,
          plaid_item_id: pid,
          institution_logo_data_url: row?.institution_id
            ? logoByInstitution.get(row.institution_id) ?? null
            : null
        };
      });
      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error cargando plaid items", {
        details: error.message
      });
    }
  });

  app.post("/plaid/items/disconnect", requireUser, async (req, res) => {
    try {
      const plaidItemId = String(req.body?.plaid_item_id || "").trim();
      if (!plaidItemId) {
        return jsonError(res, 400, "Falta plaid_item_id");
      }
      const result = await disconnectPlaidItemForUser(req.user.id, plaidItemId);
      return res.json(result);
    } catch (error) {
      return jsonError(res, error.status || 500, "Error desconectando banco", {
        details: error.message
      });
    }
  });

  app.delete("/plaid/items/:plaidItemId", requireUser, async (req, res) => {
    try {
      const raw = String(req.params.plaidItemId || "").trim();
      const plaidItemId = decodeURIComponent(raw);
      const result = await disconnectPlaidItemForUser(req.user.id, plaidItemId);
      return res.json(result);
    } catch (error) {
      return jsonError(res, error.status || 500, "Error desconectando banco", {
        details: error.message
      });
    }
  });

  app.get("/plaid/accounts", requireUser, async (req, res) => {
    try {
      if (!plaidClient) {
        return jsonError(res, 500, "Plaid no configurado");
      }

      const result = await importPlaidAccountsForUser(req.user.id);

      return res.json({
        ok: true,
        item_id: result.item.plaid_item_id,
        total_accounts: result.response.data.accounts.length,
        data: result.saved
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error importando cuentas", {
        details: error.response?.data || error.message
      });
    }
  });

  app.post("/plaid/accounts/import", requireUser, async (req, res) => {
    try {
      const result = await importPlaidAccountsForUser(req.user.id);

      return res.json({
        ok: true,
        item_id: result.item.plaid_item_id,
        total_accounts: result.response.data.accounts.length,
        count: result.saved.length,
        data: result.saved
      });
    } catch (error) {
      return jsonError(res, error.status || 500, "Error importando cuentas", {
        details: error.response?.data || error.message
      });
    }
  });

  app.post("/plaid/transactions/sync", requireUser, async (req, res) => {
    try {
      if (!plaidClient) {
        return jsonError(res, 500, "Plaid no configurado");
      }

      const item = await getLatestPlaidItemForUser(req.user.id);
      if (!item?.access_token) {
        return jsonError(res, 400, "No hay cuenta bancaria conectada");
      }

      let cursor = req.body.cursor || item.sync_cursor || null;
      let added = [];
      let hasMore = true;

      while (hasMore) {
        const response = await plaidClient.transactionsSync({
          access_token: item.access_token,
          cursor
        });

        const data = response.data;
        added = added.concat(data.added || []);
        cursor = data.next_cursor;
        hasMore = !!data.has_more;
      }

      const syncResult = await insertTransactionsRaw(
        req.user.id,
        item.plaid_item_id,
        added
      );

      await supabaseAdmin
        .from("plaid_items")
        .update({
          sync_cursor: cursor,
          updated_at: new Date().toISOString()
        })
        .eq("id", item.id);

      return res.json({
        ok: true,
        plaid_item_id: item.plaid_item_id,
        imported: syncResult.inserted,
        added: syncResult.inserted,
        next_cursor: cursor
      });
    } catch (error) {
      return jsonError(res, 500, "Error importando transacciones", {
        details: error.response?.data || error.message
      });
    }
  });
}

module.exports = { registerPlaidRoutes };
