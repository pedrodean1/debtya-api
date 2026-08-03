/**
 * Fuente de verdad manual-first: POST /manual-plan/rebuild
 * Sin RPC build_intents_v2 ni Spinwheel.
 */

const {
  pickPriorityDebtForManualPlan,
  computeManualPriorityPaymentAmount
} = require("./manual-plan-next-payment");
const { debtRowEligibleForPlan, PAID_BALANCE_THRESHOLD } = require("./debt-paid-helpers");
const { updatePaymentIntentAsRetired } = require("./payment-intent-retirement");

const MANUAL_OPEN_INTENT_STATUSES = [
  "pending_review",
  "approved",
  "built",
  "ready",
  "draft",
  "pending",
  "queued",
  "proposed"
];

/**
 * @param {object} plan normalized plan
 * @param {object} body req.body
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function mergePlanWithBody(plan, body, safeNumber) {
  const b = body && typeof body === "object" ? body : {};
  const out = { ...(plan || {}) };
  if (b.strategy != null && String(b.strategy).trim() !== "") {
    out.strategy = String(b.strategy).toLowerCase();
  }
  if (b.automation_mode != null) out.automation_mode = b.automation_mode;
  if (b.auto_mode != null) out.auto_mode = b.auto_mode;
  if (b.monthly_budget != null) out.monthly_budget = safeNumber(b.monthly_budget);
  if (b.monthly_budget_default != null)
    out.monthly_budget_default = safeNumber(b.monthly_budget_default);
  if (b.extra_payment_default != null)
    out.extra_payment_default = safeNumber(b.extra_payment_default);
  if (b.payment_target_debt_id !== undefined) {
    const raw = b.payment_target_debt_id;
    out.payment_target_debt_id = raw && String(raw).trim() ? String(raw).trim() : null;
  }
  return out;
}

/**
 * @param {object} deps supabaseAdmin, getCurrentPaymentPlan, normalizePaymentPlan, safeNumber, isUuid
 * @returns {Promise<{ ok: boolean, manual_first_reconcile: object, intent: object|null }>}
 */
async function executeManualPlanRebuild(deps) {
  const {
    userId,
    body,
    supabaseAdmin,
    getCurrentPaymentPlan,
    normalizePaymentPlan,
    safeNumber,
    isUuid,
    savePaymentPlanForUser
  } = deps;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const rawPlan = await getCurrentPaymentPlan(userId);
  const normalized = normalizePaymentPlan(rawPlan);
  const plan = mergePlanWithBody(normalized, body, safeNumber);
  const strategy = String(plan.strategy || "avalanche").toLowerCase();

  async function persistMergedPlanToProfile() {
    if (typeof savePaymentPlanForUser !== "function") return null;
    try {
      const mb = safeNumber(plan.monthly_budget ?? plan.monthly_budget_default ?? 0);
      const mbDef = safeNumber(plan.monthly_budget_default ?? plan.monthly_budget ?? 0);
      const ex = safeNumber(plan.extra_payment_default ?? 0);
      const persistBody = {
        strategy: String(plan.strategy || "avalanche").toLowerCase(),
        automation_mode: "manual",
        auto_mode: "manual",
        monthly_budget: mb,
        monthly_budget_default: mbDef,
        extra_payment_default: ex
      };
      if (plan.payment_target_debt_id !== undefined) {
        persistBody.payment_target_debt_id = plan.payment_target_debt_id;
      }
      await savePaymentPlanForUser(userId, persistBody);
      return null;
    } catch (e) {
      return e && e.message ? String(e.message) : String(e);
    }
  }

  async function withPlanPersist(out) {
    const plan_persist_warning = await persistMergedPlanToProfile();
    return plan_persist_warning ? { ...out, plan_persist_warning } : out;
  }

  async function retireManualOpenIntents(ids, notes) {
    let statusFallbackCount = 0;
    for (const id of ids) {
      const result = await updatePaymentIntentAsRetired({
        supabaseAdmin,
        userId,
        intentId: id,
        openStatuses: MANUAL_OPEN_INTENT_STATUSES,
        payload: {
          updated_at: now,
          notes
        }
      });
      if (result.metadata_only) statusFallbackCount += 1;
    }
    return { retired: ids.length, status_fallback_count: statusFallbackCount };
  }

  const { data: debtRows, error: debtErr } = await supabaseAdmin
    .from("debts")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (debtErr) throw debtErr;

  const debts = (debtRows || []).filter((d) => debtRowEligibleForPlan(d, safeNumber));

  const { data: openRows, error: openErr } = await supabaseAdmin
    .from("payment_intents")
    .select("id,status,source")
    .eq("user_id", userId)
    .in("status", MANUAL_OPEN_INTENT_STATUSES);

  if (openErr) throw openErr;

  const toCancel = openRows || [];
  if (toCancel.length) {
    const ids = toCancel.map((r) => r.id);
    await retireManualOpenIntents(ids, "Cancelado por POST /manual-plan/rebuild (manual-first)");
  }

  const canceled = toCancel.length;

  let priorityDebt = pickPriorityDebtForManualPlan(strategy, debts, safeNumber);

  const targetId = plan.payment_target_debt_id;
  if (targetId && isUuid(String(targetId))) {
    const locked = debts.find(
      (d) =>
        String(d.id) === String(targetId) &&
        safeNumber(d.balance ?? d.current_balance) > PAID_BALANCE_THRESHOLD &&
        d.is_active !== false
    );
    if (locked) priorityDebt = locked;
  }

  if (!priorityDebt) {
    return withPlanPersist({
      ok: true,
      manual_plan_rebuild: true,
      manual_first_reconcile: {
        ok: true,
        skipped: true,
        reason: "no_positive_balance_debt",
        canceled
      },
      intent: null
    });
  }

  const amount = computeManualPriorityPaymentAmount(priorityDebt, plan, safeNumber);
  if (!(amount > 0)) {
    return withPlanPersist({
      ok: true,
      manual_plan_rebuild: true,
      manual_first_reconcile: {
        ok: true,
        skipped: true,
        reason: "zero_recommended_amount",
        canceled,
        priorityDebtId: priorityDebt.id,
        priorityDebtName: priorityDebt.name ?? null,
        amount: null,
        strategy
      },
      intent: null
    });
  }

  const strategyKey = strategy === "snowball" ? "snowball" : "avalanche";
  const insertPayload = {
    user_id: userId,
    debt_id: priorityDebt.id,
    source: "manual_rebuild",
    strategy: strategyKey,
    amount,
    total_amount: amount,
    status: "pending_review",
    execution_mode: "safe",
    execution_frequency: "daily",
    scheduled_for: today,
    notes: "DebtYa — proximo pago recomendado (manual-plan/rebuild)",
    metadata: {
      manual_first_priority: true,
      manual_first_rebuild: true,
      strategy: strategyKey,
      priority_reason: strategyKey
    },
    updated_at: now,
    created_at: now
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("payment_intents")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insErr) throw insErr;

  const keepId = inserted?.id;
  let extraCanceled = 0;
  if (keepId) {
    const { data: stray, error: strayErr } = await supabaseAdmin
      .from("payment_intents")
      .select("id")
      .eq("user_id", userId)
      .in("status", MANUAL_OPEN_INTENT_STATUSES)
      .neq("id", keepId);
    if (strayErr) throw strayErr;
    const strayIds = (stray || []).map((r) => r.id).filter(Boolean);
    if (strayIds.length) {
      await retireManualOpenIntents(
        strayIds,
        "Mantenido solo intent manual-first (post-insert /manual-plan/rebuild)"
      );
      extraCanceled = strayIds.length;
    }
  }

  return withPlanPersist({
    ok: true,
    manual_plan_rebuild: true,
    manual_first_reconcile: {
      ok: true,
      skipped: false,
      canceled: canceled + extraCanceled,
      intent_id: inserted?.id,
      priorityDebtId: priorityDebt.id,
      priorityDebtName: priorityDebt.name ?? null,
      amount,
      strategy
    },
    intent: inserted || null
  });
}

module.exports = {
  MANUAL_OPEN_INTENT_STATUSES,
  mergePlanWithBody,
  executeManualPlanRebuild
};
