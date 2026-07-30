/**
 * Paid-debt rules (DebtYa V107): balance threshold + status column.
 * Keep in sync with server applyExecutedIntentToDebt and UI filters.
 */

const PAID_BALANCE_THRESHOLD = 0.01;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isDebtBalancePaidOff(balance, sn = safeNumber) {
  return sn(balance) <= PAID_BALANCE_THRESHOLD;
}

/**
 * Debts that still count for manual plan, next payment, and strategy compare.
 */
function debtRowEligibleForPlan(row, sn = safeNumber) {
  if (!row || typeof row !== "object") return false;
  if (row.is_active === false) return false;
  const st = String(row.status || "active").toLowerCase();
  if (st === "paid" || st === "paid_off" || st === "archived") return false;
  return sn(row.balance ?? row.current_balance) > PAID_BALANCE_THRESHOLD;
}

/**
 * Rows shown under "Paid debts" (still is_active for user visibility).
 */
function debtRowListedAsPaid(row, sn = safeNumber) {
  if (!row || typeof row !== "object") return false;
  if (row.is_active === false) return false;
  const st = String(row.status || "").toLowerCase();
  if (st === "paid" || st === "paid_off") return true;
  return isDebtBalancePaidOff(row.balance ?? row.current_balance, sn);
}

/**
 * Rows shown in the main active debt list (GET /debts data[]).
 */
function debtRowListedAsActiveCarrying(row, sn = safeNumber) {
  if (!row || typeof row !== "object") return false;
  if (row.is_active === false) return false;
  return debtRowEligibleForPlan(row, sn);
}

module.exports = {
  PAID_BALANCE_THRESHOLD,
  safeNumber,
  isDebtBalancePaidOff,
  debtRowEligibleForPlan,
  debtRowListedAsPaid,
  debtRowListedAsActiveCarrying
};
