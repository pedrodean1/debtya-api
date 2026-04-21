/**
 * Cliente HTTP mínimo para Method Fi (sin dependencia npm extra).
 * Docs: Method-Version + Authorization Bearer.
 */

function methodBaseUrlFromEnv(methodEnv) {
  const e = String(methodEnv || "production").toLowerCase().trim();
  if (e === "sandbox") return "https://sandbox.methodfi.com";
  if (e === "dev" || e === "development") return "https://dev.methodfi.com";
  return "https://production.methodfi.com";
}

function computePaymentCapable(account) {
  const products = account && Array.isArray(account.products) ? account.products : [];
  return products.some((p) => String(p).toLowerCase() === "payment");
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.methodEnv]
 * @param {string} [opts.apiVersion]
 */
function createMethodClient(opts) {
  const apiKey = String(opts.apiKey || "").trim();
  const methodEnv = opts.methodEnv || "production";
  const apiVersion = String(opts.apiVersion || "2025-12-01").trim();
  const baseUrl = methodBaseUrlFromEnv(methodEnv).replace(/\/+$/, "");

  async function requestDetailed(method, pathname, body) {
    if (!apiKey) {
      const err = new Error("METHOD_API_KEY no configurada");
      err.code = "method_not_configured";
      err.status = 503;
      throw err;
    }
    const url = `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Method-Version": apiVersion,
        Accept: "application/json",
        ...(body !== undefined && body !== null
          ? { "Content-Type": "application/json" }
          : {})
      },
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {})
    };
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text };
    }
    if (!res.ok) {
      const msg =
        (json && (json.message || json.error?.message || json.error)) ||
        `Method HTTP ${res.status}`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.method_response = json;
      err.method_http_status = res.status;
      err.method_raw_body = text;
      throw err;
    }
    return { status: res.status, body: json, rawBody: text };
  }

  async function request(method, pathname, body) {
    const out = await requestDetailed(method, pathname, body);
    return out.body;
  }

  return {
    baseUrl,
    apiVersion,
    computePaymentCapable,
    createIndividualEntity(payload) {
      return request("POST", "/entities", payload);
    },
    createIndividualEntityDetailed(payload) {
      return requestDetailed("POST", "/entities", payload);
    },
    createConnect(entityId) {
      return request("POST", `/entities/${encodeURIComponent(entityId)}/connect`, {});
    },
    getEntity(entityId) {
      return request("GET", `/entities/${encodeURIComponent(entityId)}`, null);
    },
    listLiabilityAccounts(holderId, query = {}) {
      const q = new URLSearchParams();
      q.set("holder_id", holderId);
      q.set("type", "liability");
      if (query.status) q.set("status", String(query.status));
      q.set("limit", String(query.limit || "100"));
      return request("GET", `/accounts?${q.toString()}`, null);
    },
    getAccount(accountId) {
      return request("GET", `/accounts/${encodeURIComponent(accountId)}`, null);
    }
  };
}

module.exports = {
  methodBaseUrlFromEnv,
  computePaymentCapable,
  createMethodClient
};
