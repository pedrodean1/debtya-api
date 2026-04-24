/**
 * Normaliza liabilities del debt profile Spinwheel hacia filas compatibles con public.debts.
 */

const COLLECTION_KEYS = [
  "creditCards",
  "autoLoans",
  "homeLoans",
  "personalLoans",
  "studentLoans",
  "miscellaneousLiabilities"
];

const DEFAULT_DEBT_PROFILE_BODY = { creditReport: { type: "1_BUREAU.FULL" } };

function firstNumber(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function pickSpinwheelId(item) {
  if (!item || typeof item !== "object") return "";
  const keys = [
    "creditCardId",
    "autoLoanId",
    "homeLoanId",
    "personalLoanId",
    "studentLoanId",
    "miscellaneousLiabilityId"
  ];
  for (const k of keys) {
    if (item[k] != null && String(item[k]).trim()) return String(item[k]).trim();
  }
  return "";
}

function pickStatus(item) {
  const cp = item && item.cardProfile;
  const lp = item && item.liabilityProfile;
  const s = (cp && cp.status) || (lp && lp.status) || "";
  return String(s || "").trim().toUpperCase();
}

function pickOutstandingBalance(item) {
  const bd = item && item.balanceDetails;
  const ss = item && item.statementSummary;
  const lp = item && item.liabilityProfile;
  return firstNumber(
    bd && bd.outstandingBalance,
    ss && ss.statementBalance,
    ss && ss.principalBalance,
    lp && lp.outstandingBalance,
    lp && lp.highCreditAmount
  );
}

function pickMinimumPayment(item) {
  const ss = item && item.statementSummary;
  const lp = item && item.liabilityProfile;
  return firstNumber(ss && ss.minimumPaymentAmount, lp && lp.minimumPaymentAmount, 0);
}

function pickApr(item) {
  const cp = item && item.cardProfile;
  const lp = item && item.liabilityProfile;
  return firstNumber(cp && cp.interestRateDerived, lp && lp.interestRateDerived, lp && lp.interestRate, 0);
}

function pickDueDayFromItem(item) {
  const ss = item && item.statementSummary;
  const raw = ss && ss.dueDate != null ? String(ss.dueDate) : "";
  if (!raw) return null;
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = Number(m[3]);
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

function pickBillPaymentSupported(item) {
  const cap = item && item.capabilities;
  const pay = cap && cap.payments;
  const bp = pay && pay.billPayment;
  const av = bp && bp.availability != null ? String(bp.availability).toUpperCase() : "";
  return av === "SUPPORTED";
}

function pickCreditorName(item) {
  const disp = item && item.displayName != null ? String(item.displayName).trim() : "";
  const c = item && item.creditor;
  const orig = c && c.originalName != null ? String(c.originalName).trim() : "";
  return orig || disp || "";
}

function pickLiabilitySubtype(item) {
  const cp = item && item.cardProfile;
  const lp = item && item.liabilityProfile;
  const st = (cp && cp.liabilitySubtype) || (lp && lp.liabilitySubtype) || "";
  const dt = (cp && cp.debtType) || (lp && lp.debtType) || "";
  return { liabilitySubtype: String(st || "").trim(), debtType: String(dt || "").trim() };
}

function mapToDebtsType(collectionKey, liabilitySubtype, debtType) {
  const sub = String(liabilitySubtype || "").toLowerCase();
  const dt = String(debtType || "").toLowerCase();
  if (collectionKey === "creditCards") return "credit_card";
  if (collectionKey === "homeLoans") return "loan";
  if (collectionKey === "studentLoans") return "loan";
  if (collectionKey === "personalLoans") return "personal_loan";
  if (sub.includes("credit")) return "credit_card";
  if (sub.includes("student")) return "loan";
  if (sub.includes("personal")) return "personal_loan";
  if (sub.includes("mortgage") || sub.includes("home")) return "loan";
  if (dt.includes("secured") && collectionKey === "autoLoans") return "loan";
  if (collectionKey === "autoLoans") return "loan";
  return "other";
}

/**
 * @param {unknown} spinJson — cuerpo JSON del debt profile (p. ej. { status, data }).
 */
function extractDebtProfileData(spinJson) {
  if (!spinJson || typeof spinJson !== "object") return null;
  const root = /** @type {any} */ (spinJson);
  if (root.data && typeof root.data === "object") return root.data;
  if (root.spinwheel && root.spinwheel.data && typeof root.spinwheel.data === "object") return root.spinwheel.data;
  return null;
}

/**
 * True si `raw_response` guardado parece un debt-profile (data con al menos una colección de liabilities como array).
 * Evita POST debt-profile cuando Spinwheel limita a 1/día por usuario.
 * @param {unknown} raw
 */
function spinwheelRawResponseHasDebtProfileData(raw) {
  const data = extractDebtProfileData(raw);
  if (!data || typeof data !== "object") return false;
  return COLLECTION_KEYS.some((k) => Array.isArray(/** @type {any} */ (data)[k]));
}

/**
 * @param {object} data — `data` del JSON debt profile Spinwheel
 * @returns {{ collection: string, item: object }[]}
 */
function collectOpenLiabilitiesForImport(data) {
  if (!data || typeof data !== "object") return [];
  const out = [];
  for (const col of COLLECTION_KEYS) {
    const arr = data[col];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const id = pickSpinwheelId(item);
      if (!id) continue;
      const st = pickStatus(item);
      if (st !== "OPEN") continue;
      const bal = pickOutstandingBalance(item);
      if (!Number.isFinite(bal) || bal <= 0) continue;
      out.push({ collection: col, item });
    }
  }
  return out;
}

/**
 * @param {(v: unknown, fb?: number) => number} safeNumber
 */
function spinwheelItemToDebtPayload(userId, collection, item, safeNumber) {
  const extId = pickSpinwheelId(item);
  const { liabilitySubtype, debtType } = pickLiabilitySubtype(item);
  const subtypeLabel = [collection, liabilitySubtype || debtType].filter(Boolean).join(":");
  const creditor = pickCreditorName(item);
  const display = item && item.displayName != null ? String(item.displayName).trim() : "";
  const name = display || creditor || "Deuda Spinwheel";
  let balance = pickOutstandingBalance(item);
  let minimum_payment = pickMinimumPayment(item);
  let apr = pickApr(item);
  balance = safeNumber(balance);
  minimum_payment = safeNumber(minimum_payment);
  apr = safeNumber(Math.min(Math.max(apr, 0), 2000));
  const due_day = pickDueDayFromItem(item);
  return {
    user_id: userId,
    name,
    balance,
    apr,
    minimum_payment,
    due_day,
    type: mapToDebtsType(collection, liabilitySubtype, debtType),
    source: "spinwheel",
    spinwheel_external_id: extId,
    spinwheel_external_type: subtypeLabel,
    creditor_name: creditor || null,
    payment_capable: pickBillPaymentSupported(item),
    raw_spinwheel: item,
    goal_note: null,
    is_active: true,
    method_account_id: null,
    method_entity_id: null,
    linked_plaid_account_id: null
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabaseAdmin
 * @param {{
 *   debtyaUserId: string,
 *   spinwheelUserId: string,
 *   client: object | null,
 *   cachedSpinwheelDebtProfileRaw?: unknown,
 *   cachedRawResponse?: unknown,
 *   safeNumber: Function,
 *   validateDebtCreatePayload: Function
 * }} opts
 */
async function importDebtsFromSpinwheelApi(supabaseAdmin, opts) {
  const {
    debtyaUserId,
    spinwheelUserId,
    client,
    cachedSpinwheelDebtProfileRaw,
    cachedRawResponse,
    safeNumber,
    validateDebtCreatePayload
  } = opts;

  let raw;
  /** @type {"cached_spinwheel_debt_profile_raw"|"cached_raw_response"|"fresh_spinwheel_api"|null} */
  let source_used;

  if (spinwheelRawResponseHasDebtProfileData(cachedSpinwheelDebtProfileRaw)) {
    raw = cachedSpinwheelDebtProfileRaw;
    source_used = "cached_spinwheel_debt_profile_raw";
  } else if (spinwheelRawResponseHasDebtProfileData(cachedRawResponse)) {
    raw = cachedRawResponse;
    source_used = "cached_raw_response";
  } else {
    if (!client || typeof client.requestDetailed !== "function") {
      return {
        ok: false,
        error: "Spinwheel no configurado y sin debt profile en caché (columna ni raw_response)",
        source_used: null,
        inserted: 0,
        updated: 0,
        skipped: 0,
        scanned: 0,
        results: []
      };
    }
    const out = await client.requestDetailed(
      "POST",
      `/v1/users/${encodeURIComponent(spinwheelUserId)}/debt-profile`,
      DEFAULT_DEBT_PROFILE_BODY,
      "default"
    );
    raw = out.body;
    source_used = "fresh_spinwheel_api";
  }

  const data = extractDebtProfileData(raw);
  if (!data) {
    return {
      ok: false,
      error: "debtProfile sin data",
      source_used,
      inserted: 0,
      updated: 0,
      skipped: 0,
      scanned: 0,
      results: []
    };
  }
  const liabilities = collectOpenLiabilitiesForImport(data);
  const results = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const { collection, item } of liabilities) {
    const row = spinwheelItemToDebtPayload(debtyaUserId, collection, item, safeNumber);
    const vErr = validateDebtCreatePayload(row);
    if (vErr) {
      skipped += 1;
      results.push({ spinwheel_external_id: row.spinwheel_external_id, action: "skip", reason: vErr });
      continue;
    }

    const { data: existing, error: selErr } = await supabaseAdmin
      .from("debts")
      .select("id")
      .eq("user_id", debtyaUserId)
      .eq("source", "spinwheel")
      .eq("spinwheel_external_id", row.spinwheel_external_id)
      .maybeSingle();

    if (selErr) {
      results.push({
        spinwheel_external_id: row.spinwheel_external_id,
        action: "error",
        reason: selErr.message || String(selErr)
      });
      skipped += 1;
      continue;
    }

    const writeRow = {
      name: row.name,
      balance: row.balance,
      apr: row.apr,
      minimum_payment: row.minimum_payment,
      due_day: row.due_day,
      type: row.type,
      creditor_name: row.creditor_name,
      payment_capable: row.payment_capable,
      raw_spinwheel: row.raw_spinwheel,
      spinwheel_external_type: row.spinwheel_external_type,
      goal_note: row.goal_note,
      is_active: true,
      updated_at: now
    };

    if (existing && existing.id) {
      const { data: upd, error: upErr } = await supabaseAdmin
        .from("debts")
        .update(writeRow)
        .eq("id", existing.id)
        .eq("user_id", debtyaUserId)
        .select("id")
        .single();
      if (upErr) {
        results.push({
          spinwheel_external_id: row.spinwheel_external_id,
          action: "error",
          reason: upErr.message || String(upErr)
        });
        skipped += 1;
      } else {
        updated += 1;
        results.push({ id: upd && upd.id, spinwheel_external_id: row.spinwheel_external_id, action: "updated" });
      }
    } else {
      const ins = {
        ...row,
        updated_at: now
      };
      const { data: insData, error: insErr } = await supabaseAdmin.from("debts").insert(ins).select("id").single();
      if (insErr) {
        results.push({
          spinwheel_external_id: row.spinwheel_external_id,
          action: "error",
          reason: insErr.message || String(insErr)
        });
        skipped += 1;
      } else {
        inserted += 1;
        results.push({
          id: insData && insData.id,
          spinwheel_external_id: row.spinwheel_external_id,
          action: "inserted"
        });
      }
    }
  }

  return {
    ok: true,
    source_used,
    inserted,
    updated,
    skipped,
    scanned: liabilities.length,
    results
  };
}

module.exports = {
  COLLECTION_KEYS,
  DEFAULT_DEBT_PROFILE_BODY,
  extractDebtProfileData,
  spinwheelRawResponseHasDebtProfileData,
  collectOpenLiabilitiesForImport,
  spinwheelItemToDebtPayload,
  importDebtsFromSpinwheelApi,
  pickSpinwheelId,
  pickStatus,
  pickOutstandingBalance,
  mapToDebtsType
};
