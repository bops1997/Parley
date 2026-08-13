// Parley — streaming STT, translation, compose, wake word, field hints, PyAI Omni voice mode.
(function () {
  const PARLEY_UI_VERSION = "1.2.5";
  const existingRoot = document.getElementById("parley-root");
  if (existingRoot?.dataset.parleyVersion === PARLEY_UI_VERSION) return;
  if (existingRoot) existingRoot.remove();
  document.getElementById("parley-field-hint-root")?.remove();
  window.__parleyLoaded = true;

  const BACKEND_HTTP = "http://localhost:4141";
  const BACKEND_WS = "ws://localhost:4141/stream";
  const BACKEND_OMNI = "ws://localhost:4141/omni";
  const HEAR_RATE = 16000;
  const OMNI_RATE = 24000;
  const WAKE_PHRASE = /\bhey[\s,]+parley\b/i;
  const EMOJIS = ["😊", "👍", "🎉", "✅", "🙏", "🔥", "💯", "😅"];
  const INSTRUCTION_RE = /^\s*(write|draft|reply|compose|tell|ask|send|create|make|email|respond|decline|thank|request|follow up|follow-up)\b/i;

  const LANGUAGES = [
    { code: "auto", label: "Auto-detect" },
    { code: "en", label: "English" },
    { code: "hi", label: "Hindi" },
    { code: "es", label: "Spanish" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
    { code: "ta", label: "Tamil" },
    { code: "pt", label: "Portuguese" },
    { code: "zh", label: "Chinese" },
    { code: "ja", label: "Japanese" },
    { code: "ar", label: "Arabic" }
  ];

  let lastField = null;
  let wakeWordEnabled = false;
  let fieldHintEnabled = true;
  let voiceModeEnabled = false;
  let voiceModePending = false;
  let voiceModeKind = null; // "omni" | "hear"
  let voicePending = "";
  let voiceBusy = false;
  let voiceSpeakChain = Promise.resolve();
  let wakeBridgeReady = false;

  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image"].includes(type);
    }
    return el.isContentEditable;
  }

  function isInstruction(text) {
    return INSTRUCTION_RE.test((text || "").trim());
  }

  function getGmailThreadContext() {
    if (!/mail\.google\.com/i.test(location.hostname)) return "";
    const parts = [];
    const seen = new Set();
    for (const sel of [".a3s.aiL", "div.a3s", "[data-message-id] .a3s", ".gs .a3s"]) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.innerText || "").trim();
        if (t.length < 20 || seen.has(t)) return;
        seen.add(t);
        parts.push(t);
      });
      if (parts.length) break;
    }
    return parts.join("\n---\n").slice(0, 8000);
  }

  const LOGO_URL = chrome.runtime.getURL("icon128.png");
  const langOptions = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join("");

  const host = document.createElement("div");
  host.id = "parley-root";
  host.dataset.parleyVersion = PARLEY_UI_VERSION;
  host.innerHTML = `
    <div class="parley-backdrop" id="parley-backdrop"></div>
    <div class="parley-glass" id="parley-glass">
      <button class="g-close" id="parley-gclose" aria-label="Close"><svg viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10"/></svg></button>
      <div class="parley-brand" id="parley-brand">
        <span class="parley-logo">
          <svg viewBox="0 0 48 48"><defs><linearGradient id="plg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="0.55" stop-color="#A78BFA"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#plg)"/><g stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M18 19V29M23 14V34M28 17V31M33 21V27"/></g></svg>
        </span>
        <span class="parley-name-wrap">
          <span class="parley-name">Parley</span>
          <span class="parley-tagline">Voice writing assistant</span>
        </span>
      </div>
      <div class="parley-lang-row">
        <label class="parley-lang-label" for="parley-lang">Output language</label>
        <select class="parley-lang-select" id="parley-lang">${langOptions}</select>
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
      <div class="parley-grip" id="parley-grip" title="Drag to move">⠿</div>
      <div class="parley-main">
        <img class="parley-logo pill-logo" src="${LOGO_URL}" width="30" height="30" alt="" draggable="false">
        <div class="parley-wave" id="parley-wave"></div>
        <div class="parley-text" id="parley-text">Click to speak</div>
        <button class="parley-btn" id="parley-btn">Speak</button>
      </div>
      <div class="parley-actions" id="parley-actions" style="display:none">
        <button class="parley-act" data-act="email">✉️ Draft email</button>
        <button class="parley-act parley-reply-ctx" data-act="reply-ctx" style="display:none">↩ Reply in context</button>
        <button class="parley-act" data-act="formal">Formal</button>
        <button class="parley-act" data-act="casual">Casual</button>
        <button class="parley-act" data-act="warm">Warm</button>
        <button class="parley-act" data-act="read">🔊 Read</button>
        <button class="parley-act parley-voice-toggle" data-act="voice">🎙 Voice mode</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const hintRoot = document.createElement("div");
  hintRoot.id = "parley-field-hint-root";
  document.documentElement.appendChild(hintRoot);

  const pill = host.querySelector("#parley-pill");
  const waveEl = host.querySelector("#parley-wave");
  const textEl = host.querySelector("#parley-text");
  const btn = host.querySelector("#parley-btn");
  const actions = host.querySelector("#parley-actions");
  const replyCtxBtn = host.querySelector(".parley-reply-ctx");
  const voiceToggleBtn = host.querySelector(".parley-voice-toggle");
  const glass = host.querySelector("#parley-glass");
  const backdrop = host.querySelector("#parley-backdrop");
  const glabel = host.querySelector("#parley-glabel");
  const gtext = host.querySelector("#parley-gtext");
  const gclose = host.querySelector("#parley-gclose");
  const foot = host.querySelector("#parley-foot");
  const emojiRow = host.querySelector("#parley-emoji-row");
  const emojiBtn = host.querySelector("#parley-emoji-btn");
  const doneBtn = host.querySelector("#parley-done-btn");
  const grip = host.querySelector("#parley-grip");
  const brand = host.querySelector("#parley-brand");
  const langSelect = host.querySelector("#parley-lang");

  let targetLanguage = "auto";
  let audioCtx, hearStream, hearSource, hearProc, analyser, micData;
  let recording = false, raf = null;
  let ws = null, finalText = "", partialText = "", lastText = "", rawTranscript = "";

  // Wake word via MAIN-world bridge (SpeechRecognition fails in extension isolated world)
  let wakeListening = false;
  let wakeBridgeInjected = false;

  // Field hint
  let fieldHintEl = null;
  let hintField = null;

  // Omni voice mode (PyAI Omni via backend relay)
  let omniWs = null;
  let omniReady = false;
  let omniCtx, omniMicStream, omniSource, omniProc;
  let omniUserTranscript = "";
  let omniPlaybackTime = 0;
  let omniPlaying = [];

  function setMicActive(on) {
    host.classList.toggle("parley-mic-active", !!on);
  }

  function setPillState(state) {
    pill.dataset.state = state || "idle";
    if (state === "wake") textEl.textContent = "Hey Parley…";
    else if (state === "voice") textEl.textContent = voiceModeKind === "omni" ? "Omni on" : "Voice on";
    else if (state === "rec") textEl.textContent = "Listening…";
    else if (!recording && !voiceModeEnabled && !wakeListening) textEl.textContent = "Click to speak";
  }

  function normalizeSettings(data) {
    const s = data?.parleySettings || {};
    return {
      parleyWakeWord: typeof s.wakeWord === "boolean" ? s.wakeWord : !!data?.parleyWakeWord,
      parleyFieldHint: typeof s.fieldHint === "boolean" ? s.fieldHint : data?.parleyFieldHint !== false,
      parleyVoiceMode: typeof s.voiceMode === "boolean" ? s.voiceMode : !!data?.parleyVoiceMode,
      parleyTargetLang: s.targetLang || data?.parleyTargetLang || "auto"
    };
  }

  function applySettings(data) {
    if (data?.parleyTargetLang) {
      targetLanguage = data.parleyTargetLang;
      langSelect.value = targetLanguage;
    }
    wakeWordEnabled = !!data?.parleyWakeWord;
    fieldHintEnabled = data?.parleyFieldHint !== false;
    const wantVoice = !!data?.parleyVoiceMode;
    voiceToggleBtn.classList.toggle("active", wantVoice);
    if (wantVoice && !voiceModeEnabled) {
      voiceModePending = true;
      textEl.textContent = "Click 🎙 Voice";
    } else if (!wantVoice) {
      voiceModePending = false;
      if (voiceModeEnabled) stopVoiceMode();
    }
    if (!fieldHintEnabled) hideFieldHint();
    applyWakeWordSetting();
  }

  function loadSettings() {
    chrome.storage.local.get(["parleySettings", "parleyWakeWord", "parleyFieldHint", "parleyVoiceMode", "parleyTargetLang"], (data) => {
      applySettings(normalizeSettings(data));
    });
  }

  function persistPartialSettings(partial) {
    chrome.runtime.sendMessage({ type: "PARLEY_SAVE_SETTINGS", settings: partial }).catch(() => {});
  }

  langSelect.addEventListener("change", () => {
    targetLanguage = langSelect.value;
    persistPartialSettings({ targetLang: targetLanguage });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.parleySettings || changes.parleyWakeWord || changes.parleyFieldHint || changes.parleyVoiceMode || changes.parleyTargetLang) {
      chrome.storage.local.get(["parleySettings", "parleyWakeWord", "parleyFieldHint", "parleyVoiceMode", "parleyTargetLang"], (data) => {
        applySettings(normalizeSettings(data));
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PARLEY_SETTINGS_UPDATED") loadSettings();
  });

  EMOJIS.forEach((em) => {
    const b = document.createElement("button");
    b.textContent = em;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); insertText(" " + em); });
    emojiRow.appendChild(b);
  });
  emojiBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); emojiRow.classList.toggle("show"); });

  function updateReplyContextButton() {
    const thread = getGmailThreadContext();
    replyCtxBtn.style.display = thread ? "inline-flex" : "none";
  }

  function finishSession() {
    glass.classList.remove("show");
    backdrop?.classList.remove("show");
    emojiRow.classList.remove("show");
    foot.style.display = "none";
    actions.style.display = voiceModeEnabled ? "flex" : "none";
    lastText = "";
    rawTranscript = "";
    finalText = "";
    partialText = "";
    if (!voiceModeEnabled && !wakeListening) setPillState("idle");
  }
  doneBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finishSession(); });
  gclose.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finishSession(); });
  backdrop?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finishSession(); });

  const BARS = 14, bars = [];
  for (let i = 0; i < BARS; i++) { const b = document.createElement("i"); waveEl.appendChild(b); bars.push(b); }

  function showGlass(label, text, empty, showDot) {
    glabel.textContent = label;
    gtext.textContent = text;
    gtext.classList.remove("parley-text-in");
    void gtext.offsetWidth;
    gtext.classList.add("parley-text-in");
    gtext.classList.toggle("empty", !!empty);
    glass.classList.add("show");
    backdrop?.classList.add("show");
    glass.querySelector(".g-dot").style.display = showDot ? "block" : "none";
    updateReplyContextButton();
  }

  function floatToPCM16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out.buffer;
  }

  function taggedOmni(tag, payload) {
    const body = payload instanceof ArrayBuffer ? new Uint8Array(payload) : new TextEncoder().encode(payload);
    const frame = new Uint8Array(body.byteLength + 1);
    frame[0] = tag;
    frame.set(body, 1);
    return frame.buffer;
  }

  async function initHearMic() {
    if (audioCtx) return;
    hearStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: HEAR_RATE });
    hearSource = audioCtx.createMediaStreamSource(hearStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    micData = new Uint8Array(analyser.frequencyBinCount);
    hearSource.connect(analyser);
    hearProc = audioCtx.createScriptProcessor(4096, 1, 1);
    hearProc.onaudioprocess = (e) => {
      const pcm = floatToPCM16(e.inputBuffer.getChannelData(0));
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (recording) ws.send(pcm);
      if (voiceModeEnabled && voiceModeKind === "hear") ws.send(pcm);
    };
    hearSource.connect(hearProc);
    hearProc.connect(audioCtx.destination);
  }

  function loop() {
    let amp = 0.3;
    if (analyser) {
      analyser.getByteFrequencyData(micData);
      let s = 0;
      for (let i = 0; i < micData.length; i++) s += micData[i];
      amp = Math.min(1, (s / micData.length) / 90);
    }
    for (let i = 0; i < BARS; i++) {
      const c = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
      bars[i].style.height = (3 + amp * 16 * (0.4 + 0.6 * c)).toFixed(1) + "px";
    }
    if (recording || voiceModeEnabled) raf = requestAnimationFrame(loop);
  }
  function restBars() { bars.forEach((b) => { b.style.height = "3px"; }); }

  function getTargetField() {
    return lastField && document.contains(lastField)
      ? lastField
      : (isEditable(document.activeElement) ? document.activeElement : null);
  }

  function insertText(txt) {
    const el = getTargetField();
    if (!el) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
    el.focus();
    if (el.isContentEditable) document.execCommand("insertText", false, txt);
    else {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + txt + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + txt.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function replaceFieldContent(txt) {
    const el = getTargetField();
    if (!el) { navigator.clipboard.writeText(txt).catch(() => {}); return; }
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      document.execCommand("insertText", false, txt);
    } else {
      el.value = txt;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function getFieldText() {
    const el = getTargetField();
    if (!el) return lastText || rawTranscript || "";
    if (el.isContentEditable) return (el.innerText || "").trim();
    return (el.value || "").trim();
  }

  function speakBrief(line) {
    if (!line) return Promise.resolve();
    voiceSpeakChain = voiceSpeakChain.then(async () => {
      try {
        const r = await fetch(BACKEND_HTTP + "/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: line.slice(0, 200) })
        });
        if (!r.ok) return;
        const blob = await r.blob();
        const a = new Audio(URL.createObjectURL(blob));
        await new Promise((res) => {
          a.onended = res;
          a.onerror = res;
          a.play().catch(res);
        });
      } catch {}
    });
    return voiceSpeakChain;
  }

  async function composeTextOnly(mode, threadContext, text) {
    const body = { text, mode };
    if (threadContext) body.thread_context = threadContext;
    const r = await fetch(BACKEND_HTTP + "/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || "Compose failed");
    const result = data.result || "";
    if (!result) throw new Error("No result");
    replaceFieldContent(result);
    lastText = result;
    return result;
  }

  async function executeVoiceAction(turn, utterance) {
    const { action, param, insert_text } = turn;
    switch (action) {
      case "none":
      case "stop":
        return;
      case "clear":
        replaceFieldContent("");
        lastText = "";
        rawTranscript = "";
        return;
      case "read": {
        const t = lastText || getFieldText();
        if (!t) throw new Error("Nothing to read");
        lastText = t;
        await readAloud();
        return;
      }
      case "dictate": {
        const t = insert_text || utterance;
        lastText = t;
        rawTranscript = t;
        insertText(t);
        return;
      }
      case "refine": {
        lastText = lastText || getFieldText() || rawTranscript;
        if (!lastText) throw new Error("Nothing to refine yet");
        await refineTextOnly(param || "fix");
        return;
      }
      case "compose": {
        const mode = param === "reply" ? "reply" : "draft";
        const thread = mode === "reply" ? getGmailThreadContext() : "";
        await composeTextOnly(mode, thread, utterance);
        return;
      }
      case "translate": {
        const code = (param || "hi").slice(0, 8);
        langSelect.value = code;
        targetLanguage = code;
        persistPartialSettings({ targetLang: code });
        const src = lastText || getFieldText() || rawTranscript;
        if (!src) throw new Error("Nothing to translate yet");
        const translated = await translateIfNeeded(src, true);
        replaceFieldContent(translated);
        lastText = translated;
        return;
      }
      default:
        return;
    }
  }

  async function processVoiceCommand(utterance) {
    if (voiceBusy || !voiceModeEnabled) return;
    voiceBusy = true;
    showGlass("Voice mode", "Thinking…", true, false);
    try {
      const r = await fetch(BACKEND_HTTP + "/voice-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterance,
          field_text: getFieldText(),
          thread_context: getGmailThreadContext()
        })
      });
      const turn = await r.json();
      if (!r.ok || turn.error) throw new Error(turn.error || "Voice turn failed");

      showGlass("Parley", turn.reply, false, false);
      await speakBrief(turn.reply);

      await executeVoiceAction(turn, utterance);

      if (turn.follow_up) {
        showGlass("Parley", turn.follow_up, false, false);
        await speakBrief(turn.follow_up);
      } else if (turn.action && !["none", "stop", "read"].includes(turn.action)) {
        await speakBrief("All set.");
      }

      if (turn.action === "stop") {
        stopVoiceMode();
        return;
      }
    } catch (e) {
      showGlass("Voice mode", e.message || "Something went wrong", true, false);
      await speakBrief("Sorry, I couldn't do that.");
    } finally {
      voiceBusy = false;
      if (voiceModeEnabled) showGlass("Voice mode", "Listening…", true, true);
    }
  }

  function handleStreamFrame(msg) {
    if (msg.type === "error") {
      showGlass("Error", msg.message || "Stream error", true, false);
      return;
    }
    const t = msg.text || msg.transcript || "";
    if (voiceModeEnabled && voiceModeKind === "hear") {
      if (msg.type === "partial" || msg.type === "partial_stable") {
        voicePending = t;
        showGlass("Voice mode", voicePending, false, true);
      } else if (msg.type === "final" || msg.type === "speech_final") {
        const utterance = t.trim();
        voicePending = "";
        if (utterance) processVoiceCommand(utterance);
        else showGlass("Voice mode", "Listening for commands…", true, true);
      }
      return;
    }
    if (msg.type === "partial" || msg.type === "partial_stable") {
      partialText = t;
      showGlass("Listening", (finalText + " " + partialText).trim(), false, true);
    } else if (msg.type === "final" || msg.type === "speech_final") {
      finalText = (finalText + " " + t).trim();
      partialText = "";
      showGlass("Listening", finalText, false, true);
    }
  }

  function openSocket() {
    const url = `${BACKEND_WS}?sample_rate=${HEAR_RATE}&language=en`;
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      let opened = false;
      ws.onopen = () => { opened = true; resolve(); };
      ws.onerror = () => { if (!opened) reject(new Error("WebSocket failed")); };
      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        handleStreamFrame(msg);
      };
      ws.onclose = () => {};
    });
  }

  async function translateIfNeeded(text, silent) {
    const target = langSelect.value || targetLanguage;
    if (!target || target === "auto" || target === "en") return text;
    if (!silent) showGlass("Translating", "Translating…", true, false);
    try {
      const r = await fetch(BACKEND_HTTP + "/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target_language: target })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || "Translation failed");
      return data.result || text;
    } catch (e) {
      if (!silent) {
        showGlass("Translation skipped", (e.message || "Translation failed") + " — kept original.", false, false);
        await new Promise((res) => setTimeout(res, 900));
      }
      return text;
    }
  }

  function injectWakeBridge() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "INJECT_WAKE_BRIDGE" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          wakeBridgeInjected = false;
          resolve(false);
          return;
        }
        wakeBridgeInjected = true;
        window.postMessage({ source: "parley-content", type: "wake-ping" }, "*");
        resolve(true);
      });
    });
  }

  function postWakeControl(enabled) {
    window.postMessage({ source: "parley-content", type: "wake-control", enabled: !!enabled }, "*");
  }

  function onWakeBridgeMessage(e) {
    if (e.source !== window || e.data?.source !== "parley-wake") return;
    switch (e.data.type) {
      case "ready":
        wakeBridgeReady = e.data.detail !== "unsupported";
        if (wakeWordEnabled && !recording && !voiceModeEnabled && wakeBridgeReady) {
          textEl.textContent = "Click page → Hey Parley";
          setPillState("wake");
        }
        break;
      case "listening":
        wakeListening = true;
        setMicActive(true);
        setPillState("wake");
        textEl.textContent = "Say Hey Parley…";
        break;
      case "detected":
        wakeListening = false;
        postWakeControl(false);
        pill.classList.add("parley-wake-flash");
        setTimeout(() => pill.classList.remove("parley-wake-flash"), 600);
        startRec({ fromWake: true });
        break;
      case "unsupported":
        wakeListening = false;
        textEl.textContent = "Wake word unavailable";
        break;
      case "error":
        wakeListening = false;
        if (e.data.detail === "not-allowed") textEl.textContent = "Allow mic for wake word";
        else if (wakeWordEnabled) textEl.textContent = "Wake word paused — click pill";
        break;
      default:
        break;
    }
  }
  window.addEventListener("message", onWakeBridgeMessage);

  function stopWakeWord() {
    wakeListening = false;
    postWakeControl(false);
    if (!recording && !voiceModeEnabled) {
      setMicActive(false);
      if (!voiceModePending) setPillState("idle");
      else textEl.textContent = "Click 🎙 Voice";
    }
  }

  function applyWakeWordSetting() {
    if (wakeWordEnabled && !recording && !voiceModeEnabled) {
      injectWakeBridge().then((ok) => {
        if (!ok) textEl.textContent = "Wake word unavailable";
      });
    } else {
      stopWakeWord();
      wakeBridgeReady = false;
    }
  }

  async function startWakeWord() {
    if (!wakeWordEnabled || recording || voiceModeEnabled) return;
    if (!wakeBridgeReady) {
      textEl.textContent = "Starting wake word…";
      const ok = await injectWakeBridge();
      if (!ok) { textEl.textContent = "Wake word failed — refresh page"; return; }
      await new Promise((r) => setTimeout(r, 100));
    }
    postWakeControl(true);
  }

  function positionFieldHint() {
    if (!fieldHintEl || !hintField || !document.contains(hintField)) return;
    const r = hintField.getBoundingClientRect();
    fieldHintEl.style.top = Math.max(4, r.top + r.height / 2 - 14) + "px";
    fieldHintEl.style.left = Math.min(window.innerWidth - 90, r.right + 8) + "px";
  }

  function hideFieldHint() {
    fieldHintEl?.remove();
    fieldHintEl = null;
    hintField = null;
  }

  function showFieldHint(el) {
    if (!fieldHintEnabled || recording || voiceModeEnabled) return;
    hideFieldHint();
    hintField = el;
    lastField = el;
    fieldHintEl = document.createElement("button");
    fieldHintEl.type = "button";
    fieldHintEl.className = "parley-field-hint";
    fieldHintEl.textContent = "🎙 Speak";
    fieldHintEl.title = "Dictate into this field";
    fieldHintEl.addEventListener("mousedown", (e) => e.preventDefault());
    fieldHintEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastField = el;
      el.focus();
      startRec();
    });
    hintRoot.appendChild(fieldHintEl);
    positionFieldHint();
  }

  document.addEventListener("focusin", (e) => {
    if (isEditable(e.target)) {
      lastField = e.target;
      if (fieldHintEnabled) showFieldHint(e.target);
    }
  }, true);

  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (hintField && document.activeElement !== hintField) hideFieldHint();
    }, 120);
  }, true);

  window.addEventListener("scroll", positionFieldHint, true);
  window.addEventListener("resize", positionFieldHint);

  async function startRec(opts = {}) {
    if (recording || voiceModeEnabled) return;
    stopWakeWord();
    hideFieldHint();
    try { await initHearMic(); } catch {
      textEl.textContent = "Allow the mic";
      applyWakeWordSetting();
      return;
    }
    if (audioCtx.state === "suspended") await audioCtx.resume();
    finalText = "";
    partialText = "";
    lastText = "";
    rawTranscript = "";
    actions.style.display = "none";
    foot.style.display = "none";
    emojiRow.classList.remove("show");
    try { await openSocket(); }
    catch {
      textEl.textContent = "Start the Parley server";
      showGlass("Offline", "Start the Parley server (localhost:4141)", true, false);
      applyWakeWordSetting();
      return;
    }
    recording = true;
    setMicActive(true);
    setPillState("rec");
    btn.textContent = "Stop";
    showGlass("Listening", opts.fromWake ? "Hey Parley — speak now…" : "Speak now…", true, true);
    loop();
  }

  async function stopRec() {
    if (!recording) return;
    recording = false;
    cancelAnimationFrame(raf);
    restBars();
    btn.textContent = "Speak";
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "commit" }));
        await new Promise((res) => setTimeout(res, 400));
        ws.close();
      }
    } catch {}
    const out = (finalText + " " + partialText).trim();
    if (!out) {
      showGlass("Hmm", "No speech detected — try again", true, false);
      setMicActive(false);
      setPillState("idle");
      applyWakeWordSetting();
      return;
    }
    rawTranscript = out;
    let displayText = out;
    const target = langSelect.value || targetLanguage;
    if (target && target !== "auto" && target !== "en") displayText = await translateIfNeeded(out);
    lastText = displayText;
    const hint = isInstruction(rawTranscript) ? " (instruction detected)" : "";
    showGlass("Your words" + hint, displayText, false, false);
    insertText(displayText);
    textEl.textContent = "Refine ↓";
    actions.style.display = "flex";
    foot.style.display = "flex";
    setMicActive(false);
    setPillState("idle");
    updateReplyContextButton();
    applyWakeWordSetting();
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (voiceModeEnabled) return;
    recording ? stopRec() : startRec();
  });

  // One click anywhere on the page unlocks mic for wake word (browser requirement)
  function unlockWakeOnGesture() {
    if (wakeWordEnabled && !wakeListening && !recording && !voiceModeEnabled) startWakeWord();
  }
  document.addEventListener("click", unlockWakeOnGesture, true);
  document.addEventListener("keydown", unlockWakeOnGesture, true);

  async function refineTextOnly(action) {
    if (!lastText) throw new Error("No text to refine");
    const r = await fetch(BACKEND_HTTP + "/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lastText, action })
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || "Refine failed");
    const result = data.result || "";
    if (!result) throw new Error("No result");
    replaceFieldContent(result);
    lastText = result;
    return result;
  }

  async function refine(action) {
    if (!lastText) return;
    showGlass("Thinking", "Refining…", true, false);
    try {
      const result = await refineTextOnly(action);
      showGlass("Refined ✓", result, false, false);
      foot.style.display = "flex";
      textEl.textContent = "Speak";
    } catch (e) {
      showGlass("Error", e.message || "Refine failed", true, false);
    }
  }

  async function compose(mode, threadContext) {
    if (!lastText && !rawTranscript) return;
    const text = lastText || rawTranscript;
    showGlass("Thinking", mode === "reply" ? "Drafting reply…" : "Composing email…", true, false);
    try {
      const body = { text, mode };
      if (threadContext) body.thread_context = threadContext;
      const r = await fetch(BACKEND_HTTP + "/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || "Compose failed");
      const result = data.result || "";
      if (!result) throw new Error("No result");
      replaceFieldContent(result);
      lastText = result;
      showGlass("Composed ✓", result, false, false);
      foot.style.display = "flex";
      textEl.textContent = "Speak";
    } catch (e) {
      showGlass("Error", e.message || "Compose failed", true, false);
    }
  }

  async function draftEmail() {
    const source = rawTranscript || lastText;
    if (!source) return;
    if (isInstruction(source)) await compose("draft");
    else await refine("email");
  }

  async function replyInContext() {
    const thread = getGmailThreadContext();
    if (!thread) {
      showGlass("No thread", "Open a Gmail reply with visible thread text.", true, false);
      return;
    }
    lastText = lastText || rawTranscript;
    if (!lastText) return;
    await compose("reply", thread);
  }

  let currentAudio = null;
  async function readAloud() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      if (!voiceModeEnabled) textEl.textContent = "Speak";
      return;
    }
    if (!lastText) return;
    const r = await fetch(BACKEND_HTTP + "/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lastText })
    });
    if (!r.ok) throw new Error("Read failed");
    const blob = await r.blob();
    currentAudio = new Audio(URL.createObjectURL(blob));
    currentAudio.onended = () => {
      currentAudio = null;
      if (!voiceModeEnabled) textEl.textContent = "Speak";
    };
    await currentAudio.play();
    if (!voiceModeEnabled) textEl.textContent = "🔊 Reading…";
  }

  function clearOmniPlayback() {
    omniPlaying.forEach((s) => { try { s.stop(); } catch {} });
    omniPlaying = [];
    omniPlaybackTime = omniCtx ? omniCtx.currentTime : 0;
  }

  function playOmniPcm(pcmBuf) {
    if (!omniCtx) return;
    const int16 = new Int16Array(pcmBuf);
    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 0x8000;
    const buf = omniCtx.createBuffer(1, floats.length, OMNI_RATE);
    buf.copyToChannel(floats, 0);
    const src = omniCtx.createBufferSource();
    src.buffer = buf;
    src.connect(omniCtx.destination);
    const startAt = Math.max(omniPlaybackTime, omniCtx.currentTime);
    src.start(startAt);
    omniPlaybackTime = startAt + buf.duration;
    omniPlaying.push(src);
    src.onended = () => { omniPlaying = omniPlaying.filter((x) => x !== src); };
  }

  async function initOmniMic() {
    omniMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    omniCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OMNI_RATE });
    omniSource = omniCtx.createMediaStreamSource(omniMicStream);
    omniProc = omniCtx.createScriptProcessor(4096, 1, 1);
    omniProc.onaudioprocess = (e) => {
      if (voiceModeEnabled && omniReady && omniWs && omniWs.readyState === WebSocket.OPEN) {
        omniWs.send(taggedOmni(0x01, floatToPCM16(e.inputBuffer.getChannelData(0))));
      }
    };
    omniSource.connect(omniProc);
    omniProc.connect(omniCtx.destination);
    if (omniCtx.state === "suspended") await omniCtx.resume();
  }

  async function handleOmniToolCall(msg) {
    const { call_id, name, arguments: args = {} } = msg;
    let result = {};
    let error = null;
    try {
      switch (name) {
        case "refine_text":
          result = { text: await refineTextOnly(args.action || "fix") };
          break;
        case "translate_text": {
          const code = (args.target_language || "hi").slice(0, 8);
          langSelect.value = code;
          targetLanguage = code;
          persistPartialSettings({ targetLang: code });
          const src = lastText || rawTranscript || "";
          if (!src) throw new Error("No text to translate");
          const translated = await translateIfNeeded(src, true);
          replaceFieldContent(translated);
          lastText = translated;
          result = { text: translated };
          break;
        }
        case "read_text_back":
          await readAloud();
          result = { ok: true };
          break;
        case "clear_field":
          replaceFieldContent("");
          lastText = "";
          rawTranscript = "";
          result = { ok: true };
          break;
        case "get_current_text":
          result = { text: lastText || getTargetField()?.value || "" };
          break;
        case "insert_dictated_text":
          replaceFieldContent(args.text || "");
          lastText = args.text || "";
          rawTranscript = lastText;
          result = { ok: true, text: lastText };
          break;
        default:
          error = "Unknown tool: " + name;
      }
    } catch (e) {
      error = e.message || "Tool failed";
    }
    if (omniWs && omniWs.readyState === WebSocket.OPEN) {
      omniWs.send(JSON.stringify(error
        ? { type: "tool_result", call_id, error }
        : { type: "tool_result", call_id, result }));
    }
  }

  function handleOmniEvent(msg) {
    switch (msg.event) {
      case "flush":
        clearOmniPlayback();
        break;
      case "tool_call":
        handleOmniToolCall(msg);
        break;
      case "turn":
        if (msg.role === "user" && omniUserTranscript.trim()) {
          lastText = omniUserTranscript.trim();
          rawTranscript = lastText;
          insertText(lastText);
          omniUserTranscript = "";
        }
        break;
      case "session_end":
        stopVoiceMode();
        break;
      default:
        break;
    }
  }

  async function startHearVoiceMode() {
    voiceModeKind = "hear";
    voiceModeEnabled = true;
    voiceModePending = false;
    voicePending = "";
    persistPartialSettings({ voiceMode: true });
    stopWakeWord();
    hideFieldHint();
    try {
      await initHearMic();
      if (audioCtx.state === "suspended") await audioCtx.resume();
    } catch {
      textEl.textContent = "Allow the mic";
      voiceModeKind = null;
      voiceModeEnabled = false;
      voiceModePending = true;
      voiceToggleBtn.classList.add("active");
      return;
    }
    try { await openSocket(); }
    catch {
      showGlass("Error", "Voice mode failed — is the server running?", true, false);
      voiceModeKind = null;
      voiceModeEnabled = false;
      return;
    }
    voiceToggleBtn.classList.add("active");
    setMicActive(true);
    setPillState("voice");
    actions.style.display = "flex";
    showGlass(
      "Voice mode",
      "Talk naturally — e.g. “write this as an email”, “make it warmer”, or just dictate.",
      false,
      true
    );
    speakBrief("Hi, I'm Parley. Tell me what you'd like — for example, write this as an email.");
    loop();
  }

  async function startOmniVoiceMode() {
    voiceModeKind = "omni";
    voiceModeEnabled = true;
    voiceModePending = false;
    persistPartialSettings({ voiceMode: true });
    stopWakeWord();
    hideFieldHint();
    try { await initOmniMic(); }
    catch {
      textEl.textContent = "Allow the mic";
      voiceModeKind = null;
      voiceModeEnabled = false;
      voiceModePending = true;
      voiceToggleBtn.classList.add("active");
      return;
    }
    voiceToggleBtn.classList.add("active");
    setMicActive(true);
    setPillState("voice");
    actions.style.display = "flex";
    showGlass("Voice mode (Omni)", "Talk to Parley — full duplex voice agent.", false, false);

    omniWs = new WebSocket(BACKEND_OMNI);
    omniWs.binaryType = "arraybuffer";
    omniReady = false;
    const decoder = new TextDecoder();

    omniWs.onmessage = (evt) => {
      if (typeof evt.data === "string") {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "omni_ready") { omniReady = true; return; }
          if (msg.type === "omni_error") {
            showGlass("Omni unavailable", msg.message || "Falling back to Hear + Speak…", true, false);
            stopVoiceMode(false);
            startHearVoiceMode();
            return;
          }
          handleOmniEvent(msg);
        } catch {}
        return;
      }
      const frame = new Uint8Array(evt.data);
      const tag = frame[0];
      const body = frame.subarray(1);
      if (tag === 0x01) playOmniPcm(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      else if (tag === 0x02) omniUserTranscript += decoder.decode(body);
      else if (tag === 0x03) {
        try { handleOmniEvent(JSON.parse(decoder.decode(body))); } catch {}
      }
    };

    omniWs.onclose = () => {
      if (voiceModeEnabled && voiceModeKind === "omni") {
        stopVoiceMode(false);
        startHearVoiceMode();
      }
    };

    omniWs.onerror = () => {
      if (voiceModeEnabled && voiceModeKind === "omni") {
        stopVoiceMode(false);
        startHearVoiceMode();
      }
    };

    loop();
  }

  async function startVoiceMode() {
    if (voiceModeEnabled || recording) return;
    let omniAvailable = false;
    try {
      const health = await fetch(BACKEND_HTTP + "/").then((r) => r.json());
      omniAvailable = !!health.omni_available;
    } catch {}
    if (omniAvailable) await startOmniVoiceMode();
    else await startHearVoiceMode();
  }

  function stopVoiceMode(persist = true) {
    if (!voiceModeEnabled && !voiceModePending && persist) return;
    const wasKind = voiceModeKind;
    voiceModeEnabled = false;
    voiceModePending = false;
    voiceModeKind = null;
    voicePending = "";
    if (persist) persistPartialSettings({ voiceMode: false });
    voiceToggleBtn.classList.remove("active");
    clearOmniPlayback();
    try {
      if (omniWs && omniWs.readyState === WebSocket.OPEN) {
        omniWs.send(JSON.stringify({ type: "session_ending" }));
        omniWs.close();
      }
    } catch {}
    omniWs = null;
    omniReady = false;
    omniUserTranscript = "";
    if (wasKind === "hear" && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "commit" })); ws.close(); } catch {}
    }
    try { omniProc?.disconnect(); omniSource?.disconnect(); omniMicStream?.getTracks().forEach((t) => t.stop()); } catch {}
    omniProc = omniSource = omniMicStream = null;
    if (omniCtx) { try { omniCtx.close(); } catch {} omniCtx = null; }
    cancelAnimationFrame(raf);
    restBars();
    setMicActive(false);
    setPillState("idle");
    applyWakeWordSetting();
  }

  actions.addEventListener("click", (e) => {
    const b = e.target.closest(".parley-act");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === "read") readAloud().catch(() => { textEl.textContent = "Read failed"; });
    else if (act === "email") draftEmail();
    else if (act === "reply-ctx") replyInContext();
    else if (act === "voice") {
      if (voiceModeEnabled) stopVoiceMode();
      else startVoiceMode();
    }
    else refine(act);
  });

  function dragByHandle(el, handle) {
    if (!handle) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.style.cursor = "grab";
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      el.style.position = "fixed";
      el.style.left = ox + "px";
      el.style.top = oy + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.margin = "0";
      el.style.transform = "none";
      handle.style.cursor = "grabbing";
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => { dragging = false; handle.style.cursor = "grab"; });
  }

  pill.style.display = "flex";
  pill.style.alignItems = "center";
  dragByHandle(pill, grip);
  dragByHandle(glass, brand);
  restBars();
  updateReplyContextButton();
  loadSettings();
})();
