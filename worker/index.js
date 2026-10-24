// Ashdrop Worker: serves the built site and the zero-knowledge link API.
// The server only ever receives ciphertext, IVs, a salt and a hash of a password-derived
// token. The decryption key lives in the URL fragment and never reaches this code.

import { LinkDO, json, sha256b64, bytesToB64url } from './link.js';
export { LinkDO };

const MAX_BODY = 26 * 1024 * 1024;             // 25 MB free-tier file + small header + GCM tags
const EXPIRY_MS = { burn: 24 * 3600e3, '1h': 3600e3, '24h': 24 * 3600e3 }; // unread burn links die after 24h
const ATTEMPTS = [1, 3, 5, 10];
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_RE = /^[a-hjkmnp-z2-9]{10}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let res;
    if (url.pathname === '/.well-known/security.txt') {
    res = new Response(securityTxt(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
  } else if (url.pathname.startsWith('/api/')) {
      try {
        res = await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        res = json({ error: 'server_error' }, 500);
      }
      res = new Response(res.body, res);
      res.headers.set('Cache-Control', 'no-store');
    } else {
      // Static site. /p/:id falls through to index.html (single-page app), which reads the key from the fragment.
      res = await env.ASSETS.fetch(request);
      res = new Response(res.body, res);
      if (url.pathname.startsWith('/p/')) res.headers.set('Cache-Control', 'no-store');
      if (url.pathname === '/build.json') res.headers.set('Cache-Control', 'no-cache');
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
};

// RFC 9116 security.txt: where to report vulnerabilities. Expires is kept six months ahead.
const SECURITY_CONTACT = 'mailto:helloashdrop.cc@gmail.com';
function securityTxt(origin) {
  const expires = new Date(Date.now() + 182 * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en, mn',
    `Canonical: ${origin}/.well-known/security.txt`,
    `Policy: ${origin}/security`,
    '',
  ].join('\n');
}

// Pages are served exactly as built, never rewritten, so anyone can compare them with the
// published build fingerprints (see scripts/verify.mjs). Link previews use the static tags in index.html.

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'p', id?, action?]
  if (parts[1] === 'admin') return handleAdmin(request, env, parts);
  if (parts[1] === 'code' && parts.length === 2 && request.method === 'POST') return lookupCode(request, env);
  if (parts[1] !== 'p') return json({ error: 'not_found' }, 404);

  if (parts.length === 2 && request.method === 'POST') return createLink(request, env);

  const id = parts[2];
  if (!ID_RE.test(id || '')) return json({ error: 'not_found' }, 404);
  const stub = env.LINKS.get(env.LINKS.idFromName(id));
  const call = (path, body) => stub.fetch(`https://link${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  if (parts.length === 3 && request.method === 'GET') return call('/meta');
  if (parts.length === 3 && request.method === 'DELETE') return call('/revoke', { ownerToken: bearer(request) });
  if (parts[3] === 'status' && request.method === 'GET') return call('/status', { ownerToken: bearer(request) });
  if (parts[3] === 'open' && request.method === 'POST') {
    // Slows down anyone hammering links from one address. Each link also has its own lockout.
    if (!(await allowed(env.OPEN_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
    return openLink(request, env, id, call);
  }

  return json({ error: 'not_found' }, 404);
}

// POST /api/p   body: ciphertext bytes   header x-ashdrop-meta: JSON
async function createLink(request, env) {
  if (!(await allowed(env.CREATE_LIMITER, request))) return json({ error: 'rate_limited' }, 429);

  let meta;
  try { meta = JSON.parse(request.headers.get('x-ashdrop-meta') || ''); } catch { return json({ error: 'bad_meta' }, 400); }
  const { expiry, maxAttempts = null, salt = null, iv, iv2 = null, authToken = null, code = null } = meta || {};
  if (!(expiry in EXPIRY_MS)) return json({ error: 'bad_expiry' }, 400);
  if (!isB64(iv, 16)) return json({ error: 'bad_iv' }, 400);
  const pw = authToken !== null;
  if (pw && (!ATTEMPTS.includes(maxAttempts) || !isB64(salt, 22) || !isB64(iv2, 16) || !isB64(authToken, 43))) {
    return json({ error: 'bad_password_layer' }, 400);
  }
  if (code !== null && (!isB64(code?.lookup, 43) || !isB64(code?.wrapped, 64) || !isB64(code?.wrapIv, 16))) {
    return json({ error: 'bad_code' }, 400);
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ error: 'too_large', limit: MAX_BODY }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json({ error: 'empty' }, 400);
  if (body.byteLength > MAX_BODY) return json({ error: 'too_large', limit: MAX_BODY }, 413);

  const id = randomId();
  const ownerToken = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + EXPIRY_MS[expiry];

  await env.BLOBS.put(`p/${id}`, body);
  const stub = env.LINKS.get(env.LINKS.idFromName(id));
  const init = await stub.fetch('https://link/init', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id, expiry, expiresAt, size: body.byteLength,
      maxAttempts: pw ? maxAttempts : null,
      salt: pw ? salt : null, iv, iv2: pw ? iv2 : null,
      verifier: pw ? await sha256b64(authToken) : null,
      ownerHash: await sha256b64(ownerToken),
    }),
  });
  if (!init.ok) {
    await env.BLOBS.delete(`p/${id}`);
    return json({ error: 'create_failed' }, 500);
  }
  if (code) {
    const codeStub = env.LINKS.get(env.LINKS.idFromName(await codeName(code.lookup)));
    const made = await codeStub.fetch('https://link/code-init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: id, wrapped: code.wrapped, wrapIv: code.wrapIv, expiresAt }),
    });
    if (!made.ok) {
      // Another live link already uses this code (about 1 in 17 trillion). Undo, and let the browser pick a new code.
      await stub.fetch('https://link/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await env.BLOBS.delete(`p/${id}`);
      return json({ error: 'code_taken' }, 409);
    }
  }
  return json({ id, ownerToken, expiresAt }, 201);
}

// POST /api/code   body: { lookup }
// Finds the link a code belongs to. Returns its id and the wrapped key; only the code can unwrap it.
// Guessing is slow on purpose: each guess costs the guesser 310,000 PBKDF2 rounds, and the limiter caps tries per address.
async function lookupCode(request, env) {
  if (!(await allowed(env.CODE_LIMITER || env.OPEN_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
  const { lookup } = await request.json().catch(() => ({}));
  if (!isB64(lookup, 43)) return json({ error: 'bad_code' }, 400);
  const codeStub = env.LINKS.get(env.LINKS.idFromName(await codeName(lookup)));
  const got = await codeStub.fetch('https://link/code-get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!got.ok) return json({ error: 'not_found' }, 404);
  const { linkId, wrapped, wrapIv } = await got.json();
  // A code is only useful while its link is alive. If the link was burned or revoked, forget the code too.
  const meta = await env.LINKS.get(env.LINKS.idFromName(linkId)).fetch('https://link/meta');
  if (!meta.ok) {
    const { reason } = await meta.json().catch(() => ({}));
    await codeStub.fetch('https://link/code-drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return json({ error: 'gone', reason: reason || 'gone' }, 410);
  }
  return json({ id: linkId, wrapped, wrapIv });
}

const codeName = async (lookup) => 'code:' + (await sha256b64(lookup));

// POST /api/p/:id/open   body: { authToken? }
async function openLink(request, env, id, call) {
  const { authToken } = await request.json().catch(() => ({}));
  const verdict = await call('/open', { authToken: typeof authToken === 'string' ? authToken : undefined });
  const v = await verdict.json();
  if (v.status !== 'ok') return json(v, verdict.status);

  const obj = await env.BLOBS.get(`p/${id}`);
  if (!obj) return json({ status: 'gone', reason: 'missing' }, 410);
  const bytes = await obj.arrayBuffer();
  if (v.burned) await env.BLOBS.delete(`p/${id}`); // the Durable Object already marked it burned

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-ashdrop-iv': v.iv,
      'x-ashdrop-iv2': v.iv2 || '',
      'x-ashdrop-burned': v.burned ? '1' : '0',
      'x-ashdrop-expires': String(v.expiresAt),
    },
  });
}

// Rate limits are keyed by IP address because anonymous users have nothing else to key on.
// The address is only used for the count and is not stored.
async function allowed(limiter, request) {
  if (!limiter) return true; // not configured (tests, or local dev without the binding)
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try { return (await limiter.limit({ key: ip })).success; } catch { return true; }
}

// DELETE /api/admin/p/:id   Authorization: Bearer <ADMIN_TOKEN>
// For abuse reports: removes a link without needing (or seeing) its key.
async function handleAdmin(request, env, parts) {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !token || !(await sameSecret(token, env.ADMIN_TOKEN))) {
    return json({ error: 'not_found' }, 404); // look like nothing is here
  }
  const id = parts[3];
  if (parts[2] !== 'p' || !ID_RE.test(id || '') || request.method !== 'DELETE') return json({ error: 'not_found' }, 404);
  const stub = env.LINKS.get(env.LINKS.idFromName(id));
  const r = await stub.fetch('https://link/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await env.BLOBS.delete(`p/${id}`);
  console.log(JSON.stringify({ event: 'admin_remove', id }));
  return json(await r.json());
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function isB64(v, len) {
  return typeof v === 'string' && v.length === len && B64URL_RE.test(v);
}

function randomId() {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(r, (x) => ID_ALPHABET[x % ID_ALPHABET.length]).join('');
}
