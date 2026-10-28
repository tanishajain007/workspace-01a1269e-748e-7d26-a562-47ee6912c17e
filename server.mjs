/**
 * server.mjs — optional, zero-dependency dev server.
 *
 *   node server.mjs            # http://localhost:8000
 *   PORT=3000 node server.mjs
 *
 * It does two jobs:
 *   1. Serves the static app (browsers cannot fetch('.env') over file://).
 *   2. Optional secure mode: forwards /api/gemini/v1beta/* to Google with the
 *      API key read from .env on the SERVER, so the key never reaches the
 *      browser. The app uses this automatically when it can reach /api/config.
 *
 * Anything you deploy publicly should sit behind HTTPS and a real proxy with
 * auth — this file is for local development.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname);
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = 'https://generativelanguage.googleapis.com';
const PROXY_PREFIX = '/api/gemini';
const ENV_FILE = join(ROOT, '.env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Minimal dotenv reader (same syntax the browser client understands). */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.replace(/^export\s+/, '');
    const eq = cleaned.indexOf('=');
    if (eq === -1) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

async function readKey() {
  try {
    const env = parseEnv(await readFile(ENV_FILE, 'utf8'));
    const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
    if (!key || /^(your|paste|put|xxx|<)/i.test(key)) return '';
    return key;
  } catch {
    return '';
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Decide whether a proxied path is allowed, then build the upstream call.
 * Kept separate from the HTTP layer so it can be unit tested.
 *
 * @returns {{ok:true, upstream:string, method:string, headers:object}|{ok:false, status:number, body:object}}
 */
function planProxyRequest(reqUrl, options) {
  const o = options || {};
  const upstreamPath = reqUrl.slice(PROXY_PREFIX.length);

  // Only the two Gemini methods the app uses, plus the model list.
  const allowed = /^\/v1beta\/models\/[A-Za-z0-9._-]+:(generateContent|streamGenerateContent|countTokens)(\?[A-Za-z0-9&=_-]*)?$/;
  const allowedList = /^\/v1beta\/models(\?[A-Za-z0-9&=_-]*)?$/;
  if (!allowed.test(upstreamPath) && !allowedList.test(upstreamPath)) {
    return { ok: false, status: 400, body: { error: { code: 400, message: `Blocked proxy path: ${upstreamPath}` } } };
  }
  if (!o.key) {
    return {
      ok: false,
      status: 401,
      body: {
        error: {
          code: 401,
          message: 'No GEMINI_API_KEY found in .env (or the value is still a placeholder).',
          status: 'UNAUTHENTICATED',
        },
      },
    };
  }
  const method = o.method === 'POST' || o.method === 'GET' ? o.method : 'GET';
  return {
    ok: true,
    upstream: (o.upstream || UPSTREAM) + upstreamPath,
    method,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },
  };
}

/** Forward a Gemini API request, streaming the response straight back. */
async function handleProxy(req, res) {
  const key = await readKey();
  const plan = planProxyRequest(req.url, { key, method: req.method });
  if (!plan.ok) return sendJson(res, plan.status, plan.body);

  let body;
  if (plan.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
    if (body.length > 25 * 1024 * 1024) {
      return sendJson(res, 413, { error: { code: 413, message: 'Request body too large (25 MB cap).' } });
    }
  }

  try {
    const upstream = await fetch(plan.upstream, {
      method: plan.method,
      headers: plan.headers,
      body,
      redirect: 'manual',
    });

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // keep SSE streaming through proxies
    });

    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: { code: 502, message: `Upstream request failed: ${err.message}` } });
    } else res.end();
  }
}

async function handleStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');

  // Never expose credentials/config other than the .env the client needs.
  const base = rel.split('/').pop();
  if (base.startsWith('.') && base !== '.env') return sendJson(res, 404, { error: 'not found' });

  const filePath = join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) return sendJson(res, 403, { error: 'forbidden' });

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) return sendJson(res, 404, { error: 'not found' });
    // extname('.env') is '' — dotfiles have no extension — so look those up by
    // their full base name.
    const ext = extname(filePath).toLowerCase();
    const mime = MIME[ext] || (base.startsWith('.') ? MIME[base.toLowerCase()] : null) || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: `not found: ${rel}` });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/config') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      const key = await readKey();
      return sendJson(res, 200, { ok: true, mode: 'proxy', hasKey: Boolean(key), upstream: UPSTREAM });
    }
    if (req.url.startsWith(PROXY_PREFIX + '/')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return await handleProxy(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return await handleStatic(req, res);
  } catch (err) {
    return sendJson(res, 500, { error: { code: 500, message: String(err && err.message) } });
  }
});

// Only bind a port when run directly, so tests can import the helpers.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  server.listen(PORT, HOST, async () => {
    const key = await readKey();
    console.log(`\n  Gemini Chat  →  http://localhost:${PORT}`);
    console.log(`  static root:    ${ROOT}`);
    console.log(`  proxy:          ${PROXY_PREFIX}/v1beta/* → ${UPSTREAM}/v1beta/*`);
    console.log(`  api key:        ${key ? 'loaded from .env (server-side, never sent to the browser)' : 'NOT FOUND — add GEMINI_API_KEY to .env'}\n`);
  });
}

export { server, planProxyRequest, parseEnv, readKey, PROXY_PREFIX, UPSTREAM, PORT, HOST };
