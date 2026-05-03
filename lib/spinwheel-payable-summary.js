const { getBillPaymentAvailability } = require("./spinwheel-debt-import");
const { validateDebtCreatePayload } = require("./validation");

/**
 * @param {number} n
 */
function roundMoney2(n) {
  if (!Number.isFinite(n)) return n;
  return Number(n.toFixed(2));
}

/**
 * Diagnóstico de deudas Spinwheel persistidas (raw_spinwheel + payment_capable).
 * No llama a la API Spinwheel ni ejecuta pagos.
 *
 * @param {object[]} debtRows filas `debts` con source spinwheel
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function buildSpinwheelPayableSummary(debtRows, safeNumber) {
  const payable_debts = [];
  const blocked_debts = [];
  let planning_only_count = 0;
  let field_error_count = 0;
  let not_supported_count = 0;

  const rows = Array.isArray(debtRows) ? debtRows : [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const extId = row.spinwheel_external_id != null ? String(row.spinwheel_external_id).trim() : "";
    const raw = row.raw_spinwheel;
    const hasRaw = raw && typeof raw === "object" && !Array.isArray(raw);

    const payload = {
      balance: safeNumber(row.balance),
      minimum_payment: safeNumber(row.minimum_payment),
      apr: safeNumber(row.apr),
      source: "spinwheel",
      spinwheel_external_id: row.spinwheel_external_id
    };
    const vErr = validateDebtCreatePayload(payload);
    const isActive = row.is_active !== false && row.is_active !== 0;
    const bal = safeNumber(row.balance);

    /** @type {{ bucket: string, reason: string }} */
    let verdict;

    if (!hasRaw) {
      verdict = { bucket: "field_error", reason: "missing_raw_spinwheel" };
    } else if (!extId) {
      verdict = { bucket: "field_error", reason: "missing_spinwheel_external_id" };
    } else if (!isActive) {
      verdict = { bucket: "field_error", reason: "debt_inactive" };
    } else if (!Number.isFinite(bal) || bal <= 0) {
      verdict = { bucket: "field_error", reason: "balance_not_positive" };
    } else if (vErr) {
      verdict = { bucket: "field_error", reason: `validation_error:${vErr}` };
    } else if (row.payment_capable === true) {
      verdict = { bucket: "payable", reason: "payable" };
    } else {
      const av = getBillPaymentAvailability(raw);
      if (av === "NOT_SUPPORTED") {
        verdict = { bucket: "not_supported", reason: "spinwheel_bill_pay_not_supported" };
      } else {
        verdict = { bucket: "planning_only", reason: "spinwheel_planning_only" };
      }
    }

    const pub = {
      id: row.id,
      name: row.name != null ? String(row.name) : "",
      spinwheel_external_id: extId,
      balance: roundMoney2(bal)
    };

    if (verdict.bucket === "payable") {
      payable_debts.push({ ...pub, payment_capable: true });
    } else {
      if (verdict.bucket === "field_error") field_error_count += 1;
      else if (verdict.bucket === "not_supported") not_supported_count += 1;
      else planning_only_count += 1;
      blocked_debts.push({
        ...pub,
        category: verdict.bucket,
        reason: verdict.reason
      });
    }
  }

  return {
    total_spinwheel_debts: rows.length,
    payable_count: payable_debts.length,
    planning_only_count,
    field_error_count,
    not_supported_count,
    payable_debts,
    blocked_debts
  };
}

module.exports = { buildSpinwheelPayableSummary };
