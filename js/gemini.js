/**
 * gemini.js — everything that talks to (or reasons about) the Gemini REST API.
 *
 * Design rules:
 *   - Every function here is pure or takes its side effects as arguments
 *     (fetchImpl, now, rand, storage), so the whole client can be unit tested
 *     in Node without a browser or an API key.
 *   - The API key is sent as the `x-goog-api-key` header, never in the query
 *     string, so it does not end up in server logs or browser history.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Gemini = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const SAFETY_CATEGORIES = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ];

  // ---------------------------------------------------------------------------
  // .env parsing (works in the browser via fetch('.env') and in Node via fs)
  // ---------------------------------------------------------------------------

  /**
   * Parse a dotenv-style file body.
   * Handles comments, `export `, blank lines, quotes, CRLF and inline comments
   * on unquoted values.
   */
  function parseEnv(text) {
    const out = {};
    String(text || '').split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const withoutExport = line.replace(/^export\s+/, '');
      const eq = withoutExport.indexOf('=');
      if (eq === -1) return;
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      if (!key) return;
      const quoted = /^(".*"|'.*')$/s.test(value);
      if (quoted) {
        value = value.slice(1, -1);
        if (raw.trim().startsWith('"') === false && value.includes('\\"')) {
          value = value.replace(/\\"/g, '"');
        }
      } else {
        const hash = value.indexOf(' #');
        if (hash !== -1) value = value.slice(0, hash).trim();
      }
      out[key] = value;
    });
    return out;
  }

  /** Is this a value that still needs to be replaced by the user? */
  function isPlaceholderKey(value) {
    if (!value) return true;
    return /^(your[_-]?|paste[_-]?|put[_-]?|xxx|changeme|replace)/i.test(value) ||
      /<.*>/.test(value) ||
      value === 'YOUR_GEMINI_API_KEY';
  }

  // ---------------------------------------------------------------------------
  // Token + context helpers
  // ---------------------------------------------------------------------------

  /**
   * Rough token estimate (~4 chars/token for English). Never use this for
   * billing — read `usageMetadata` from the API response for real numbers.
   */
  function estimateTokens(text) {
    const s = String(text || '');
    if (!s) return 0;
    return Math.ceil(s.length / 4);
  }

  function contentTokens(content) {
    const parts = (content && content.parts) || [];
    let chars = 0;
    for (const p of parts) {
      if (typeof p.text === 'string') chars += p.text.length;
      else if (p.inlineData && typeof p.inlineData.data === 'string') {
        // Images/PDFs are billed per API rules; approximate at ~256 tokens each.
        chars += 1024;
      } else if (p.fileData) {
        chars += 1024;
      }
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Convert the app's message objects into Gemini `contents`.
   * message = { role: 'user'|'model', text, images: [{mimeType, data}] }
   */
  function messagesToContents(messages) {
    const contents = [];
    for (const m of messages || []) {
      const parts = [];
      if (m.text && m.text.length) parts.push({ text: m.text });
      for (const img of m.images || []) {
        if (img && img.data) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
      if (!parts.length) continue;
      contents.push({ role: m.role === 'model' ? 'model' : 'user', parts });
    }
    return contents;
  }

  /**
   * Keep the most recent context that fits in `tokenBudget`, always keeping the
   * final turn, and always making sure the first message has role "user"
   * (the API rejects a history that starts with a model turn).
   */
  function trimContext(contents, options) {
    const opts = options || {};
    const budget = Number(opts.tokenBudget) > 0 ? Number(opts.tokenBudget) : Infinity;
    const keep = Math.max(1, Number(opts.alwaysKeep) || 2);
    const list = (contents || []).slice();
    let kept = [];
    let total = 0;

    for (let i = list.length - 1; i >= 0; i--) {
      const cost = contentTokens(list[i]);
      if (kept.length >= keep && total + cost > budget) break;
      kept.unshift(list[i]);
      total += cost;
    }

    while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
    return { contents: kept, estimatedTokens: total, dropped: list.length - kept.length };
  }

  // ---------------------------------------------------------------------------
  // Request construction
  // ---------------------------------------------------------------------------

  function toNumberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parseStopSequences(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  /**
   * Build the generateContent / streamGenerateContent request body.
   * Only well-formed fields are included — an unexpected key or a bad value is
   * how you get a 400 INVALID_ARGUMENT from this API.
   */
  function buildRequestBody(input) {
    const s = input.settings || {};
    const body = { contents: input.contents || [] };

    if (input.systemInstruction && input.systemInstruction.trim()) {
      body.systemInstruction = { parts: [{ text: input.systemInstruction }] };
    }

    const gen = {};
    const temperature = toNumberOrNull(s.temperature);
    const topP = toNumberOrNull(s.topP);
    const topK = toNumberOrNull(s.topK);
    const maxOutputTokens = toNumberOrNull(s.maxOutputTokens);
    if (temperature !== null) gen.temperature = temperature;
    if (topP !== null) gen.topP = topP;
    if (topK !== null) gen.topK = Math.round(topK);
    if (maxOutputTokens !== null && maxOutputTokens > 0) gen.maxOutputTokens = Math.round(maxOutputTokens);
    const stops = parseStopSequences(s.stopSequences);
    if (stops.length) gen.stopSequences = stops;

    const thinkingLevel = s.thinkingLevel && s.thinkingLevel !== 'off' ? s.thinkingLevel : null;
    if (thinkingLevel && input.supportsThinking) {
      gen.thinkingConfig = { thinkingLevel };
    }

    if (Object.keys(gen).length) body.generationConfig = gen;

    const threshold = s.safetyThreshold;
    if (threshold && threshold !== 'DEFAULT') {
      body.safetySettings = SAFETY_CATEGORIES.map((category) => ({ category, threshold }));
    }

    if (input.tools && input.tools.length) body.tools = input.tools;
    return body;
  }

  function buildEndpoint(model, options) {
    const opts = options || {};
    const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
    const method = opts.stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${base}/models/${encodeURIComponent(model)}:${method}`;
    return opts.stream ? `${url}?alt=sse` : url;
  }

  function authHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey || '',
    };
  }

  // ---------------------------------------------------------------------------
  // SSE (server-sent events) parsing
  // ---------------------------------------------------------------------------

  /**
   * Incremental SSE parser. Feed it decoded chunks; get complete events back.
   * Handles events split across chunk boundaries, CRLF, comment lines and the
   * `[DONE]` sentinel.
   */
  function createSSEParser() {
    let buffer = '';
    const events = [];

    function takeLine(line) {
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).replace(/^\s/, '');
      if (data === '[DONE]') { events.push({ done: true }); return; }
      try {
        events.push({ data: JSON.parse(data) });
      } catch (err) {
        events.push({ parseError: String(err && err.message) });
      }
    }

    return {
      push(chunk) {
        buffer += String(chunk);
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          takeLine(line);
        }
        return events.splice(0, events.length);
      },
      flush() {
        if (buffer.trim()) takeLine(buffer.replace(/\r$/, ''));
        buffer = '';
        return events.splice(0, events.length);
      },
      get pending() { return buffer.length; },
    };
  }

  /**
   * Split one streamed chunk into visible text and "thought" (reasoning
   * summary) text, plus metadata.
   */
  function readChunk(chunk) {
    const out = { text: '', thought: '', finishReason: null, usage: null, blocked: null, citations: null };
    if (!chunk || typeof chunk !== 'object') return out;

    if (chunk.promptFeedback && chunk.promptFeedback.blockReason) {
      out.blocked = {
        reason: chunk.promptFeedback.blockReason,
        message: chunk.promptFeedback.blockReasonMessage || '',
      };
    }

    const candidate = (chunk.candidates && chunk.candidates[0]) || null;
    if (candidate) {
      for (const part of candidate.content && candidate.content.parts ? candidate.content.parts : []) {
        if (typeof part.text !== 'string') continue;
        if (part.thought) out.thought += part.text;
        else out.text += part.text;
      }
      if (candidate.finishReason) out.finishReason = candidate.finishReason;
      if (candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) {
        out.citations = candidate.groundingMetadata.groundingChunks
          .map((g) => g.web && g.web.uri)
          .filter(Boolean);
      }
      if (candidate.safetyRatings) out.safetyRatings = candidate.safetyRatings;
    }
    if (chunk.usageMetadata) out.usage = chunk.usageMetadata;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  const FINISH_REASONS = {
    STOP: { label: 'Completed', tone: 'ok', note: '' },
    MAX_TOKENS: { label: 'Hit max output tokens', tone: 'warn', note: 'Raise "Max output tokens" in Settings, or press Continue.' },
    SAFETY: { label: 'Blocked by safety filters', tone: 'error', note: 'Rephrase the request, or relax the safety threshold in Settings.' },
    RECITATION: { label: 'Blocked: copyrighted content', tone: 'error', note: 'Ask for a paraphrase instead of verbatim text.' },
    PROHIBITED_CONTENT: { label: 'Blocked: prohibited content', tone: 'error', note: '' },
    BLOCKLIST: { label: 'Blocked: term blocklist', tone: 'error', note: '' },
    SPII: { label: 'Blocked: personal information', tone: 'error', note: '' },
    LANGUAGE: { label: 'Blocked: unsupported language', tone: 'error', note: '' },
    IMAGE_SAFETY: { label: 'Blocked: image safety', tone: 'error', note: '' },
    UNEXPECTED_TOOL_CALL: { label: 'Unexpected tool call', tone: 'warn', note: '' },
    MALFORMED_FUNCTION_CALL: { label: 'Malformed function call', tone: 'warn', note: 'Try again; the model emitted a bad tool call.' },
    JAILBREAK: { label: 'Blocked: jailbreak detected', tone: 'error', note: '' },
    OTHER: { label: 'Stopped (other)', tone: 'warn', note: '' },
  };

  function describeFinishReason(reason) {
    if (!reason) return null;
    return FINISH_REASONS[reason] || { label: reason, tone: 'warn', note: '' };
  }

  /**
   * Turn any HTTP status + JSON error body into something a human can act on.
   * Google returns: { error: { code, message, status, details: [{ reason }] } }
   */
  function mapApiError(status, body) {
    const err = (body && body.error) || {};
    const detailReason = (err.details || []).map((d) => d.reason).filter(Boolean)[0] || null;
    const raw = err.message || (typeof body === 'string' ? body : '') || 'Unknown error';
    const code = Number(err.code) || Number(status) || 0;

    const base = { status: code, reason: detailReason || err.status || null, raw, retryable: false };

    if (detailReason === 'API_KEY_INVALID' || code === 400 && /api key/i.test(raw)) {
      return { ...base, title: 'API key rejected', retryable: false,
        hint: 'Check .env → GEMINI_API_KEY (no quotes/spaces), and that the key is enabled for the "Generative Language API".' };
    }
    if (code === 401 || detailReason === 'UNAUTHENTICATED') {
      return { ...base, title: 'Not authenticated', retryable: false, hint: 'Re-create the key in Google AI Studio.' };
    }
    if (code === 403 || detailReason === 'PERMISSION_DENIED') {
      return { ...base, title: 'Permission denied', retryable: false,
        hint: 'The key works but is not allowed to call this model/project. Check key restrictions and model access.' };
    }
    if (code === 404 || detailReason === 'NOT_FOUND') {
      return { ...base, title: 'Model or endpoint not found', retryable: false,
        hint: 'The model ID may not exist, be deprecated, or be unavailable on your project tier. Pick another model in Settings.' };
    }
    if (code === 429 || detailReason === 'RESOURCE_EXHAUSTED') {
      return { ...base, title: 'Rate limit / quota exhausted (free tier)', retryable: true,
        hint: 'Free-tier limits are per project (RPM / TPM / RPD). Wait a minute, lower request size, or switch model. See aistudio.google.com/rate-limit.' };
    }
    if (code === 400 || detailReason === 'INVALID_ARGUMENT') {
      return { ...base, title: 'Invalid request', retryable: false,
        hint: 'A parameter is not accepted by this model (for example topK on 2.5 Pro, thinkingLevel "minimal", or maxOutputTokens above the model limit).' };
    }
    if (code === 400 && detailReason === 'FAILED_PRECONDITION') {
      return { ...base, title: 'Project not ready', retryable: false, hint: 'Enable billing or accept the AI Studio terms for this project.' };
    }
    if (code >= 500 || code === 408 || detailReason === 'UNAVAILABLE' || detailReason === 'DEADLINE_EXCEEDED') {
      return { ...base, title: 'Google service problem', retryable: true, hint: 'Transient. The client retries automatically.' };
    }
    return { ...base, title: `Request failed (${code || 'network'})`, retryable: false, hint: raw };
  }

  /** Exponential backoff with full jitter. `rand` is injectable for tests. */
  function computeBackoffMs(attempt, options, rand) {
    const o = options || {};
    const base = Number(o.baseMs) > 0 ? Number(o.baseMs) : 700;
    const cap = Number(o.capMs) > 0 ? Number(o.capMs) : 15000;
    const n = Math.max(1, Number(attempt) || 1);
    const exponential = Math.min(cap, base * Math.pow(2, n - 1));
    const r = typeof rand === 'function' ? rand() : Math.random();
    return Math.round(exponential * (0.5 + 0.5 * Math.min(1, Math.max(0, r))));
  }

  // ---------------------------------------------------------------------------
  // The actual call
  // ---------------------------------------------------------------------------

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); resolve(); }, ms);
      function cleanup() {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function onAbort() { cleanup(); reject(new DOMException('Aborted', 'AbortError')); }
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Call Gemini, streaming when possible.
   *
   * @param {object} o
   * @param {string} o.model
   * @param {object} o.body            built by buildRequestBody()
   * @param {string} o.apiKey
   * @param {boolean} [o.stream]
   * @param {AbortSignal} [o.signal]
   * @param {Function} [o.onDelta]     (textSoFar, delta) => void
   * @param {Function} [o.onThought]   (thoughtSoFar, delta) => void
   * @param {Function} [o.onRetry]     ({attempt, waitMs, error}) => void
   * @param {number} [o.maxRetries]    retries after the first attempt
   * @param {number} [o.timeoutMs]
   * @param {string} [o.base]          API base URL
   * @param {Function} [o.fetchImpl]   injectable fetch (tests / Node proxy)
   * @param {Function} [o.rand]        injectable Math.random (tests)
   * @param {Function} [o.now]         injectable clock (tests)
   * @returns {Promise<{text, thought, finishReason, usage, blocked, model, latencyMs, attempts}>}
   */
  async function generate(o) {
    const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available');

    const stream = o.stream !== false;
    const maxRetries = Math.max(0, Number(o.maxRetries) || 0);
    const rand = o.rand || Math.random;
    const started = (o.now || Date.now)();
    let attempt = 0;
    let lastError = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      let emittedAny = false;
      const url = buildEndpoint(o.model, { stream, base: o.base });

      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (o.signal) {
        if (o.signal.aborted) { controller.abort(); }
        else o.signal.addEventListener('abort', onOuterAbort, { once: true });
      }
      const timer = o.timeoutMs ? setTimeout(() => controller.abort(new Error('timeout')), o.timeoutMs) : null;

      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: authHeaders(o.apiKey),
          body: JSON.stringify(o.body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (_) { parsed = { error: { message: text.slice(0, 500) } }; }
          const mapped = mapApiError(res.status, parsed);
          if (mapped.retryable && attempt <= maxRetries && !emittedAny) {
            const waitMs = computeBackoffMs(attempt, {}, rand);
            if (o.onRetry) o.onRetry({ attempt, waitMs, error: mapped });
            if (o.signal) o.signal.removeEventListener('abort', onOuterAbort);
            if (timer) clearTimeout(timer);
            await sleep(waitMs, o.signal);
            lastError = mapped;
            continue;
          }
          const failure = new Error(mapped.title);
          failure.apiError = mapped;
          failure.isApiError = true; // must never be retried as a "network" error
          throw failure;
        }

        const result = {
          text: '', thought: '', finishReason: null, usage: null, blocked: null,
          citations: null, model: o.model, attempts: attempt, latencyMs: 0,
        };

        if (!stream) {
          const json = await res.json();
          const r = readChunk(json);
          result.text = r.text;
          result.thought = r.thought;
          result.finishReason = r.finishReason;
          result.usage = r.usage;
          result.blocked = r.blocked;
          result.citations = r.citations;
          if (result.text && o.onDelta) o.onDelta(result.text, result.text);
          if (result.thought && o.onThought) o.onThought(result.thought, result.thought);
        } else {
          const parser = createSSEParser();
          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          if (!reader) throw new Error('Streaming is not supported by this fetch implementation');
          const decoder = new TextDecoder();

          const consume = (events) => {
            for (const ev of events) {
              if (ev.parseError || ev.done || !ev.data) continue;
              const r = readChunk(ev.data);
              if (r.blocked) result.blocked = r.blocked;
              if (r.text) { result.text += r.text; emittedAny = true; if (o.onDelta) o.onDelta(result.text, r.text); }
              if (r.thought) { result.thought += r.thought; if (o.onThought) o.onThought(result.thought, r.thought); }
              if (r.finishReason) result.finishReason = r.finishReason;
              if (r.usage) result.usage = r.usage;
              if (r.citations) result.citations = r.citations;
            }
          };

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            consume(parser.push(decoder.decode(value, { stream: true })));
          }
          consume(parser.push(decoder.decode()));
          consume(parser.flush());
        }

        result.latencyMs = (o.now || Date.now)() - started;
        if (o.signal) o.signal.removeEventListener('abort', onOuterAbort);
        if (timer) clearTimeout(timer);
        return result;
      } catch (err) {
        if (o.signal) o.signal.removeEventListener('abort', onOuterAbort);
        if (timer) clearTimeout(timer);
        if (err && err.name === 'AbortError') throw err;
        if (err && err.isApiError) throw err; // a real API answer, not a network fault
        const networkError = !emittedAny && attempt <= maxRetries;
        if (networkError) {
          const waitMs = computeBackoffMs(attempt, {}, rand);
          if (o.onRetry) o.onRetry({ attempt, waitMs, error: { title: 'Network error', raw: String(err && err.message) } });
          await sleep(waitMs, o.signal);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
  }

  /** GET /v1beta/models — used by the "Refresh model list" button. */
  async function listModels(apiKey, options) {
    const o = options || {};
    const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const base = (o.base || DEFAULT_BASE).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/models?pageSize=200`, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: o.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const mapped = mapApiError(res.status, json);
      const e = new Error(mapped.title);
      e.apiError = mapped;
      e.isApiError = true;
      throw e;
    }
    return (json.models || [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, ''),
        description: m.description || '',
        inputLimit: m.inputTokenLimit || null,
        outputLimit: m.outputTokenLimit || null,
        tier: '',
        stable: !/-preview|-exp|-latest/.test(String(m.name || '')),
        thinking: null,
        note: 'Fetched live from the API',
      }));
  }

  /** POST /v1beta/models/{model}:countTokens — real prompt token count. */
  async function countTokens(model, contents, apiKey, options) {
    const o = options || {};
    const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const base = (o.base || DEFAULT_BASE).replace(/\/+$/, '');
    const res = await fetchImpl(
      `${base}/models/${encodeURIComponent(model)}:countTokens`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify({ contents }), signal: o.signal }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return typeof json.totalTokens === 'number' ? json.totalTokens : null;
  }

  // ---------------------------------------------------------------------------
  // Free-tier quota guard (client side; the server still enforces the real one)
  // ---------------------------------------------------------------------------

  /** RPD resets at midnight Pacific — mirror that so counters line up. */
  function pacificDayKey(date, IntlImpl) {
    const I = IntlImpl || (typeof Intl !== 'undefined' ? Intl : null);
    const d = date || new Date();
    if (!I) return new Date(d.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const parts = new I.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      const get = (t) => (parts.find((p) => p.type === t) || {}).value;
      return `${get('year')}-${get('month')}-${get('day')}`;
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  /**
   * Client-side guard that keeps you from burning the whole free daily quota by
   * accident. It is advisory only — Google enforces the real limits.
   */
  function createRateGuard(options) {
    const o = options || {};
    const now = o.now || (() => Date.now());
    const dayKey = o.dayKey || ((d) => pacificDayKey(d));
    let times = [];
    let daily = { day: dayKey(new Date(now())), count: Number(o.initialDailyCount) || 0 };
    let lastAt = 0;

    function rollDay() {
      const today = dayKey(new Date(now()));
      if (today !== daily.day) daily = { day: today, count: 0 };
    }

    return {
      /** Returns {ok, waitMs, reason} — ok:true means "go ahead". */
      check() {
        if (!o.enabled) return { ok: true, waitMs: 0, reason: null };
        rollDay();
        const t = now();
        times = times.filter((x) => t - x < 60000);

        // Hardest cap first: if the daily budget is gone, waiting a second
        // will not help, and telling the user to "wait" would be wrong.
        const rpd = Number(o.rpd) || 0;
        if (rpd && daily.count >= rpd) {
          return { ok: false, waitMs: 0, reason: 'rpd' };
        }
        const rpm = Number(o.rpm) || 0;
        if (rpm && times.length >= rpm) {
          return { ok: false, waitMs: 60000 - (t - times[0]) + 50, reason: 'rpm' };
        }
        const minInterval = Number(o.minIntervalMs) || 0;
        if (minInterval && lastAt && t - lastAt < minInterval) {
          return { ok: false, waitMs: minInterval - (t - lastAt), reason: 'spacing' };
        }
        return { ok: true, waitMs: 0, reason: null };
      },
      record() {
        rollDay();
        const t = now();
        times.push(t);
        lastAt = t;
        daily.count += 1;
        return this.snapshot();
      },
      snapshot() {
        rollDay();
        const t = now();
        return {
          rpm: Number(o.rpm) || 0,
          usedThisMinute: times.filter((x) => t - x < 60000).length,
          rpd: Number(o.rpd) || 0,
          usedToday: daily.count,
          day: daily.day,
        };
      },
      resetDay() { daily = { day: dayKey(new Date(now())), count: 0 }; },
      get dailyCount() { return daily.count; },
      get dailyDay() { return daily.day; },
    };
  }

  return {
    DEFAULT_BASE,
    SAFETY_CATEGORIES,
    parseEnv,
    isPlaceholderKey,
    estimateTokens,
    contentTokens,
    messagesToContents,
    trimContext,
    toNumberOrNull,
    parseStopSequences,
    buildRequestBody,
    buildEndpoint,
    authHeaders,
    createSSEParser,
    readChunk,
    describeFinishReason,
    mapApiError,
    computeBackoffMs,
    generate,
    listModels,
    countTokens,
    pacificDayKey,
    createRateGuard,
    sleep,
  };
});
