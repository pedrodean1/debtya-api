/**
 * Manual-first priority: una deuda focal y monto recomendado (Avalanche / Snowball).
 * Sin tocar RPC build_intents_v2 — la reconciliación en server.js cancela intents no-Spinwheel
 * abiertos e inserta un único pending_review alineado con esta lógica.
 */

/**
 * APR usable para ordenar (solo > 0). null = desconocido o no priorizable por tasa.
 */
function effectiveApr(debt, safeNumber) {
  if (!debt) return null;
  const raw = debt.apr ?? debt.interest_rate;
  if (raw == null || raw === "") return null;
  const n = safeNumber(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string} strategy avalanche | snowball
 * @param {object[]} debts filas debts (is_active, balance, apr, interest_rate, due_day, id)
 * @param {(v: unknown, fb?: number) => number} safeNumber
 * @returns {object|null} deuda prioritaria o null
 */
function pickPriorityDebtForManualPlan(strategy, debts, safeNumber) {
  const active = (debts || []).filter(
    (d) => d && d.is_active !== false && safeNumber(d.balance) > 0
  );
  if (!active.length) return null;

  const s = String(strategy || "avalanche").toLowerCase();

  if (s === "snowball") {
    active.sort((a, b) => {
      const db = safeNumber(a.balance) - safeNumber(b.balance);
      if (db !== 0) return db;
      const aprDiff =
        safeNumber(b.apr ?? b.interest_rate ?? 0) -
        safeNumber(a.apr ?? a.interest_rate ?? 0);
      if (aprDiff !== 0) return aprDiff;
      return String(a.id).localeCompare(String(b.id));
    });
    return active[0];
  }

  const anyPositiveApr = active.some((d) => {
    const ap = effectiveApr(d, safeNumber);
    return ap != null && ap > 0;
  });

  if (anyPositiveApr) {
    active.sort((a, b) => {
      const aa = effectiveApr(a, safeNumber);
      const bb = effectiveApr(b, safeNumber);
      const va = aa != null && aa > 0 ? aa : -Infinity;
      const vb = bb != null && bb > 0 ? bb : -Infinity;
      if (vb !== va) return vb - va;
      return safeNumber(b.balance) - safeNumber(a.balance);
    });
  } else {
    active.sort((a, b) => {
      const bal = safeNumber(b.balance) - safeNumber(a.balance);
      if (bal !== 0) return bal;
      const da = a.due_day != null ? Number(a.due_day) : 999;
      const dbd = b.due_day != null ? Number(b.due_day) : 999;
      if (da !== dbd) return da - dbd;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  return active[0];
}

/**
 * @param {object} priorityDebt deuda elegida
 * @param {object|null} plan normalizePaymentPlan row
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function computeManualPriorityPaymentAmount(priorityDebt, plan, safeNumber) {
  const bal = safeNumber(priorityDebt.balance);
  if (!(bal > 0)) return 0;

  const minPay = Math.max(0, safeNumber(priorityDebt.minimum_payment));
  const extraTotal =
    Math.max(0, safeNumber(plan?.extra_payment_default)) +
    Math.max(0, safeNumber(plan?.monthly_budget));

  const base = minPay > 0 ? Math.min(minPay, bal) : Math.min(bal, 25);

  let total;
  if (minPay <= 0 && extraTotal <= 0) {
    total = Math.min(bal, 25);
  } else {
    total = Math.min(bal, base + extraTotal);
  }

  return Number(total.toFixed(2));
}

module.exports = {
  effectiveApr,
  pickPriorityDebtForManualPlan,
  computeManualPriorityPaymentAmount
};
