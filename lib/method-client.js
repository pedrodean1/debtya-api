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

/** Method suele envolver recursos en `{ data: { ... } }` (igual que method-node usa `.data.data`). */
function unwrapMethodResourceBody(body) {
  if (!body || typeof body !== "object") return body;
  const inner = body.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner) && inner.id != null) {
    return inner;
  }
  return body;
}

function methodErrorMessageFromJson(json) {
  if (!json || typeof json !== "object") return null;
  const nested =
    json.data && typeof json.data === "object" && json.data.error && typeof json.data.error === "object"
      ? json.data.error.message
      : null;
  const top =
    (typeof nested === "string" && nested.trim() ? nested.trim() : null) ||
    (typeof json.message === "string" && json.message.trim() ? json.message.trim() : null) ||
    (json.error && typeof json.error === "object" && typeof json.error.message === "string"
      ? json.error.message.trim()
      : null) ||
    (typeof json.error === "string" ? json.error.trim() : null);
  return top || null;
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
        "User-Agent": "DebtyaMethodClient/1",
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
      const extracted = methodErrorMessageFromJson(json);
      const msg = extracted || `Method HTTP ${res.status}`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.method_response = json;
      err.method_http_status = res.status;
      err.method_raw_body = text;
      throw err;
    }
    return {
      status: res.status,
      body: json,
      rawBody: text,
      paginationCursorNext: res.headers.get("Pagination-Page-Cursor-Next"),
      paginationCursorPrev: res.headers.get("Pagination-Page-Cursor-Prev")
    };
  }

  async function request(method, pathname, body) {
    const out = await requestDetailed(method, pathname, body);
    return out.body;
  }

  async function createConnectDetailedInner(entityId) {
    const out = await requestDetailed(
      "POST",
      `/entities/${encodeURIComponent(entityId)}/connect`,
      {}
    );
    return { ...out, body: unwrapMethodResourceBody(out.body) };
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
    createConnectDetailed: createConnectDetailedInner,
    async createConnect(entityId) {
      const out = await createConnectDetailedInner(entityId);
      return out.body;
    },
    getEntity(entityId) {
      return request("GET", `/entities/${encodeURIComponent(entityId)}`, null);
    },
    async listLiabilityAccounts(holderId, query = {}) {
      const merged = [];
      let cursor = query.page_cursor || null;
      const pageLimit = query.page_limit != null ? Number(query.page_limit) : 100;
      const lim = Number.isFinite(pageLimit) && pageLimit > 0 ? Math.min(pageLimit, 100) : 100;
      for (let page = 0; page < 50; page += 1) {
        const q = new URLSearchParams();
        q.set("holder_id", holderId);
        q.set("type", "liability");
        if (query.status) q.set("status", String(query.status));
        q.set("page_limit", String(lim));
        if (cursor) q.set("page_cursor", String(cursor));
        const pathname = `/accounts?${q.toString()}`;
        const out = await requestDetailed("GET", pathname, null);
        const body = out.body || {};
        const chunk = Array.isArray(body.data) ? body.data : [];
        merged.push(...chunk);
        const next = out.paginationCursorNext || (body && body.pagination && body.pagination.next_cursor) || null;
        if (!next || chunk.length === 0) break;
        cursor = next;
      }
      return { data: merged };
    },
    getAccount(accountId) {
      return request("GET", `/accounts/${encodeURIComponent(accountId)}`, null);
    }
  };
}

module.exports = {
  methodBaseUrlFromEnv,
  computePaymentCapable,
  createMethodClient,
  unwrapMethodResourceBody,
  methodErrorMessageFromJson
};
