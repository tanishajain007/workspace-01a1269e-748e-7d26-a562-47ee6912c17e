/**
 * Unit tests for the non-DOM logic (Gemini client, markdown renderer, config).
 * Run:  node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const G = require('../js/gemini.js');
const MD = require('../js/markdown.js');
const CFG = require('../js/config.js');

/** Build a streaming Response whose body is the given SSE text, in chunks. */
function sseResponse(text, chunkSize = 7) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------
test('parseEnv: values, comments, quotes, export, inline comment', () => {
  const env = G.parseEnv([
    '# comment line',
    '',
    'GEMINI_API_KEY=AIzaSyABC123',
    '  SPACED = value  ',
    'export EXPORTED=42',
    'QUOTED="hello world"',
    "SINGLE='raw # not a comment'",
    'INLINE=value # trailing comment',
    'BROKEN_NO_EQUALS',
  ].join('\n'));

  assert.equal(env.GEMINI_API_KEY, 'AIzaSyABC123');
  assert.equal(env.SPACED, 'value');
  assert.equal(env.EXPORTED, '42');
  assert.equal(env.QUOTED, 'hello world');
  assert.equal(env.SINGLE, 'raw # not a comment');
  assert.equal(env.INLINE, 'value');
  assert.equal(env.BROKEN_NO_EQUALS, undefined);
});

test('parseEnv: CRLF line endings', () => {
  assert.deepEqual(G.parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
});

test('isPlaceholderKey flags the shipped .env default', () => {
  assert.equal(G.isPlaceholderKey('YOUR_GEMINI_API_KEY_HERE'), true);
  assert.equal(G.isPlaceholderKey('<paste key>'), true);
  assert.equal(G.isPlaceholderKey(''), true);
  assert.equal(G.isPlaceholderKey('AIzaSyRealKey'), false);
});

// ---------------------------------------------------------------------------
// context building
// ---------------------------------------------------------------------------
test('messagesToContents maps text and images to Gemini parts', () => {
  const contents = G.messagesToContents([
    { role: 'user', text: 'hi', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
    { role: 'model', text: 'hello' },
    { role: 'user', text: '', images: [] },
  ]);
  assert.equal(contents.length, 2, 'empty messages are dropped');
  assert.deepEqual(contents[0].parts, [
    { text: 'hi' },
    { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
  ]);
  assert.equal(contents[1].role, 'model');
});

test('trimContext keeps the newest turns within budget and starts with a user turn', () => {
  const long = 'x'.repeat(4000); // ~1000 tokens each
  const contents = [
    { role: 'user', parts: [{ text: long }] },
    { role: 'model', parts: [{ text: long }] },
    { role: 'user', parts: [{ text: 'latest question' }] },
    { role: 'model', parts: [{ text: 'latest answer' }] },
  ];
  const out = G.trimContext(contents, { tokenBudget: 1000, alwaysKeep: 2 });
  assert.equal(out.dropped, 2);
  assert.equal(out.contents.length, 2);
  assert.equal(out.contents[0].role, 'user');
  assert.equal(out.contents[1].parts[0].text, 'latest answer');
  assert.ok(out.estimatedTokens <= 1000, 'estimate must stay inside the budget');
});

test('trimContext drops a leading model turn', () => {
  const contents = [
    { role: 'model', parts: [{ text: 'orphan model turn' }] },
    { role: 'user', parts: [{ text: 'q' }] },
  ];
  const out = G.trimContext(contents, { tokenBudget: 100000 });
  assert.equal(out.contents[0].role, 'user');
});

// ---------------------------------------------------------------------------
// request building
// ---------------------------------------------------------------------------
test('buildRequestBody includes only valid, set fields', () => {
  const body = G.buildRequestBody({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    systemInstruction: 'Be terse.',
    settings: {
      temperature: 0.4, topP: 0.9, topK: '', maxOutputTokens: 1024,
      stopSequences: '###, END', safetyThreshold: 'BLOCK_ONLY_HIGH', thinkingLevel: 'high',
    },
    supportsThinking: false,
  });

  assert.equal(body.systemInstruction.parts[0].text, 'Be terse.');
  assert.equal(body.generationConfig.temperature, 0.4);
  assert.equal(body.generationConfig.topP, 0.9);
  assert.equal(body.generationConfig.maxOutputTokens, 1024);
  assert.equal('topK' in body.generationConfig, false, 'empty topK must be omitted');
  assert.deepEqual(body.generationConfig.stopSequences, ['###', 'END']);
  assert.equal(body.generationConfig.thinkingConfig, undefined, 'thinkingConfig needs a model that supports it');
  assert.equal(body.safetySettings.length, 4);
  assert.equal(body.safetySettings[0].threshold, 'BLOCK_ONLY_HIGH');
});

test('buildRequestBody adds thinkingConfig only for supporting models', () => {
  const body = G.buildRequestBody({
    contents: [],
    settings: { temperature: 1, thinkingLevel: 'medium' },
    supportsThinking: true,
  });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'medium' });
});

test('buildRequestBody omits safetySettings when threshold is DEFAULT', () => {
  const body = G.buildRequestBody({ contents: [], settings: { safetyThreshold: 'DEFAULT' } });
  assert.equal(body.safetySettings, undefined);
});

test('buildEndpoint uses the header-key convention and alt=sse for streaming', () => {
  assert.equal(
    G.buildEndpoint('gemini-3.6-flash', { stream: true }),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse'
  );
  assert.equal(
    G.buildEndpoint('gemini-2.5-pro', { stream: false, base: '/api/gemini/v1beta/' }),
    '/api/gemini/v1beta/models/gemini-2.5-pro:generateContent'
  );
  assert.equal(G.authHeaders('k')['x-goog-api-key'], 'k');
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------
test('SSE parser handles events split across chunk boundaries', () => {
  const parser = G.createSSEParser();
  let events = [];
  events.push(...parser.push('data: {"cand'));
  assert.equal(events.length, 0, 'incomplete line must be buffered');
  events.push(...parser.push('idates":[{"content":{"parts":[{"text":"He"}]}}]}\n'));
  events.push(...parser.push('\ndata: {"candidates":[{"content":{"parts":[{"text":"llo"}]}}]}\n\n'));
  assert.equal(events.length, 2);
  assert.equal(events[0].data.candidates[0].content.parts[0].text, 'He');
  assert.equal(events[1].data.candidates[0].content.parts[0].text, 'llo');
});

test('SSE parser handles [DONE], comments and CRLF', () => {
  const parser = G.createSSEParser();
  const events = parser.push(': keep-alive\r\ndata: [DONE]\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].done, true);
});

test('SSE parser flushes a final event without a trailing newline', () => {
  const parser = G.createSSEParser();
  assert.equal(parser.push('data: {"ok":1}').length, 0);
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { ok: 1 });
});

test('readChunk separates visible text from thought parts', () => {
  const r = G.readChunk({
    candidates: [{
      content: { parts: [{ text: 'reasoning…', thought: true }, { text: 'Answer.' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
  });
  assert.equal(r.text, 'Answer.');
  assert.equal(r.thought, 'reasoning…');
  assert.equal(r.finishReason, 'STOP');
  assert.equal(r.usage.candidatesTokenCount, 5);
});

test('readChunk surfaces prompt-level blocks', () => {
  const r = G.readChunk({ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'nope' } });
  assert.deepEqual(r.blocked, { reason: 'SAFETY', message: 'nope' });
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------
test('mapApiError turns real Google error bodies into actionable messages', () => {
  const invalid = G.mapApiError(400, {
    error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
      details: [{ reason: 'API_KEY_INVALID' }] },
  });
  assert.equal(invalid.title, 'API key rejected');
  assert.equal(invalid.retryable, false);
  assert.match(invalid.hint, /GEMINI_API_KEY/);

  assert.equal(G.mapApiError(404, { error: { code: 404, message: 'models/gemini-x is not found' } }).title,
    'Model or endpoint not found');

  const quota = G.mapApiError(429, { error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } });
  assert.equal(quota.title, 'Rate limit / quota exhausted (free tier)');
  assert.equal(quota.retryable, true);

  assert.equal(G.mapApiError(503, { error: { code: 503, message: 'Unavailable' } }).retryable, true);
  assert.equal(G.mapApiError(403, { error: { code: 403, message: 'denied' } }).title, 'Permission denied');
});

test('describeFinishReason explains MAX_TOKENS and SAFETY', () => {
  assert.equal(G.describeFinishReason('STOP').tone, 'ok');
  assert.match(G.describeFinishReason('MAX_TOKENS').note, /Max output tokens/);
  assert.equal(G.describeFinishReason('SAFETY').tone, 'error');
  assert.equal(G.describeFinishReason('WHATEVER').tone, 'warn');
});

test('computeBackoffMs grows exponentially and respects the cap', () => {
  const a = G.computeBackoffMs(1, { baseMs: 1000, capMs: 8000 }, () => 1);
  const b = G.computeBackoffMs(2, { baseMs: 1000, capMs: 8000 }, () => 1);
  const c = G.computeBackoffMs(9, { baseMs: 1000, capMs: 8000 }, () => 1);
  assert.equal(a, 1000);
  assert.equal(b, 2000);
  assert.equal(c, 8000, 'must clamp at capMs');
  assert.ok(G.computeBackoffMs(3, { baseMs: 1000 }, () => 0) >= 2000);
});

// ---------------------------------------------------------------------------
// the real request path (with an injected fetch)
// ---------------------------------------------------------------------------
test('generate() streams SSE chunks into ordered text + usage', async () => {
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}',
    '',
    'data: {"candidates":[{"content":{"parts":[{"text":", world"}]}}]}',
    '',
    'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const seen = [];
  const result = await G.generate({
    model: 'gemini-3.6-flash',
    body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    apiKey: 'test-key',
    stream: true,
    fetchImpl: async (url, init) => {
      assert.match(url, /models\/gemini-3\.6-flash:streamGenerateContent\?alt=sse$/);
      assert.equal(init.headers['x-goog-api-key'], 'test-key');
      assert.equal(init.method, 'POST');
      assert.ok(!url.includes('key='), 'the key must never be in the query string');
      return sseResponse(sse);
    },
    onDelta: (full) => seen.push(full),
  });

  assert.equal(result.text, 'Hello, world');
  assert.equal(result.finishReason, 'STOP');
  assert.equal(result.usage.promptTokenCount, 7);
  assert.equal(seen[seen.length - 1], 'Hello, world');
  assert.ok(seen.length >= 2, 'deltas must arrive incrementally');
  assert.equal(result.attempts, 1);
});

test('generate() retries a 429 with backoff, then succeeds', async () => {
  let calls = 0;
  const waits = [];
  const result = await G.generate({
    model: 'gemini-3.6-flash',
    body: { contents: [] },
    apiKey: 'k',
    stream: false,
    maxRetries: 2,
    rand: () => 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
      }
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
    },
    onRetry: ({ waitMs }) => waits.push(waitMs),
  });

  assert.equal(calls, 2);
  assert.equal(result.text, 'ok');
  assert.equal(waits.length, 1);
});

test('generate() surfaces API_KEY_INVALID without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    G.generate({
      model: 'gemini-3.6-flash', body: { contents: [] }, apiKey: 'bad', stream: false, maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
      },
    }),
    (err) => {
      assert.equal(err.apiError.title, 'API key rejected');
      assert.equal(err.apiError.status, 400);
      return true;
    }
  );
  assert.equal(calls, 1, 'non-retryable errors must not burn quota');
});

test('generate() honours stream:false and returns the whole answer at once', async () => {
  const result = await G.generate({
    model: 'gemini-3.8-flash', body: { contents: [] }, apiKey: 'k', stream: false,
    fetchImpl: async (url) => {
      assert.match(url, /:generateContent$/);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'all at once' }] }, finishReason: 'STOP' }] });
    },
  });
  assert.equal(result.text, 'all at once');
});

test('generate() reports a prompt-level safety block', async () => {
  const result = await G.generate({
    model: 'gemini-3.6-flash', body: { contents: [] }, apiKey: 'k', stream: false,
    fetchImpl: async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
  });
  assert.equal(result.blocked.reason, 'SAFETY');
});

test('listModels filters to text-generation models and strips the models/ prefix', async () => {
  const models = await G.listModels('k', {
    fetchImpl: async () => jsonResponse({
      models: [
        { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
        { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'gemini-3.6-flash');
  assert.equal(models[0].inputLimit, 1048576);
});

// ---------------------------------------------------------------------------
// quota guard
// ---------------------------------------------------------------------------
test('rate guard: spacing, RPM and RPD', () => {
  let clock = 1_000_000;
  const guard = G.createRateGuard({
    enabled: true, rpm: 2, rpd: 3, minIntervalMs: 500, now: () => clock,
  });

  assert.equal(guard.check().ok, true);
  guard.record();

  clock += 100;
  assert.equal(guard.check().reason, 'spacing');

  clock += 500;
  assert.equal(guard.check().ok, true);
  guard.record();

  clock += 600;
  assert.equal(guard.check().reason, 'rpm', 'third request inside the same minute is blocked by RPM');

  clock += 60_000;
  assert.equal(guard.check().ok, true);
  guard.record();
  assert.equal(guard.snapshot().usedToday, 3);
  assert.equal(guard.check().reason, 'rpd');

  guard.resetDay();
  clock += 1000; // the min-interval rule still applies after a day reset
  assert.equal(guard.check().ok, true);
});

test('rate guard can be disabled', () => {
  const guard = G.createRateGuard({ enabled: false, rpm: 1 });
  guard.record();
  assert.equal(guard.check().ok, true);
});

test('pacificDayKey returns a YYYY-MM-DD string (RPD resets at midnight PT)', () => {
  const key = G.pacificDayKey(new Date('2026-10-10T06:00:00Z'));
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(key, '2026-10-09', '06:00 UTC is still the previous day in Pacific');
});

// ---------------------------------------------------------------------------
// markdown renderer (security + structure)
// ---------------------------------------------------------------------------
test('markdown escapes HTML instead of executing it', () => {
  const html = MD.render('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<img'));
});

test('markdown rejects javascript: links', () => {
  const html = MD.render('[click](javascript:alert(1))');
  assert.ok(!html.includes('href="javascript'), html);
  assert.ok(html.includes('javascript:alert(1)'), 'unsafe href is rendered as text');
});

test('markdown links open safely', () => {
  const html = MD.render('[docs](https://ai.google.dev/gemini-api/docs)');
  assert.match(html, /href="https:\/\/ai\.google\.dev\/gemini-api\/docs"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test('markdown renders fenced code with a language tag and copy hook', () => {
  const html = MD.render('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /class="code-block"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /class="code-lang">js/);
  assert.match(html, /data-copy="code"/);
  assert.ok(html.includes('1 &lt; 2'), 'code content stays escaped');
});

test('markdown renders headings, lists, tasks, tables and quotes', () => {
  const html = MD.render([
    '## Title',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '- [x] done',
    '- [ ] todo',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> quoted',
  ].join('\n'));

  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
});

test('markdown inline formatting', () => {
  const html = MD.render('**bold** and *em* and `code` and ~~gone~~');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /md-inline-code">code/);
  assert.match(html, /<del>gone<\/del>/);
});

test('markdown inline code is not reformatted', () => {
  const html = MD.render('Use `**not bold**` here');
  assert.ok(!html.includes('<strong>'));
});

test('toPlainText strips markdown for titles and copying', () => {
  const plain = MD.toPlainText('## Heading **bold** and [a link](https://x.dev)');
  assert.equal(plain, 'Heading bold and a link');
  assert.ok(!MD.toPlainText('**bold** _x_ ~y~').includes('*'));
});

// ---------------------------------------------------------------------------
// config sanity
// ---------------------------------------------------------------------------
test('config: default model exists in the catalogue and is free tier', () => {
  const m = CFG.MODELS.find((x) => x.id === CFG.DEFAULT_SETTINGS.model);
  assert.ok(m, 'default model must exist in MODELS');
  assert.match(m.tier, /free/i);
});

test('config: the two requested models are present with documented limits', () => {
  const ids = CFG.MODELS.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.6-flash'));
  assert.ok(ids.includes('gemini-3.7-flash'));
  const m36 = CFG.MODELS.find((m) => m.id === 'gemini-3.6-flash');
  assert.equal(m36.inputLimit, 1048576);
  assert.equal(m36.outputLimit, 65536);
  const m37 = CFG.MODELS.find((m) => m.id === 'gemini-3.7-flash');
  assert.match(m37.note, /Deprecated:.*gemini-3\.8-flash/);
});

test('config: safety categories match the API contract', () => {
  assert.deepEqual(G.SAFETY_CATEGORIES, CFG.SAFETY_CATEGORIES);
  assert.equal(CFG.SAFETY_CATEGORIES.length, 4);
  assert.ok(CFG.SAFETY_THRESHOLDS.some((t) => t.value === 'BLOCK_MEDIUM_AND_ABOVE'));
});

// ---------------------------------------------------------------------------
// server.mjs proxy (server-side key handling)
// ---------------------------------------------------------------------------
test('proxy plan: allows the three generation methods and the model list', async () => {
  const { planProxyRequest } = await import('../server.mjs');
  for (const url of [
    '/api/gemini/v1beta/models/gemini-3.6-flash:generateContent',
    '/api/gemini/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    '/api/gemini/v1beta/models/gemini-2.5-pro:countTokens',
    '/api/gemini/v1beta/models?pageSize=200',
  ]) {
    const plan = planProxyRequest(url, { key: 'k', method: 'POST' });
    assert.equal(plan.ok, true, url);
    assert.ok(plan.upstream.startsWith('https://generativelanguage.googleapis.com/v1beta/'), plan.upstream);
    assert.ok(!/[?&]key=/.test(plan.upstream), 'the key must not be embedded in the URL query string');
    assert.equal(plan.headers['x-goog-api-key'], 'k');
  }
});

test('proxy plan: blocks unrelated and traversal paths', async () => {
  const { planProxyRequest } = await import('../server.mjs');
  for (const url of [
    '/api/gemini/v1beta/files',
    '/api/gemini/v1beta/models/x:delete',
    '/api/gemini/v1beta/cachedContents',
    '/api/gemini/../secret',
    '/api/gemini/v1beta/models/gemini-3.6-flash:generateContent?foo=bar;rm',
  ]) {
    const plan = planProxyRequest(url, { key: 'k', method: 'POST' });
    assert.equal(plan.ok, false, `should block ${url}`);
    assert.equal(plan.status, 400);
  }
});

test('proxy plan: refuses to forward without a real key', async () => {
  const { planProxyRequest } = await import('../server.mjs');
  const plan = planProxyRequest('/api/gemini/v1beta/models/gemini-3.6-flash:generateContent', { key: '', method: 'POST' });
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 401);
  assert.equal(plan.body.error.status, 'UNAUTHENTICATED');
  assert.match(plan.body.error.message, /GEMINI_API_KEY/);
});

// ---------------------------------------------------------------------------
// module loading (the UMD wrappers must survive both browser and Node)
// ---------------------------------------------------------------------------
test('UMD wrappers export their API under Node require()', () => {
  assert.equal(typeof G.generate, 'function', 'gemini.js must export under require()');
  assert.equal(typeof MD.render, 'function', 'markdown.js must export under require()');
  assert.ok(CFG.MODELS.length > 0, 'config.js must export under require()');
});

test('package.json must not declare "type": "module"', async () => {
  // The UMD wrappers assign to module.exports. Under Node's ESM/CJS interop
  // (triggered by "type": "module") that assignment silently no-ops and
  // require() returns {} — every test would then fail with a confusing
  // "is not a function". Keep the browser scripts as classic scripts.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.notEqual(pkg.type, 'module');
});

test('browser scripts are classic scripts loaded before app.js', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const order = ['js/config.js', 'js/markdown.js', 'js/gemini.js', 'js/app.js']
    .map((f) => html.indexOf(`src="${f}"`));
  assert.ok(order.every((i) => i !== -1), 'all four scripts must be referenced');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'scripts must load in dependency order');
  assert.ok(!/<script[^>]+type="module"/.test(html), 'no module scripts');
  assert.ok(!/<script[^>]+src="http/.test(html), 'no external/CDN scripts');
  assert.ok(!/<link[^>]+href="http/.test(html), 'no external/CDN stylesheets');
});
