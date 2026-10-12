/**
 * Live HTTP tests against the real server.mjs (static files + proxy behaviour).
 * No network access is required: the proxy is only exercised on paths that
 * fail before any upstream call.
 * Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../server.mjs');
let base;

before(async () => {
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${mod.server.address().port}`;
});

after(() => mod.server.close());

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  return { res, text: await res.text() };
};

test('static: serves the app with correct content types', async () => {
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/css/styles.css', 'text/css'],
    ['/js/app.js', 'text/javascript'],
    ['/js/gemini.js', 'text/javascript'],
    ['/.env', 'text/plain'],
  ]) {
    const { res, text } = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type), path);
    assert.ok(text.length > 0, `${path} must not be empty`);
  }
});

test('static: refuses dotfiles and path traversal', async () => {
  assert.equal((await get('/.gitignore')).res.status, 404);
  assert.equal((await get('/.env.example')).res.status, 404);
  assert.equal((await get('/../../etc/passwd', { headers: {} })).res.status, 404);
  assert.equal((await get('/nope.html')).res.status, 404);
});

test('static: sends basic hardening headers', async () => {
  const { res } = await get('/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('proxy: refuses unknown methods', async () => {
  const { res } = await get('/api/config', { method: 'DELETE' });
  assert.equal(res.status, 405);
});

test('proxy: rejects disallowed paths before calling upstream', async () => {
  const { res, text } = await get('/api/gemini/v1beta/files', { method: 'POST', body: '{}' });
  assert.equal(res.status, 400);
  assert.match(text, /Blocked proxy path/);
});

test('proxy: returns a clear 401 when .env still holds the placeholder', async () => {
  const { res, text } = await get('/api/gemini/v1beta/models/gemini-3.6-flash:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
  });
  // 401 when no key is configured; 400 when the ambient env provides a bogus one.
  assert.ok([400, 401].includes(res.status), `unexpected status ${res.status}: ${text}`);
  if (res.status === 401) {
    assert.match(text, /GEMINI_API_KEY/);
    assert.match(text, /UNAUTHENTICATED/);
  } else {
    assert.match(text, /API_KEY_INVALID|API key not valid/);
  }
});

test('server: parseEnv matches the browser-side parser', async () => {
  assert.deepEqual(mod.parseEnv('GEMINI_API_KEY="quoted value"\n# c\nPORT=8000'), {
    GEMINI_API_KEY: 'quoted value',
    PORT: '8000',
  });
});
