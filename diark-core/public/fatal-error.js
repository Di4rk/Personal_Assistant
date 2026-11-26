window.addEventListener("error", function (event) {
  console.error("[DIARK Fatal Script Error]:", event.error || event.message);
  var errDiv = document.getElementById("fatal-error-overlay");
  if (!errDiv) {
    errDiv = document.createElement("div");
    errDiv.id = "fatal-error-overlay";
    errDiv.style.cssText =
      "position:fixed;inset:0;background:#09090b;color:#f87171;padding:32px;font-family:monospace;z-index:999999;display:flex;flex-direction:column;gap:16px;overflow:auto;";
    if (document.body) {
      document.body.appendChild(errDiv);
    } else {
      window.addEventListener("DOMContentLoaded", function () {
        document.body.appendChild(errDiv);
      });
    }
  }
  errDiv.textContent = "";
  var title = document.createElement("h2");
  title.style.cssText = "color:#ef4444;font-size:16px;margin:0;";
  title.textContent = "[DIARK Fatal Error]";

  var pre = document.createElement("pre");
  pre.style.cssText =
    "background:#18181b;padding:16px;border-radius:8px;border:1px solid #3f3f46;color:#f4f4f5;font-size:12px;white-space:pre-wrap;";
  pre.textContent = event.error
    ? event.error.stack || event.error.message
    : String(event.message || "");

  var loc = document.createElement("p");
  loc.style.cssText = "color:#a1a1aa;font-size:12px;";
  loc.textContent =
    "Xảy ra tại: " + (event.filename || "") + ":" + (event.lineno || "");

  errDiv.appendChild(title);
  errDiv.appendChild(pre);
  errDiv.appendChild(loc);
});
