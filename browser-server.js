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

function attachLiveTranscription(server, pyai) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname !== "/stream") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

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

    hear = pyai.audio.transcriptions.stream({
      webSocket: WebSocket,
      model: "pyai-hear",
      language: params.get("language") || "en",
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

// --- Groq LLM: refine text ---
const REFINE_PROMPTS = {
  email:  "Turn the following spoken note into a clean, well-formatted email. Add a subject line (prefix it with 'Subject: '), a greeting, well-structured body paragraphs, and a sign-off. Keep the sender's intent. Output only the email.",
  formal: "Rewrite the following text in a professional, formal tone. Keep the meaning. Output only the rewritten text.",
  casual: "Rewrite the following text in a relaxed, friendly, casual tone. Keep the meaning. Output only the rewritten text.",
  warm:   "Rewrite the following text to sound warmer and more empathetic, while staying professional. Output only the rewritten text.",
  fix:    "Fix the grammar, punctuation, and capitalization of the following text. Do not change the wording otherwise. Output only the corrected text."
};
async function refineText(text, action) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY is not set on the server");
  const system = REFINE_PROMPTS[action] || REFINE_PROMPTS.fix;
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GROQ_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      messages: [{ role: "system", content: system }, { role: "user", content: text }]
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error("Groq error: " + t.slice(0, 200)); }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function main() {
  const { default: PyAI } = await import("@pyai/sdk");
  const pyai = new PyAI({ apiKey: KEY });
  const client = new OpenAI({ apiKey: KEY, baseURL: "https://api.pyai.com/v1" });

const server = http.createServer(async (req, res) => {
  // let the Parley extension (any page) call this backend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // health check
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/health"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, groq: Boolean(GROQ_KEY) }));
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

attachLiveTranscription(server, pyai);

server.listen(4141, () => {
  console.log("\n  Parley backend running →  http://localhost:4141");
  console.log("  Live STT WebSocket     →  ws://localhost:4141/stream");
  console.log("  Groq (refine): " + (GROQ_KEY ? "enabled" : "NOT set") + "\n");
});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});