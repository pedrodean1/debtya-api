/**
 * Cliente HTTP mínimo para Spinwheel (Bearer). Sin dependencias extra.
 * Docs: https://docs.spinwheel.io/
 */

function spinwheelErrorMessageFromJson(json) {
  if (!json || typeof json !== "object") return null;
  const st = json.status;
  if (st && typeof st === "object") {
    const msgs = st.messages;
    if (Array.isArray(msgs) && msgs[0] && typeof msgs[0].desc === "string" && msgs[0].desc.trim()) {
      return msgs[0].desc.trim();
    }
    if (typeof st.desc === "string" && st.desc.trim() && String(st.desc).toLowerCase() !== "success") {
      return st.desc.trim();
    }
  }
  if (typeof json.message === "string" && json.message.trim()) return json.message.trim();
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.apiSecret
 * @param {string} opts.apiBaseUrl
 * @param {string} opts.secureApiBaseUrl
 */
function createSpinwheelClient(opts) {
  let apiSecret = String(opts.apiSecret || "").trim();
  while (/^bearer\s+/i.test(apiSecret)) {
    apiSecret = apiSecret.replace(/^bearer\s+/i, "").trim();
  }
  const apiBaseUrl = String(opts.apiBaseUrl || "").replace(/\/+$/, "");
  const secureApiBaseUrl = String(opts.secureApiBaseUrl || "").replace(/\/+$/, "");

  /**
   * @param {"default"|"secure"} hostKind
   */
  async function requestDetailed(method, pathname, body, hostKind) {
    if (!apiSecret) {
      const err = new Error("Spinwheel API secret no configurada");
      err.code = "spinwheel_not_configured";
      err.status = 503;
      throw err;
    }
    const base = hostKind === "secure" ? secureApiBaseUrl : apiBaseUrl;
    if (!base) {
      const err = new Error("Spinwheel base URL no configurada");
      err.code = "spinwheel_bad_config";
      err.status = 503;
      throw err;
    }
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = `${base}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${apiSecret}`,
        Accept: "application/json",
        "User-Agent": "DebtyaSpinwheelClient/1",
        ...(body !== undefined && body !== null ? { "Content-Type": "application/json" } : {})
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
      const extracted = spinwheelErrorMessageFromJson(json);
      const msg = extracted || `Spinwheel HTTP ${res.status}`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.spinwheel_response = json;
      err.spinwheel_http_status = res.status;
      err.spinwheel_raw_body = text;
      throw err;
    }
    return {
      status: res.status,
      body: json,
      url
    };
  }

  return {
    requestDetailed,
    spinwheelErrorMessageFromJson
  };
}

module.exports = {
  createSpinwheelClient,
  spinwheelErrorMessageFromJson
};
