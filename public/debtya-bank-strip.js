(function () {
  "use strict";

  function hasToken() {
    try {
      if (localStorage.getItem("debtya_access_token")) return true;
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("auth-token") === -1) continue;
        var raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        var p = JSON.parse(raw);
        if (p && (p.access_token || (p.currentSession && p.currentSession.access_token))) return true;
      }
    } catch (e) {}
    return false;
  }

  function mount() {
    if (document.getElementById("debtya-bank-strip")) return;
    var el = document.createElement("div");
    el.id = "debtya-bank-strip";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Desconectar banco");
    el.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:10000;padding:10px 14px;text-align:center;font:13px/1.4 Arial,Helvetica,sans-serif;background:#0f172a;color:#e2e8f0;border-top:1px solid #334155;box-shadow:0 -6px 24px rgba(0,0,0,.15);";
    var a = document.createElement("a");
    a.href = "/?debtya_bank_disconnect=1";
    a.style.cssText = "color:#7dd3fc;font-weight:800;margin:0 8px;text-decoration:underline;";
    a.textContent = "Desconectar banco / Disconnect bank";
    el.appendChild(document.createTextNode("Plaid: "));
    el.appendChild(a);
    el.appendChild(document.createTextNode(" (misma sesión)"));
    document.body.appendChild(el);
    var pb = parseInt(getComputedStyle(document.body).paddingBottom, 10) || 0;
    document.body.style.paddingBottom = Math.max(pb, 52) + "px";
  }

  var pollTries = 0;
  function poll() {
    if (document.getElementById("debtya-bank-strip")) return;
    if (hasToken()) {
      mount();
      return;
    }
    if (++pollTries > 24) return;
    setTimeout(poll, 1000);
  }

  function boot() {
    if (document.getElementById("debtya-bank-strip")) return;
    if (hasToken()) mount();
    else poll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
