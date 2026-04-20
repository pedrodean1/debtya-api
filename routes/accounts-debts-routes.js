const { validateDebtCreatePayload, validateDebtPatch } = require("../lib/validation");

function registerAccountsDebtsRoutes(app, deps) {
  const {
    requireUser,
    supabaseAdmin,
    jsonError,
    safeNumber,
    isUuid,
    assertLinkedPlaidAccountForUser
  } = deps;

  app.get("/accounts", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("accounts")
        .select("*")
        .eq("user_id", req.user.id)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return res.json({ ok: true, data: data || [] });
    } catch (error) {
      return jsonError(res, 500, "Error cargando cuentas", {
        details: error.message
      });
    }
  });

  app.get("/debts", requireUser, async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("debts")
        .select("*")
        .eq("user_id", req.user.id)
        .eq("is_active", true)
        .order("apr", { ascending: false });

      if (error) throw error;

      return res.json({
        ok: true,
        data: data || []
      });
    } catch (error) {
      return jsonError(res, 500, "Error cargando deudas", {
        details: error.message
      });
    }
  });

  app.post("/debts", requireUser, async (req, res) => {
    try {
      const payload = {
        user_id: req.user.id,
        name: req.body.name || "Deuda",
        balance: safeNumber(req.body.balance),
        apr: safeNumber(req.body.apr),
        minimum_payment: safeNumber(req.body.minimum_payment),
        due_day: req.body.due_day ? Number(req.body.due_day) : null,
        type: req.body.type || "credit_card",
        goal_note: req.body.goal_note || null,
        is_active: true,
        updated_at: new Date().toISOString()
      };

      if (req.body.source !== undefined && req.body.source !== null) {
        payload.source = String(req.body.source);
      } else {
        payload.source = "manual";
      }
      if (req.body.method_account_id !== undefined) {
        const v = req.body.method_account_id;
        payload.method_account_id = v === null || v === "" ? null : String(v).trim();
      }
      if (req.body.method_entity_id !== undefined) {
        const v = req.body.method_entity_id;
        payload.method_entity_id = v === null || v === "" ? null : String(v).trim();
      }
      if (req.body.payment_capable !== undefined) {
        const pc = req.body.payment_capable;
        payload.payment_capable = pc === true || pc === "true";
      }

    if (req.body.linked_plaid_account_id !== undefined) {
      const raw = req.body.linked_plaid_account_id;
      if (raw === null || raw === "") {
        payload.linked_plaid_account_id = null;
      } else {
        const lid = String(raw).trim();
        await assertLinkedPlaidAccountForUser(req.user.id, lid);
        payload.linked_plaid_account_id = lid;
      }
    }

    const debtErr = validateDebtCreatePayload(payload);
    if (debtErr) {
      return jsonError(res, 400, debtErr);
    }

    const { data, error } = await supabaseAdmin
      .from("debts")
      .insert(payload)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error creando deuda", {
        details: error.message
      });
    }
  });

  app.patch("/debts/:id", requireUser, async (req, res) => {
    try {
      const debtId = req.params.id;
      if (!isUuid(debtId)) {
        return jsonError(res, 400, "ID inválido");
      }

      const patch = {
        updated_at: new Date().toISOString()
      };

      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.balance !== undefined) patch.balance = safeNumber(req.body.balance);
      if (req.body.apr !== undefined) patch.apr = safeNumber(req.body.apr);
      if (req.body.minimum_payment !== undefined) patch.minimum_payment = safeNumber(req.body.minimum_payment);
      if (req.body.due_day !== undefined) patch.due_day = req.body.due_day ? Number(req.body.due_day) : null;
      if (req.body.type !== undefined) patch.type = req.body.type;
      if (req.body.goal_note !== undefined) patch.goal_note = req.body.goal_note || null;
      if (req.body.is_active !== undefined) patch.is_active = !!req.body.is_active;

      if (req.body.linked_plaid_account_id !== undefined) {
        const raw = req.body.linked_plaid_account_id;
        if (raw === null || raw === "") {
          patch.linked_plaid_account_id = null;
        } else {
          const lid = String(raw).trim();
          await assertLinkedPlaidAccountForUser(req.user.id, lid);
          patch.linked_plaid_account_id = lid;
        }
      }

      if (req.body.source !== undefined) {
        patch.source = req.body.source === null ? "manual" : String(req.body.source);
      }
      if (req.body.method_account_id !== undefined) {
        const v = req.body.method_account_id;
        patch.method_account_id = v === null || v === "" ? null : String(v).trim();
      }
      if (req.body.method_entity_id !== undefined) {
        const v = req.body.method_entity_id;
        patch.method_entity_id = v === null || v === "" ? null : String(v).trim();
      }
      if (req.body.payment_capable !== undefined) {
        const pc = req.body.payment_capable;
        patch.payment_capable = pc === true || pc === "true";
      }

      const patchErr = validateDebtPatch(patch);
      if (patchErr) {
        return jsonError(res, 400, patchErr);
      }

      const { data, error } = await supabaseAdmin
        .from("debts")
        .update(patch)
        .eq("id", debtId)
        .eq("user_id", req.user.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, "Error actualizando deuda", {
        details: error.message
      });
    }
  });

  app.delete("/debts/:id", requireUser, async (req, res) => {
    try {
      const debtId = req.params.id;
      if (!isUuid(debtId)) {
        return jsonError(res, 400, "ID inválido");
      }

      const { error } = await supabaseAdmin
        .from("debts")
        .update({
          is_active: false,
          updated_at: new Date().toISOString()
        })
        .eq("id", debtId)
        .eq("user_id", req.user.id);

      if (error) throw error;

      return res.json({ ok: true });
    } catch (error) {
      return jsonError(res, 500, "Error eliminando deuda", {
        details: error.message
      });
    }
  });
}

module.exports = { registerAccountsDebtsRoutes };
