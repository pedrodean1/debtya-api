/**
 * Pure helpers for manual extra payments toward a debt (outside-app money).
 */

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * @param {number} requested
 * @param {number} balance current DebtYa balance
 */
function computeManualExtraAppliedAmount(requested, balance) {
  const r = round2(requested);
  const b = Math.max(0, round2(balance));
  const applied = round2(Math.min(Math.max(0, r), b));
  const amount_clamped = r > applied + 1e-9;
  return { requested: r, balance_snapshot: b, applied, amount_clamped };
}

module.exports = {
  round2,
  computeManualExtraAppliedAmount
};
