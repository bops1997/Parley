// Runs in page MAIN world via chrome.scripting.executeScript (world: "MAIN").
(function () {
  if (window.__parleyWakeBridge) {
    window.postMessage({ source: "parley-wake", type: "ready", detail: "ok" }, "*");
    return;
  }
  window.__parleyWakeBridge = true;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let enabled = false;
  let buffer = "";

  function post(type, detail) {
    window.postMessage({ source: "parley-wake", type, detail: detail ?? null }, "*");
  }

  function matchesWake(text) {
    const t = text.toLowerCase().replace(/[^\w\s]/g, " ");
    return /\bhey\b/.test(t) && /\bparle\w*/.test(t);
  }

  function stopWake() {
    enabled = false;
    buffer = "";
    if (rec) {
      try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch {}
      rec = null;
    }
  }

  function startWake() {
    if (!SR) { post("unsupported"); return; }
    if (enabled) return;
    stopWake();
    enabled = true;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        buffer = (buffer + " " + e.results[i][0].transcript).slice(-400);
        if (matchesWake(buffer)) {
          buffer = "";
          stopWake();
          post("detected");
          return;
        }
      }
    };

    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      post("error", ev.error || "unknown");
    };

    rec.onend = () => {
      if (!enabled) return;
      try { rec.start(); } catch (err) { post("error", String(err)); enabled = false; }
    };

    try {
      rec.start();
      post("listening");
    } catch (err) {
      enabled = false;
      post("error", String(err));
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "parley-content") return;
    if (e.data.type === "wake-control") e.data.enabled ? startWake() : stopWake();
    if (e.data.type === "wake-ping") post("ready", SR ? "ok" : "unsupported");
  });

  post("ready", SR ? "ok" : "unsupported");
})();
