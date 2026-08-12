# Parley

Voice dictation Chrome extension with a local backend. Click the pill on any page, speak, and your words appear where your cursor is. After dictation you can draft emails, change tone, or read text aloud.

## Stack

| Layer | Technology |
|-------|------------|
| **Browser UI** | Chrome Extension (Manifest V3) — `content.js`, `content.css`, `popup.html` |
| **Local backend** | Node.js (`browser-server.js`) on `http://localhost:4141` |
| **Speech-to-text** | [PyAI Hear](https://pyai.com) — live streaming via WebSocket + batch `/transcribe` |
| **Email / tone rewrite** | [Groq](https://groq.com) — `llama-3.3-70b-versatile` via `/refine` |
| **Text-to-speech** | [PyAI Speak](https://pyai.com) — `pyai-voice` via `/speak` |

**npm packages:** `@pyai/sdk`, `openai` (PyAI-compatible client), `ws`, `dotenv`

Keys live only in `.env` on your machine. The extension never sees API keys — it calls `localhost:4141`.

## API keys

| Key (in `.env`) | Used for | Required? |
|-----------------|----------|-----------|
| `PYAI_API_KEY` | **Speech-to-text** (live `ws://…/stream` + batch `/transcribe`) and **read aloud** (`/speak`) | Yes |
| `GROQ_API_KEY` | **Draft email**, Formal, Casual, Warm, and grammar fix (`/refine`) | Yes, for refine features |

### Speech-to-text flow

1. Extension captures mic audio (PCM16, 16 kHz).
2. Audio streams to `ws://localhost:4141/stream`.
3. Backend relays to PyAI Hear (`pyai-hear`) using `PYAI_API_KEY`.
4. Partial and final transcripts stream back to the browser.

### Email / rewrite flow

1. You click **Draft email** (or Formal, Casual, etc.) after dictating.
2. Extension sends transcribed text to `POST /refine` with an `action` (`email`, `formal`, …).
3. Backend calls Groq chat completions with `GROQ_API_KEY` and returns polished text.

There is no separate “summarize email” API — **Draft email** turns your spoken note into a formatted email (subject, greeting, body, sign-off).

## Prerequisites

- **Node.js 18+**
- **Google Chrome** (or Chromium)
- **PyAI API key** — [console.pyai.com](https://console.pyai.com) (needs `hear:stream` and `hear:transcribe` for STT; `voice:synthesize` for read-aloud)
- **Groq API key** — [console.groq.com](https://console.groq.com) (for draft email and tone tools)

## Clone and run locally

### 1. Clone the repo

```bash
git clone https://github.com/bops1997/Parley.git
cd parley
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and add your keys:

```env
PYAI_API_KEY=your_pyai_key_here
GROQ_API_KEY=your_groq_key_here
```

### 4. Start the backend

```bash
npm run server
```

You should see:

```
Parley backend running →  http://localhost:4141
Live STT WebSocket     →  ws://localhost:4141/stream
Groq (refine): enabled
```

Leave this terminal running.

### 5. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `parley` project folder (the one containing `manifest.json`)

### 6. Use Parley

1. Open any webpage with a text field (Gmail, Notion, etc.)
2. Click into the field, then click the **Parley** pill (bottom of the page)
3. Click **Speak**, allow microphone access, and talk
4. Click **Stop** — text is inserted at your cursor
5. Optional: **Draft email**, **Formal**, **Casual**, **Warm**, or **Read**

The extension popup shows whether the backend is connected.

## Backend endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Health check |
| `WS` | `/stream` | Live speech-to-text (PyAI Hear) |
| `POST` | `/transcribe` | Batch WAV → text (PyAI Hear) |
| `POST` | `/refine` | Rewrite / draft email (Groq) |
| `POST` | `/speak` | Text → audio (PyAI Speak) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| “Start the Parley server” | Run `npm run server` from the project root |
| “PYAI_API_KEY is not set” | Add the key to `.env` and restart the server |
| Refine / Draft email fails | Set `GROQ_API_KEY` in `.env` |
| No speech detected | Check mic permissions; speak clearly after **Speak** |
| Gibberish transcription | Mic should stream at 16 kHz PCM16 (handled by the extension) |
