/**
 * DOM integration tests: boots index.html + the real scripts inside jsdom and
 * drives the UI (send a message, stream a reply, hit an API error, change
 * settings). Skips cleanly if jsdom is not installed:
 *     npm i -D jsdom
 * Run:  node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.warn('jsdom not installed — skipping DOM tests (npm i -D jsdom)');
}

const dir = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, dir), 'utf8');

const isEnvUrl = (u) => u === '.env' || String(u).endsWith('/.env');
const SCRIPTS = ['js/config.js', 'js/markdown.js', 'js/gemini.js', 'js/app.js'];

const ENV_BODY = 'GEMINI_API_KEY=AIzaSyFakeKeyForTests\nGEMINI_MODEL=gemini-3.6-flash\n';

function sseBody(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (let i = 0; i < text.length; i += 9) controller.enqueue(enc.encode(text.slice(i, i + 9)));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const okStream = () => sseBody([
  { candidates: [{ content: { parts: [{ text: 'Gemini says **hello**' }] } }] },
  { candidates: [{ content: { parts: [{ text: '\n\n```js\nconst a = 1;\n```' }] } }] },
  { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 } },
]);

async function boot({ fetchImpl } = {}) {
  const calls = [];
  const dom = new JSDOM(read('index.html'), {
    url: 'http://localhost:8000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom gaps the app relies on
  window.AbortController = AbortController;
  window.DOMException = DOMException;
  if (!window.TextDecoder) window.TextDecoder = TextDecoder;
  if (!window.TextEncoder) window.TextEncoder = TextEncoder;
  if (!window.Response) window.Response = Response;
  if (!window.ReadableStream) window.ReadableStream = ReadableStream;
  if (!window.Blob) window.Blob = Blob;
  window.confirm = () => true;
  window.scrollTo = () => {};
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });

  window.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(String(url), init, calls);
    if (isEnvUrl(url)) {
      return new Response(ENV_BODY, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (String(url) === '/api/config') {
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }
    return okStream();
  };

  for (const s of SCRIPTS) window.eval(read(s));

  await waitFor(() => window.GeminiChat && dom.window.document.getElementById('key-badge').textContent !== 'no key');
  return { dom, window, doc: window.document, calls };
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    let value;
    try { value = fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const $ = (id, doc) => doc.getElementById(id);

test('boot: renders the empty state, model list and the key source badge', { skip: !JSDOM }, async () => {
  const { doc, window } = await boot();

  assert.ok(doc.querySelector('.empty h2'), 'empty state must render');
  assert.ok(doc.querySelectorAll('.idea').length >= 3, 'suggestion chips must render');

  const options = Array.from($('model-select', doc).options).map((o) => o.value);
  assert.ok(options.includes('gemini-3.6-flash'), 'default model must be selectable');
  assert.ok(options.includes('gemini-3.7-flash'), 'gemini-3.7-flash must be selectable');
  assert.equal($('model-badge', doc).textContent, 'gemini-3.6-flash');
  assert.equal($('tier-badge', doc).textContent, 'free');
  assert.equal($('key-badge', doc).textContent, 'key: .env', 'key must be picked up from .env');
  assert.match($('key-source', doc).textContent, /\.env/);

  assert.equal($('set-api-key', doc).value, '', 'a key from .env must not be copied into a DOM input');
  assert.match($('set-api-key', doc).placeholder, /\.env/);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  window.close();
});

test('send: streams a reply, renders markdown and code blocks, records usage', { skip: !JSDOM }, async () => {
  const { doc, window, calls } = await boot();

  $('composer-input', doc).value = 'Say hello in **bold**';
  $('send-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => doc.querySelector('.msg-model .msg-body strong'));

  const model = doc.querySelector('.msg-model');
  assert.match(model.querySelector('.msg-body').innerHTML, /<strong>hello<\/strong>/);
  assert.ok(model.querySelector('.code-block pre code.language-js'), 'fenced code renders with a language class');
  assert.ok(model.querySelector('.copy-code'), 'code blocks get a copy button');
  assert.match(model.querySelector('.usage').textContent, /12 in · 8 out/);
  assert.match(model.querySelector('.usage').textContent, /gemini-3\.6-flash/);
  assert.ok(doc.querySelector('.msg-user .msg-body').textContent.includes('Say hello'));

  const apiCall = calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  assert.ok(apiCall, 'must call the Gemini API directly when a key is present');
  assert.match(apiCall.url, /models\/gemini-3\.6-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(apiCall.init.headers['x-goog-api-key'], 'AIzaSyFakeKeyForTests');
  assert.ok(!/[?&]key=/.test(apiCall.url), 'key must not leak into the query string');
  const sent = JSON.parse(apiCall.init.body);
  assert.equal(sent.systemInstruction.parts[0].text.includes('helpful'), true, 'system instruction is sent');
  assert.equal(sent.contents.at(-1).parts[0].text, 'Say hello in **bold**');
  assert.equal(sent.safetySettings.length, 4);
  assert.equal(sent.generationConfig.maxOutputTokens, 4096);

  await waitFor(() => JSON.parse(window.localStorage.getItem('geminiChat.chats.v1'))[0].messages.length === 2);
  window.close();
});

test('send: an invalid key surfaces one actionable error and does not retry', { skip: !JSDOM }, async () => {
  const { doc, window, calls } = await boot({
    fetchImpl: (url, init, all) => {
      if (isEnvUrl(url)) return new Response(ENV_BODY, { status: 200 });
      if (url === '/api/config') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  });

  $('composer-input', doc).value = 'hi';
  $('send-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => doc.querySelector('.msg-error'));
  const err = doc.querySelector('.msg-error').textContent;
  assert.match(err, /API key rejected/);
  assert.match(err, /API key not valid/);

  await new Promise((r) => setTimeout(r, 250));
  const apiCalls = calls.filter((c) => c.url.includes('generativelanguage'));
  assert.equal(apiCalls.length, 1, 'an invalid key must not be retried');
  assert.equal($('send-btn', doc).hidden, false, 'the composer must be usable again after an error');
  assert.equal($('stop-btn', doc).hidden, true);
  window.close();
});

test('send: MAX_TOKENS explains itself and offers a continue action', { skip: !JSDOM }, async () => {
  const { doc, window } = await boot({
    fetchImpl: (url) => {
      if (isEnvUrl(url)) return new Response(ENV_BODY, { status: 200 });
      if (url === '/api/config') return new Response('{}', { status: 404 });
      return sseBody([
        { candidates: [{ content: { parts: [{ text: 'partial answer' }] } }] },
        { candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4096 } },
      ]);
    },
  });

  $('composer-input', doc).value = 'write a book';
  $('send-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelector('.finish'));

  assert.match(doc.querySelector('.finish').textContent, /Hit max output tokens/);
  assert.match(doc.querySelector('.finish').textContent, /Max output tokens/);
  const titles = Array.from(doc.querySelectorAll('.msg-action')).map((b) => b.title);
  assert.ok(titles.includes('Continue'), 'a MAX_TOKENS answer must offer Continue');
  window.close();
});

test('stop: aborting mid-stream keeps the partial text', { skip: !JSDOM }, async () => {
  const { doc, window } = await boot({
    fetchImpl: (url, init) => {
      if (isEnvUrl(url)) return new Response(ENV_BODY, { status: 200 });
      if (url === '/api/config') return new Response('{}', { status: 404 });
      // A stream that stalls after the first chunk and honours AbortSignal,
      // like a real network response does.
      const enc = new TextEncoder();
      const first = 'data: {"candidates":[{"content":{"parts":[{"text":"start of a long answer"}]}}]}\n\n';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(first));
          init.signal.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });

  $('composer-input', doc).value = 'go';
  $('send-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelector('.msg-model .msg-body').textContent.includes('start of a long answer'));
  $('stop-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => $('send-btn', doc).hidden === false);
  const text = doc.querySelector('.msg-model .msg-body').textContent;
  assert.match(text, /start of a long answer/, 'partial output is kept');
  assert.match(text, /\[stopped\]/, 'the answer is marked as stopped');
  assert.equal(window.GeminiChat.state.stream, null, 'stream state is cleared');
  window.close();
});

test('ui: new chat, rename, theme toggle and settings persistence', { skip: !JSDOM }, async () => {
  const { doc, window } = await boot();

  $('new-chat', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelectorAll('.chat-item').length >= 1, 'the new chat appears in the sidebar');
  assert.equal($('chat-title', doc).textContent, 'New chat');

  $('theme-toggle', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
  // persistence is debounced
  await waitFor(() => JSON.parse(window.localStorage.getItem('geminiChat.settings.v1')).theme === 'light');

  const slider = $('set-temperature', doc);
  slider.value = '0.2';
  slider.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => JSON.parse(window.localStorage.getItem('geminiChat.settings.v1')).temperature === 0.2);

  const model = $('set-model', doc);
  model.value = 'gemini-3.8-flash';
  model.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => JSON.parse(window.localStorage.getItem('geminiChat.settings.v1')).model === 'gemini-3.8-flash');
  assert.equal($('model-badge', doc).textContent, 'gemini-3.8-flash');
  assert.ok(!$('set-thinking', doc).disabled, '3.8 Flash supports the thinking control');

  const legacy = $('set-model', doc);
  legacy.value = 'gemini-3.6-flash';
  legacy.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => $('model-badge', doc).textContent === 'gemini-3.6-flash');
  assert.ok($('set-thinking', doc).disabled, '3.6 Flash must not expose thinkingLevel');
  window.close();
});

test('quota guard: the daily counter is written and shown in the sidebar', { skip: !JSDOM }, async () => {
  const { doc, window } = await boot();
  $('composer-input', doc).value = 'count me';
  $('send-btn', doc).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelector('.msg-model .usage'));
  await waitFor(() => $('quota-rpd', doc).textContent.startsWith('1 /'));
  assert.match($('quota-rpm', doc).textContent, /^1 \/ 8$/);
  assert.ok(JSON.parse(window.localStorage.getItem('geminiChat.daily.v1')).count === 1);
  window.close();
});
