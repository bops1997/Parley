// Parley — local backend. Serves nothing much; proxies audio to PyAI Hear (transcribe),
// text to PyAI Speak (talk-back), and text to Groq (refine: draft email, tone, grammar).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const http = require("http");
const fs = require("fs");
const os = require("os");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const OpenAI = require("openai");

const KEY = process.env.PYAI_API_KEY;
if (!KEY) {
  console.error("\n  PYAI_API_KEY is not set. Add it to .env (see .env.example)\n");
  process.exit(1);
}
const GROQ_KEY = process.env.GROQ_API_KEY; // optional; refine falls back to an error if missing

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function omniControlFrame(body) {
  return Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify(body), "utf8")]);
}

const OMNI_CONFIGURE = {
  type: "configure",
  voice_id: "stock_dorit_en_us",
  language: "en",
  persona: `You are Parley, a hands-free writing assistant embedded in the browser.
The user edits text in a web form. Help them dictate, refine, translate, and review text entirely by voice.
When they ask to change tone, call refine_text (formal, casual, warm, fix, or email).
When they ask to translate, call translate_text with the target ISO language code (hi, es, fr, de, ta, etc.).
When they ask to hear it, call read_text_back. When they ask to clear or delete, call clear_field.
When they ask what's written, call get_current_text. You cannot click Send for them — say the text is ready in their field.
Keep replies brief and conversational.`,
  tools: [
    {
      name: "refine_text",
      description: "Rewrite the text currently in the user's field",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["formal", "casual", "warm", "fix", "email"], description: "Tone or format" }
        },
        required: ["action"]
      }
    },
    {
      name: "translate_text",
      description: "Translate the field text to a target language",
      parameters: {
        type: "object",
        properties: {
          target_language: { type: "string", description: "ISO-639-1 code, e.g. hi, es, fr, de, ta" }
        },
        required: ["target_language"]
      }
    },
    { name: "read_text_back", description: "Read the current field text aloud", parameters: { type: "object", properties: {} } },
    { name: "clear_field", description: "Clear/delete all text in the focused field", parameters: { type: "object", properties: {} } },
    {
      name: "get_current_text",
      description: "Return the current text in the user's field",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "insert_dictated_text",
      description: "Insert or replace field text with dictated/transcribed content",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to put in the field" } },
        required: ["text"]
      }
    }
  ]
};

function attachLiveTranscription(pyai) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (client, req) => {
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    const sampleRate = Number(params.get("sample_rate")) || 16000;
    let hear = null;
    let closed = false;

    function closeBoth(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      try { hear?.close(code, reason); } catch {}
      try { if (client.readyState === WebSocket.OPEN) client.close(code, reason); } catch {}
    }

    // PyAI Hear is English-only (docs: language=en); target language → POST /translate
    hear = pyai.audio.transcriptions.stream({
      webSocket: WebSocket,
      model: "pyai-hear",
      language: "en",
      sampleRate,
      encoding: "pcm16",
      interimResults: true,
      endpointingMs: params.has("endpointing_ms") ? Number(params.get("endpointing_ms")) : undefined,
      query: { protocol: "pyai-hear-v1" },
      onOpen: () => sendJson(client, { type: "ready", sample_rate: sampleRate }),
      onPartial: (frame) => sendJson(client, frame),
      onFinal: (frame) => sendJson(client, frame),
      onUsage: (frame) => sendJson(client, frame),
      onError: (err) => {
        if (err && typeof err === "object" && err.type === "error") sendJson(client, err);
        else sendJson(client, { type: "error", code: "relay_error", message: err?.message || "stream error" });
      },
      onClose: () => closeBoth(),
    });

    client.on("message", (data, isBinary) => {
      if (closed || hear.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        hear.sendAudio(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "commit") hear.commit();
      else if (msg.type === "config") hear.socket.send(JSON.stringify(msg));
      else if (msg.type === "EOF") hear.commit();
    });

    client.on("close", () => closeBoth());
    client.on("error", () => closeBoth(1011, "client error"));
  });

  return wss;
}

function attachOmniRelay() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (client) => {
    let pyaiWs = null;
    let closed = false;

    function closeBoth(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      try { pyaiWs?.close(code, reason); } catch {}
      try { if (client.readyState === WebSocket.OPEN) client.close(code, reason); } catch {}
    }

    pyaiWs = new WebSocket("wss://api.pyai.com/v1/omni?format=pcm16&rate=24000", [`pyai-key.${KEY}`]);
    pyaiWs.binaryType = "nodebuffer";

    pyaiWs.on("open", () => {
      pyaiWs.send(omniControlFrame(OMNI_CONFIGURE));
      sendJson(client, { type: "omni_ready" });
    });

    pyaiWs.on("message", (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });

    pyaiWs.on("close", (code, reason) => {
      sendJson(client, { type: "omni_closed", code, reason: reason?.toString() || "" });
      closeBoth();
    });

    pyaiWs.on("error", (err) => {
      sendJson(client, {
        type: "omni_error",
        code: "omni_relay_error",
        message: err?.message || "Omni connection error (check omni:session scope on your PyAI key)"
      });
      closeBoth(1011, "omni error");
    });

    pyaiWs.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        sendJson(client, {
          type: "omni_error",
          code: res.statusCode,
          message: body.slice(0, 240) || `Omni HTTP ${res.statusCode}`
        });
        closeBoth();
      });
    });

    client.on("message", (data, isBinary) => {
      if (closed || pyaiWs.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        const buf = Buffer.from(data);
        if (buf[0] === 0x01) pyaiWs.send(buf);
        else pyaiWs.send(Buffer.concat([Buffer.from([0x01]), buf]));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "tool_result" || msg.type === "session_ending") {
        pyaiWs.send(omniControlFrame(msg));
      }
    });

    client.on("close", () => closeBoth());
    client.on("error", () => closeBoth(1011, "client error"));
  });

  return wss;
}

function cleanup(t) {
  if (!t) return "";
  let s = t.trim().replace(/\b(um+|uh+|erm+|hmm+)\b/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  if (s) s = s[0].toUpperCase() + s.slice(1);
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s;
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// --- Groq LLM: refine, translate, compose (PyAI has no text LLM / translation API) ---
const TARGET_LANGUAGES = {
  en: "English", hi: "Hindi", es: "Spanish", fr: "French", de: "German", ta: "Tamil",
  pt: "Portuguese", zh: "Chinese (Simplified)", ja: "Japanese", ar: "Arabic", it: "Italian"
};
const INSTRUCTION_RE = /^\s*(write|draft|reply|compose|tell|ask|send|create|make|email|respond|decline|thank|request|follow up|follow-up)\b/i;

const REFINE_PROMPTS = {
  email:  "Turn the following spoken note into a clean, well-formatted email. Add a subject line (prefix it with 'Subject: '), a greeting, well-structured body paragraphs, and a sign-off. Keep the sender's intent. Output only the email.",
  formal: "Rewrite the following text in a professional, formal tone. Keep the meaning. Output only the rewritten text.",
  casual: "Rewrite the following text in a relaxed, friendly, casual tone. Keep the meaning. Output only the rewritten text.",
  warm:   "Rewrite the following text to sound warmer and more empathetic, while staying professional. Output only the rewritten text.",
  fix:    "Fix the grammar, punctuation, and capitalization of the following text. Do not change the wording otherwise. Output only the corrected text."
};

function isInstruction(text) {
  return INSTRUCTION_RE.test((text || "").trim());
}

async function groqChat(system, user, temperature = 0.4) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY is not set on the server");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GROQ_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error("Groq error: " + t.slice(0, 200)); }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function refineText(text, action) {
  return groqChat(REFINE_PROMPTS[action] || REFINE_PROMPTS.fix, text);
}

async function translateText(text, targetCode) {
  const langName = TARGET_LANGUAGES[targetCode];
  if (!langName) throw new Error("unsupported target language");
  const system = `You are an expert translator. Translate the user's text into natural, fluent ${langName}.
The input may be English, Hinglish (Hindi+English code-mixed), Tamil-English mix, or other messy speech-to-text output — infer the intended meaning and render it cleanly in ${langName}.
Preserve proper nouns, email addresses, numbers, and formatting cues. Output only the translated text.`;
  return groqChat(system, text, 0.3);
}

async function composeText(instruction, mode, threadContext) {
  if (mode === "reply" && threadContext) {
    const system = `You are an email assistant. The user spoke a brief reply intent. Using the email thread below as context, write a complete, ready-to-send email reply that fulfills their intent.
Match the thread's tone unless the instruction says otherwise. Include greeting and sign-off. Do not invent facts not supported by the thread or instruction. Output only the reply body (no meta commentary).`;
    const user = `EMAIL THREAD:\n${threadContext.slice(0, 6000)}\n\n---\nUSER'S REPLY INTENT (spoken):\n${instruction}`;
    return groqChat(system, user, 0.5);
  }
  const system = `You are an email assistant. The user spoke an instruction describing what email to write — NOT the email text itself.
Compose a complete, ready-to-send email from that instruction. Include Subject: line, greeting, body, and sign-off.
Infer reasonable details when missing (use placeholders like [Date] only if truly unknown). Output only the email.`;
  return groqChat(system, instruction, 0.5);
}

function parseJsonFromLLM(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("voice turn: invalid JSON from model");
  return JSON.parse(m[0]);
}

async function voiceTurn(utterance, fieldText, threadContext) {
  const system = `You are Parley, a friendly voice writing assistant. The user speaks to you in real time.
Return ONLY a JSON object (no markdown) with:
- "reply": one short spoken sentence acknowledging the user FIRST (warm, e.g. "Sure, let me format that as an email for you.")
- "follow_up": optional short sentence after the action completes (e.g. "All done — it's in your field."). Empty string if none.
- "action": one of: dictate | refine | compose | translate | read | clear | stop | none
- "param": optional string — for refine: formal|casual|warm|fix|email; for translate: ISO-639-1 code (hi, es, …); for compose: draft|reply
- "insert_text": optional string — for dictate, the exact text to insert (omit command phrases)

Rules:
- "write this as an email" / "format as email" with existing field text → action refine, param email
- "write/draft/compose an email to …" (instruction, not existing body) → action compose, param draft
- "reply to this" / "reply in context" with thread → action compose, param reply
- "make it warmer/formal/casual" → action refine, param warm|formal|casual
- "translate to Hindi/Spanish/…" → action translate, param language code
- "read it back" → action read
- "clear/delete that" → action clear
- "stop voice" / "goodbye" → action stop
- If the user is clearly dictating content (not commanding), action dictate with insert_text = their words (cleaned)
- If unclear but conversational, action none with a helpful reply only
- reply must NEVER be empty`;

  const user = `Current field text:\n${(fieldText || "").slice(0, 2500) || "(empty)"}\n\n${
    threadContext ? `Email thread context:\n${threadContext.slice(0, 1500)}\n\n` : ""
  }User just said:\n${utterance}`;

  const raw = await groqChat(system, user, 0.35);
  const parsed = parseJsonFromLLM(raw);
  const action = String(parsed.action || "none").toLowerCase();
  const allowed = new Set(["dictate", "refine", "compose", "translate", "read", "clear", "stop", "none"]);
  return {
    reply: String(parsed.reply || "Okay.").slice(0, 300),
    follow_up: String(parsed.follow_up || "").slice(0, 300),
    action: allowed.has(action) ? action : "none",
    param: parsed.param ? String(parsed.param).slice(0, 32) : "",
    insert_text: parsed.insert_text ? String(parsed.insert_text).slice(0, 4000) : ""
  };
}

async function main() {
  const { default: PyAI } = await import("@pyai/sdk");
  const pyai = new PyAI({ apiKey: KEY });
  const client = new OpenAI({ apiKey: KEY, baseURL: "https://api.pyai.com/v1" });

  let omniAvailable = false;
  try {
    const me = await fetch("https://api.pyai.com/v1/me", { headers: { Authorization: "Bearer " + KEY } });
    if (me.ok) {
      const d = await me.json();
      const scopes = d.scopes || [];
      omniAvailable = scopes.some((s) => s === "omni:session" || String(s).startsWith("omni:"));
    }
  } catch {}

const server = http.createServer(async (req, res) => {
  // let the Parley extension (any page) call this backend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // health check
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/health"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      groq: Boolean(GROQ_KEY),
      hear: "pyai-hear (en only)",
      omni_available: omniAvailable,
      omni: omniAvailable ? "pyai-omni via ws://localhost:4141/omni" : "unavailable (key lacks omni:session — voice mode uses Hear+Speak)",
      translate: Boolean(GROQ_KEY),
      compose: Boolean(GROQ_KEY),
      voice_turn: Boolean(GROQ_KEY)
    }));
    return;
  }

  // HEAR: wav -> text
  if (req.method === "POST" && req.url === "/transcribe") {
    const tmp = path.join(os.tmpdir(), `wf-${Date.now()}.wav`);
    try {
      fs.writeFileSync(tmp, await readBody(req));
      const r = await client.audio.transcriptions.create({ file: fs.createReadStream(tmp), model: "pyai-hear" });
      const raw = r.text || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ raw, clean: cleanup(raw) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.error?.message || err?.message || "Transcription failed" }));
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    return;
  }

  // REFINE: text + action -> polished text (Groq)
  if (req.method === "POST" && req.url === "/refine") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const text = (body.text || "").slice(0, 4000);
      const action = body.action || "fix";
      if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
      const result = await refineText(text, action);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "refine failed" }));
    }
    return;
  }

  // TRANSLATE: text + target_language -> translated text (Groq; PyAI Hear has no translation)
  if (req.method === "POST" && req.url === "/translate") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const text = (body.text || "").slice(0, 4000);
      const target = (body.target_language || "").slice(0, 8);
      if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
      if (!target || target === "auto" || target === "en") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: text, skipped: true }));
        return;
      }
      if (!TARGET_LANGUAGES[target]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported target language" }));
        return;
      }
      const result = await translateText(text, target);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result, target_language: target }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "translate failed" }));
    }
    return;
  }

  // COMPOSE: instruction -> full email, or reply intent + thread context (Groq)
  if (req.method === "POST" && req.url === "/compose") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const text = (body.text || "").slice(0, 4000);
      const mode = body.mode === "reply" ? "reply" : "draft";
      const threadContext = (body.thread_context || "").slice(0, 8000);
      if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
      if (mode === "reply" && !threadContext) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "thread_context required for reply mode" }));
        return;
      }
      const result = await composeText(text, mode, threadContext);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result, mode, instruction: isInstruction(text) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "compose failed" }));
    }
    return;
  }

  // VOICE TURN: utterance + context -> spoken reply + action (Groq brain for Hear+Speak voice mode)
  if (req.method === "POST" && req.url === "/voice-turn") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const utterance = (body.utterance || "").slice(0, 2000);
      const fieldText = (body.field_text || "").slice(0, 4000);
      const threadContext = (body.thread_context || "").slice(0, 8000);
      if (!utterance) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no utterance" }));
        return;
      }
      const turn = await voiceTurn(utterance, fieldText, threadContext);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(turn));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "voice turn failed" }));
    }
    return;
  }

  // SPEAK: text -> audio (PyAI)
  if (req.method === "POST" && req.url === "/speak") {
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const text = (body.text || "").slice(0, 2000);
      if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
      const r = await fetch("https://api.pyai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "pyai-voice", input: text })
      });
      if (!r.ok) { const t = await r.text(); res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Speak failed: " + t.slice(0, 200) })); return; }
      const audio = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length });
      res.end(audio);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "Speak error" }));
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

const streamWss = attachLiveTranscription(pyai);
const omniWss = attachOmniRelay();

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/stream") {
    streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit("connection", ws, req));
  } else if (pathname === "/omni") {
    omniWss.handleUpgrade(req, socket, head, (ws) => omniWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(4141, () => {
  console.log("\n  Parley backend running →  http://localhost:4141");
  console.log("  Live STT WebSocket     →  ws://localhost:4141/stream");
  console.log("  Omni voice WebSocket   →  ws://localhost:4141/omni (" + (omniAvailable ? "enabled" : "NOT available — voice mode falls back to Hear+Speak") + ")");
  console.log("  Groq (refine/translate/compose): " + (GROQ_KEY ? "enabled" : "NOT set") + "\n");
});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});