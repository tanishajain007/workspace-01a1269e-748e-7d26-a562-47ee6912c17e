# Gemini Chat — free-tier chatbot in plain HTML, CSS and JavaScript

A complete, production-shaped chat client for the **Gemini API free tier**.
No frameworks, no build step, no runtime dependencies — just `index.html`, one
stylesheet and four plain scripts.

```
gemini-chat/
├── index.html          structure, icons, settings dialog
├── css/styles.css      theming (dark/light), layout, markdown styling
├── js/config.js        model catalogue, safety categories, default settings
├── js/gemini.js        the API client: request building, SSE, retries, errors, quota
├── js/markdown.js      dependency-free, XSS-safe Markdown → HTML renderer
├── js/app.js           UI: state, rendering, events, persistence
├── server.mjs          optional zero-dependency dev server + secure key proxy
├── .env                ← put your API key here (git-ignored)
├── .env.example        template
├── .gitignore
└── tests/              55 tests (unit + jsdom DOM + live HTTP)
```

---

## 1. Quick start

```bash
cd gemini-chat

# 1. add your key (free: https://aistudio.google.com/apikey)
#    edit .env and replace YOUR_GEMINI_API_KEY_HERE

# 2. serve it (browsers cannot read local files from file://)
node server.mjs            # → http://localhost:8000
# or, without Node:
python3 -m http.server 8000

# 3. open http://localhost:8000 and type a message
```

Opening `index.html` by double-clicking it (`file://`) **will not work**:
browsers block `fetch('.env')` on the `file://` protocol. Use either fallback:
run the server above, or paste the key into **Settings → Connection** (it is
then stored in `localStorage` for that browser only).

## 2. The two models you asked for

Both are real, documented model codes and both are free of charge on the free
tier. One important detail, straight from Google's model docs (checked
2026-10-10):

| Model code | Status | Notes |
|---|---|---|
| `gemini-3.6-flash` | **Stable**, free | Previous-generation Flash. 1,048,576 input / 65,536 output tokens. Default in this app. |
| `gemini-3.7-flash` | **Deprecated**, free | Google's docs state it is *automatically routed to `gemini-3.8-flash`*. Requests succeed, but you are served by 3.8. Supports `thinkingLevel` low/medium/high — `minimal` returns an error. |
| `gemini-3.8-flash` | Stable, free | The newest Flash model; the best free choice for coding and agents. |

The model picker also lists `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`,
`gemini-3-flash-preview`, and the 2.5 family. **Settings → Model → "Live list"**
calls `GET /v1beta/models` and shows exactly what *your* key can reach, which
is the only authoritative answer (access differs per project).

## 3. `.env` handling — how the key is loaded

The browser cannot read environment variables, so the app resolves the key in
this order:

1. `GEMINI_API_KEY` from `.env` (fetched over HTTP and parsed client-side),
2. a key pasted into Settings (stored in `localStorage`),
3. **proxy mode** — `server.mjs` holds the key and forwards requests, so the
   browser never sees it. Set **Settings → Connection → Request mode = Proxy**.

`GOOGLE_API_KEY` and `GEMINI_KEY` are also accepted as variable names. A value
that still looks like a placeholder (`YOUR_…`, `<paste…>`, `xxx…`) is ignored
rather than sent to Google.

```dotenv
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.6-flash
```

## 4. Important points every chatbot needs (and where each one lives)

These are the things that separate a demo from something you can leave running.

**Correctness and API shape**

- **Right endpoint, right method.** Streaming uses
  `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`; the non-streaming
  path uses `:generateContent`. (`js/gemini.js → buildEndpoint`)
- **Key in a header, never the URL.** `x-goog-api-key` keeps the key out of
  server logs, browser history and referrers. (`authHeaders`)
- **Only send fields the model accepts.** `topK` is omitted when blank (2.5 Pro
  rejects it), `thinkingConfig` is sent only for models that support it, and
  empty stop sequences are dropped. Unexpected fields cause `400
  INVALID_ARGUMENT`, the most common Gemini bug. (`buildRequestBody`)
- **System instruction as a first-class field**, not a fake first user message.
- **Multi-turn history with roles.** Gemini expects `role: "user" | "model"`, and
  the first turn must be a user turn — the context trimmer enforces that.

**Streaming**

- **Real SSE parsing**, tolerant of chunks split at any byte, CRLF, comment
  keep-alive lines and the `[DONE]` sentinel. (`createSSEParser`)
- **Incremental rendering** throttled to one `requestAnimationFrame` per frame,
  so long answers do not lock the main thread.
- **Thinking summaries** (`part.thought === true`) are separated from visible
  text instead of being mixed into the answer.

**Errors — the part most demos skip**

- Every Google error is mapped to a human sentence plus a fix:
  `API_KEY_INVALID`, `PERMISSION_DENIED`, `NOT_FOUND` (model unavailable on your
  project), `RESOURCE_EXHAUSTED` (free-tier quota), `INVALID_ARGUMENT`,
  `UNAVAILABLE`. (`mapApiError`)
- **`finishReason` is handled, not ignored**: `MAX_TOKENS` offers *Continue*,
  `SAFETY` / `RECITATION` / `PROHIBITED_CONTENT` explain what was blocked,
  `MALFORMED_FUNCTION_CALL` suggests a retry. (`describeFinishReason`)
- **Prompt-level blocks** (`promptFeedback.blockReason`) are surfaced — a request
  can be refused before generation with an empty `candidates` array.
- **Retry only what is retryable.** 429/500/503 and network faults retry with
  exponential backoff + jitter (capped, max 2 by default). A 400/403/404 is
  *never* retried — retrying a bad key just burns quota. Retries also stop once
  the first token has been emitted, so you never get a duplicated answer.
- **Abort everywhere**: the Stop button cancels the HTTP stream, and the partial
  text is kept and marked `[stopped]`.

**Cost and quota on the free tier**

- **Client-side quota guard** with requests-per-minute, requests-per-day and a
  minimum spacing between calls. The RPD counter resets at **midnight Pacific**,
  matching Google's reset. Real numbers are not published globally — read yours
  at [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) and
  set them (minus a margin) in **Settings → Quota**.
- **Context trimming**: older turns are dropped from the *request* once the
  estimated tokens pass your budget, so a long chat cannot blow past TPM. The
  saved conversation is never truncated — only what is sent.
- **Real token accounting** from `usageMetadata` (input, output, thoughts,
  cached), shown per answer and per session. Cost is $0.00 on the free tier.
- **Images are downscaled** to 1568 px before upload; multimodal input is billed
  and counted against TPM like text.

**Safety and security**

- **All four safety categories** configurable (harassment, hate speech, sexually
  explicit, dangerous content), with `OFF` for 3.x models.
- **XSS-safe rendering.** Model output is HTML-escaped *before* formatting is
  applied, `javascript:`/`data:` links are rejected, and every link gets
  `rel="noopener noreferrer"`. A model can never inject a script tag.
- **A browser-only app cannot hide an API key.** Anyone opening DevTools can read
  it. For anything shared or deployed, use proxy mode, restrict the key in Google
  Cloud Console to the Generative Language API and your origin, and serve over
  HTTPS. The app warns when it detects plain HTTP on a non-local host.
- **Privacy:** on the free tier Google states content may be used to improve its
  products. Do not paste secrets or personal data.

**Product behaviour**

- Multiple conversations, rename, delete, search, **JSON/Markdown export** and
  import; everything persists in `localStorage`.
- Regenerate, **edit-and-resend** (truncates the branch from that message),
  per-message copy, per-code-block copy.
- Persona presets (assistant / engineer / tutor / editor) — the system
  instruction is the single biggest quality lever.
- Temperature, top-P, top-K, max output tokens, stop sequences, thinking level.
- Keyboard: `Enter` send, `Shift+Enter` newline, `Ctrl+K` new chat, `Esc` stop,
  `Ctrl+/` focus. Accessible: labelled controls, `aria-live` on the transcript,
  focus-visible rings, reduced-motion support.
- Dark/light themes, responsive down to a phone, offline detection.

## 5. Two ways to run it

| | **Browser (direct)** | **Proxy (`server.mjs`)** |
|---|---|---|
| Key location | visible in the browser | server-side only |
| Setup | any static server | `node server.mjs` |
| Best for | local tinkering | anything shared, demos, deploys |

The proxy forwards only `generateContent`, `streamGenerateContent`,
`countTokens` and `GET /models` — every other path (uploads, cached contents,
batch) is rejected before it reaches Google. SSE is streamed through
unbuffered.

## 6. Tests

```bash
npm i -D jsdom     # only needed for the DOM tests
npm test           # 55 tests
```

| File | What it actually runs |
|---|---|
| `tests/app.test.mjs` | `.env` parsing, context trimming, request-body building, SSE parsing across chunk boundaries, error mapping, backoff bounds, `generate()` against an injected `fetch` (streaming, 429 retry, invalid key, safety block), `listModels`, the quota guard, the Markdown renderer (including XSS and `javascript:` cases), config sanity, proxy path rules |
| `tests/dom.test.mjs` | boots `index.html` + the real scripts in jsdom and drives the UI: send → stream → rendered markdown and code blocks, invalid-key error path (asserts exactly one API call), `MAX_TOKENS` handling, Stop mid-stream, settings persistence, quota counter |
| `tests/server.test.mjs` | live HTTP against `server.mjs`: content types, dotfile and traversal blocking, hardening headers, method handling, proxy rejections |

The DOM and server tests exercise the shipped `app.js` and `server.mjs`
directly — not reimplementations of them.

## 7. Extending it

- **Grounding with Google Search / Maps, Batch API, Flex:** paid-tier features —
  add them to `tools` in `buildRequestBody` and expect a quota error on a free
  project.
- **Function calling / structured output:** add `tools` or
  `generationConfig.responseSchema`; `gemini.js` already passes a `tools` array
  through.
- **File uploads (PDF/audio/video):** use the Files API (`upload/v1beta/files`),
  then send `fileData.fileUri`. The proxy deliberately blocks that path today.
- **Context caching:** supported by 3.6/3.7/3.8 Flash, but caching storage is a
  paid feature.

## 8. Known limits

- Free-tier rate limits are per **project**, not per key, and Google publishes
  them only in AI Studio — the numbers in Settings are yours to fill in.
- `gemini-3.7-flash` is a deprecated alias; treat it as 3.8 Flash.
- `localStorage` holds roughly 5 MB, so the app keeps the 60 most recent chats
  and warns instead of silently failing when a write is rejected.
- No syntax highlighting: code blocks are escaped and copyable, but not coloured,
  because highlighting needs a dependency (or a lot of grammar tables).
