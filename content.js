// Parley — content script: LIVE streaming, glass panel w/ logo, emoji + Done, refine, read.
(function () {
    if (window.__parleyLoaded) return;
    window.__parleyLoaded = true;
  
    const BACKEND_HTTP = "http://localhost:4141";
    const BACKEND_WS = "ws://localhost:4141/stream";
    const SAMPLE_RATE = 16000;
    const EMOJIS = ["😊", "👍", "🎉", "✅", "🙏", "🔥", "💯", "😅"];
  
    let lastField = null;
    document.addEventListener("focusin", (e) => { if (isEditable(e.target)) lastField = e.target; }, true);
    function isEditable(el) {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      return tag === "textarea" || tag === "input" || el.isContentEditable;
    }
  
    const host = document.createElement("div");
    host.id = "parley-root";
    host.innerHTML = `
      <div class="parley-glass" id="parley-glass">
        <button class="g-close" id="parley-gclose">✕</button>
        <div class="parley-brand">
          <span class="parley-logo">
            <svg viewBox="0 0 48 48"><defs><linearGradient id="plg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B5BF5"/><stop offset="1" stop-color="#22C7E6"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#plg)"/><g stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M18 19V29M23 14V34M28 17V31M33 21V27"/></g></svg>
          </span>
          <span class="parley-name">Parley</span>
        </div>
        <div class="g-label"><span class="g-dot"></span><span id="parley-glabel">Listening</span></div>
        <div class="g-text empty" id="parley-gtext">Speak now…</div>
        <div class="parley-emoji-row" id="parley-emoji-row"></div>
        <div class="g-foot" id="parley-foot" style="display:none">
          <button class="g-btn" id="parley-emoji-btn">😊 Emoji</button>
          <button class="g-btn done" id="parley-done-btn">✓ Done</button>
        </div>
      </div>
      <div class="parley-pill" id="parley-pill" data-state="idle">
        <div class="parley-main">
          <div class="parley-orb pill-square">
            <svg viewBox="0 0 48 48" width="30" height="30"><defs><linearGradient id="plq" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B5BF5"/><stop offset="1" stop-color="#22C7E6"/></linearGradient></defs><rect width="48" height="48" rx="14" fill="url(#plq)"/><g stroke="#fff" stroke-width="3.5" stroke-linecap="round"><path d="M18 19V29M23 13V35M28 17V31M33 21V27"/></g></svg>
          </div>
          <div class="parley-wave" id="parley-wave"></div>
          <div class="parley-text" id="parley-text">Click to speak</div>
          <button class="parley-btn" id="parley-btn">Speak</button>
        </div>
        <div class="parley-actions" id="parley-actions" style="display:none">
          <button class="parley-act" data-act="email">✉️ Draft email</button>
          <button class="parley-act" data-act="formal">Formal</button>
          <button class="parley-act" data-act="casual">Casual</button>
          <button class="parley-act" data-act="warm">Warm</button>
          <button class="parley-act" data-act="read">🔊 Read</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
  
    const pill = host.querySelector("#parley-pill");
    const waveEl = host.querySelector("#parley-wave");
    const textEl = host.querySelector("#parley-text");
    const btn = host.querySelector("#parley-btn");
    const actions = host.querySelector("#parley-actions");
    const glass = host.querySelector("#parley-glass");
    const glabel = host.querySelector("#parley-glabel");
    const gtext = host.querySelector("#parley-gtext");
    const gclose = host.querySelector("#parley-gclose");
    const foot = host.querySelector("#parley-foot");
    const emojiRow = host.querySelector("#parley-emoji-row");
    const emojiBtn = host.querySelector("#parley-emoji-btn");
    const doneBtn = host.querySelector("#parley-done-btn");
  
    let audioCtx, stream, source, proc, analyser, micData;
    let recording = false, raf = null;
    let ws = null, finalText = "", partialText = "", lastText = "";
  
    EMOJIS.forEach((em) => {
      const b = document.createElement("button");
      b.textContent = em;
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); insertText(" " + em); });
      emojiRow.appendChild(b);
    });
    emojiBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); emojiRow.classList.toggle("show"); });
  
    function finishSession() {
      glass.classList.remove("show"); emojiRow.classList.remove("show");
      foot.style.display = "none"; actions.style.display = "none";
      textEl.textContent = "Speak"; pill.dataset.state = "idle";
      lastText = ""; finalText = ""; partialText = "";
    }
    doneBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finishSession(); });
    gclose.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finishSession(); });
  
    const BARS = 14, bars = [];
    for (let i = 0; i < BARS; i++) { const b = document.createElement("i"); waveEl.appendChild(b); bars.push(b); }
  
    function showGlass(label, text, empty, showDot) {
      glabel.textContent = label; gtext.textContent = text;
      gtext.classList.toggle("empty", !!empty);
      glass.classList.add("show");
      glass.querySelector(".g-dot").style.display = showDot ? "block" : "none";
    }
  
    function floatToPCM16(float32) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) { let s = Math.max(-1, Math.min(1, float32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; }
      return out.buffer;
    }
    async function initMic() {
      if (audioCtx) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 64;
      micData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      proc = audioCtx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => { if (recording && ws && ws.readyState === WebSocket.OPEN) ws.send(floatToPCM16(e.inputBuffer.getChannelData(0))); };
      source.connect(proc); proc.connect(audioCtx.destination);
    }
    function loop() {
      let amp = 0.3;
      if (analyser) { analyser.getByteFrequencyData(micData); let s = 0; for (let i = 0; i < micData.length; i++) s += micData[i]; amp = Math.min(1, (s / micData.length) / 90); }
      for (let i = 0; i < BARS; i++) { const c = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2); bars[i].style.height = (3 + amp * 16 * (0.4 + 0.6 * c)).toFixed(1) + "px"; }
      if (recording) raf = requestAnimationFrame(loop);
    }
    function restBars() { bars.forEach(b => b.style.height = "3px"); }
  
    function insertText(txt) {
      const el = lastField && document.contains(lastField) ? lastField : (isEditable(document.activeElement) ? document.activeElement : null);
      if (!el) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
      el.focus();
      if (el.isContentEditable) { document.execCommand("insertText", false, txt); }
      else {
        const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + txt + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + txt.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    function replaceFieldContent(txt) {
      const el = lastField && document.contains(lastField) ? lastField : (isEditable(document.activeElement) ? document.activeElement : null);
      if (!el) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
      el.focus();
      if (el.isContentEditable) { const sel = window.getSelection(); sel.selectAllChildren(el); document.execCommand("insertText", false, txt); }
      else { el.value = txt; el.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  
    function openSocket() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(BACKEND_WS); ws.binaryType = "arraybuffer";
        let opened = false;
        ws.onopen = () => { opened = true; resolve(); };
        ws.onerror = () => { if (!opened) reject(new Error("WebSocket failed")); };
        ws.onmessage = (evt) => {
          let msg; try { msg = JSON.parse(evt.data); } catch { return; }
          if (msg.type === "error") { showGlass("Error", msg.message || "Stream error", true, false); return; }
          const t = msg.text || msg.transcript || "";
          if (msg.type === "partial") { partialText = t; showGlass("Listening", (finalText + " " + partialText).trim(), false, true); }
          else if (msg.type === "final") { finalText = (finalText + " " + t).trim(); partialText = ""; showGlass("Listening", finalText, false, true); }
        };
        ws.onclose = () => {};
      });
    }
  
    async function startRec() {
      try { await initMic(); } catch (e) { textEl.textContent = "Allow the mic"; return; }
      if (audioCtx.state === "suspended") await audioCtx.resume();
      finalText = ""; partialText = ""; lastText = "";
      actions.style.display = "none"; foot.style.display = "none"; emojiRow.classList.remove("show");
      try { await openSocket(); }
      catch (e) { textEl.textContent = "Start the Parley server"; showGlass("Offline", "Start the Parley server (localhost:4141)", true, false); return; }
      recording = true;
      pill.dataset.state = "rec"; btn.textContent = "Stop"; textEl.textContent = "Listening…";
      showGlass("Listening", "Speak now…", true, true);
      loop();
    }
    async function stopRec() {
      if (!recording) return;
      recording = false; cancelAnimationFrame(raf); restBars();
      pill.dataset.state = "idle"; btn.textContent = "Speak";
      try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "stop" })); ws.close(); } } catch {}
      const out = (finalText + " " + partialText).trim();
      if (!out) { showGlass("Hmm", "No speech detected — try again", true, false); textEl.textContent = "Speak"; return; }
      lastText = out;
      showGlass("Your words", out, false, false);
      insertText(out);
      textEl.textContent = "Refine ↓";
      actions.style.display = "flex"; foot.style.display = "flex";
    }
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); recording ? stopRec() : startRec(); });
  
    async function refine(action) {
      if (!lastText) return;
      showGlass("Thinking", "Refining…", true, false);
      try {
        const r = await fetch(BACKEND_HTTP + "/refine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: lastText, action }) });
        const data = await r.json();
        if (!r.ok || data.error) { showGlass("Error", data.error || "Refine failed", true, false); return; }
        const result = data.result || "";
        if (!result) { showGlass("Hmm", "No result", true, false); return; }
        replaceFieldContent(result); lastText = result;
        showGlass("Refined ✓", result, false, false);
        foot.style.display = "flex"; textEl.textContent = "Speak";
      } catch (e) { showGlass("Error", "Refine failed — is the server running?", true, false); }
    }
  
    let currentAudio = null;
    async function readAloud() {
      if (currentAudio) { currentAudio.pause(); currentAudio = null; textEl.textContent = "Speak"; return; }
      if (!lastText) return;
      try {
        const r = await fetch(BACKEND_HTTP + "/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: lastText }) });
        if (!r.ok) { textEl.textContent = "Read failed"; return; }
        const blob = await r.blob();
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.onended = () => { currentAudio = null; textEl.textContent = "Speak"; };
        currentAudio.play();
        textEl.textContent = "🔊 Reading…";
      } catch (e) { textEl.textContent = "Read failed"; currentAudio = null; }
    }
  
    actions.addEventListener("click", (e) => {
      const b = e.target.closest(".parley-act"); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const act = b.dataset.act;
      if (act === "read") readAloud(); else refine(act);
    });
  
    restBars();
  })();