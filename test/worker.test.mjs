// Run with: npm test   (plain Node 20+, no Cloudflare account needed)
// The Worker runs against in-memory stand-ins for R2 and Durable Objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { makeEnv } from './mock-env.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const rand = (n) => (n <= 65536 ? crypto.getRandomValues(new Uint8Array(n)) : new Uint8Array(n).fill(7));
const call = (env, path, init) => worker.fetch(new Request(`https://ashdrop.test${path}`, init), env, {});

async function create(env, { expiry = 'burn', password = null, maxAttempts = 3, size = 64 } = {}) {
  const meta = { expiry, iv: b64(rand(12)) };
  if (password) Object.assign(meta, { maxAttempts, salt: b64(rand(16)), iv2: b64(rand(12)), authToken: password });
  const res = await call(env, '/api/p', { method: 'POST', headers: { 'x-ashdrop-meta': JSON.stringify(meta) }, body: rand(size) });
  return { res, body: await res.json(), meta };
}

test('burn link: opens once, then is gone, and its ciphertext is deleted', async () => {
  const env = makeEnv();
  const { res, body } = await create(env);
  assert.equal(res.status, 201);
  assert.match(body.id, /^[a-z2-9]{10}$/);
  assert.equal(env._blobs.size, 1);

  const meta = await (await call(env, `/api/p/${body.id}`)).json();
  assert.equal(meta.needsPassword, false);

  const open = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' });
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('x-ashdrop-burned'), '1');
  assert.equal((await open.arrayBuffer()).byteLength, 64);
  assert.equal(env._blobs.size, 0, 'ciphertext deleted on burn');

  const again = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' });
  assert.equal(again.status, 410);
  assert.equal((await again.json()).reason, 'burned');
});

test('two simultaneous opens of a burn link: exactly one succeeds', async () => {
  const env = makeEnv();
  const { body } = await create(env);
  const [a, b] = await Promise.all([
    call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' }),
    call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
});

test('password lockout: wrong tries count down, the last one destroys the link', async () => {
  const env = makeEnv();
  const token = b64(rand(32));
  const { body } = await create(env, { password: token, maxAttempts: 3, expiry: '1h' });
  const wrong = () => call(env, `/api/p/${body.id}/open`, { method: 'POST', body: JSON.stringify({ authToken: b64(rand(32)) }) });

  let r = await wrong(); assert.equal(r.status, 401); assert.equal((await r.json()).attemptsLeft, 2);
  r = await wrong(); assert.equal((await r.json()).attemptsLeft, 1);
  r = await wrong(); assert.equal(r.status, 410); assert.equal((await r.json()).status, 'locked');
  assert.equal(env._blobs.size, 0, 'ciphertext deleted on lockout');

  r = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: JSON.stringify({ authToken: token }) });
  assert.equal(r.status, 410, 'even the right password is too late');
});

test('right password opens a timed link more than once', async () => {
  const env = makeEnv();
  const token = b64(rand(32));
  const { body } = await create(env, { password: token, expiry: '24h' });
  const meta = await (await call(env, `/api/p/${body.id}`)).json();
  assert.equal(meta.needsPassword, true);
  assert.equal(meta.salt.length, 22);
  for (let i = 0; i < 2; i++) {
    const r = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: JSON.stringify({ authToken: token }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ashdrop-burned'), '0');
    assert.ok(r.headers.get('x-ashdrop-iv2'));
  }
  const st = await (await call(env, `/api/p/${body.id}/status`, { headers: { authorization: `Bearer ${body.ownerToken}` } })).json();
  assert.equal(st.state, 'opened');
  assert.equal(st.opens, 2);
});

test('only the owner can see status or revoke', async () => {
  const env = makeEnv();
  const { body } = await create(env, { expiry: '1h' });
  const st = await call(env, `/api/p/${body.id}/status`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(st.status, 403);
  const bad = await call(env, `/api/p/${body.id}`, { method: 'DELETE', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 403);
  const ok = await call(env, `/api/p/${body.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${body.ownerToken}` } });
  assert.equal((await ok.json()).state, 'revoked');
  assert.equal(env._blobs.size, 0);
  const meta = await call(env, `/api/p/${body.id}`);
  assert.equal(meta.status, 410);
  assert.equal((await meta.json()).reason, 'revoked');
});

test('expired links are refused and purged', async () => {
  const env = makeEnv();
  const { body } = await create(env, { expiry: '1h' });
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600e3;
  try {
    const r = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 410);
    assert.equal((await r.json()).reason, 'expired');
    assert.equal(env._blobs.size, 0);
  } finally { Date.now = realNow; }
});

test('input validation and size limit', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/p', { method: 'POST', headers: { 'x-ashdrop-meta': '{"expiry":"forever","iv":"x"}' }, body: rand(8) });
  assert.equal(r.status, 400);
  r = await call(env, '/api/p', { method: 'POST', headers: { 'x-ashdrop-meta': JSON.stringify({ expiry: 'burn', iv: b64(rand(12)), authToken: 'short' }) }, body: rand(8) });
  assert.equal(r.status, 400);
  const big = await create(env, { size: 26 * 1024 * 1024 + 1 });
  assert.equal(big.res.status, 413);
  r = await call(env, '/api/p/NOT-AN-ID');
  assert.equal(r.status, 404);
});

test('every response carries the security headers', async () => {
  const env = makeEnv();
  const page = await call(env, '/p/abcdefghjk');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const api = await call(env, '/api/p/abcdefghjk');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('admin removal: needs the admin token, deletes without a key', async () => {
  const env = makeEnv();
  env.ADMIN_TOKEN = 'x'.repeat(40);
  const { body } = await create(env, { expiry: '24h' });
  const no = await call(env, `/api/admin/p/${body.id}`, { method: 'DELETE', headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-1' } });
  assert.equal(no.status, 404, 'wrong token looks like nothing is there');
  const ok = await call(env, `/api/admin/p/${body.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } });
  assert.equal((await ok.json()).state, 'removed');
  assert.equal(env._blobs.size, 0);
  const meta = await call(env, `/api/p/${body.id}`);
  assert.equal((await meta.json()).reason, 'removed');
  const st = await (await call(env, `/api/p/${body.id}/status`, { headers: { authorization: `Bearer ${body.ownerToken}` } })).json();
  assert.equal(st.state, 'removed', 'the sender sees it was removed');
});

test('admin endpoint is off when no token is configured', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/admin/p/abcdefghjk', { method: 'DELETE', headers: { authorization: 'Bearer ' } });
  assert.equal(r.status, 404);
});

test('rate limits answer 429 when the limiter says no', async () => {
  const env = makeEnv();
  let n = 0;
  env.CREATE_LIMITER = { limit: async () => ({ success: ++n <= 2 }) };
  assert.equal((await create(env)).res.status, 201);
  assert.equal((await create(env)).res.status, 201);
  assert.equal((await create(env)).res.status, 429);
  env.OPEN_LIMITER = { limit: async () => ({ success: false }) };
  const r = await call(env, '/api/p/abcdefghjk/open', { method: 'POST', body: '{}' });
  assert.equal(r.status, 429);
});

test('security.txt is served with a contact and a future expiry', async () => {
  const env = makeEnv();
  const r = await call(env, '/.well-known/security.txt');
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /^Contact: mailto:/m);
  const exp = Date.parse(t.match(/^Expires: (.+)$/m)[1]);
  assert.ok(exp > Date.now() + 90 * 864e5 && exp < Date.now() + 366 * 864e5);
  assert.match(t, /^Policy: https:\/\/ashdrop\.test\/security$/m);
});

// ---------- typeable codes ----------
async function createWithCode(env, lookup, opts = {}) {
  const meta = { expiry: opts.expiry || 'burn', iv: b64(rand(12)), code: { lookup, wrapped: b64(rand(48)), wrapIv: b64(rand(12)) } };
  const res = await call(env, '/api/p', { method: 'POST', headers: { 'x-ashdrop-meta': JSON.stringify(meta) }, body: rand(32) });
  return { res, body: await res.json(), meta };
}
const lookupCode = (env, lookup) => call(env, '/api/code', { method: 'POST', body: JSON.stringify({ lookup }) });

test('code: finds its link and returns only the wrapped key', async () => {
  const env = makeEnv();
  const lookup = b64(rand(32));
  const { res, body, meta } = await createWithCode(env, lookup);
  assert.equal(res.status, 201);
  const r = await lookupCode(env, lookup);
  assert.equal(r.status, 200);
  const got = await r.json();
  assert.deepEqual(got, { id: body.id, wrapped: meta.code.wrapped, wrapIv: meta.code.wrapIv });
  assert.equal(JSON.stringify(got).includes(lookup), false, 'lookup value is not echoed');
  // Looking it up does not use up a burn link.
  const open = await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' });
  assert.equal(open.status, 200);
});

test('code: unknown code is 404; dead link makes the code disappear', async () => {
  const env = makeEnv();
  assert.equal((await lookupCode(env, b64(rand(32)))).status, 404);
  const lookup = b64(rand(32));
  const { body } = await createWithCode(env, lookup);
  await call(env, `/api/p/${body.id}/open`, { method: 'POST', body: '{}' }); // burns it
  const r = await lookupCode(env, lookup);
  assert.equal(r.status, 410);
  assert.equal((await r.json()).reason, 'burned');
  assert.equal((await lookupCode(env, lookup)).status, 404, 'code record dropped');
});

test('code: a code already in use is refused and the new link is undone', async () => {
  const env = makeEnv();
  const lookup = b64(rand(32));
  await createWithCode(env, lookup);
  const { res, body } = await createWithCode(env, lookup);
  assert.equal(res.status, 409);
  assert.equal(body.error, 'code_taken');
  assert.equal(env._blobs.size, 1, 'second ciphertext deleted');
});

test('code: bad input and expiry', async () => {
  const env = makeEnv();
  assert.equal((await lookupCode(env, 'short')).status, 400);
  const bad = { expiry: 'burn', iv: b64(rand(12)), code: { lookup: 'x', wrapped: 'y', wrapIv: 'z' } };
  assert.equal((await call(env, '/api/p', { method: 'POST', headers: { 'x-ashdrop-meta': JSON.stringify(bad) }, body: rand(8) })).status, 400);
  const lookup = b64(rand(32));
  await createWithCode(env, lookup, { expiry: '1h' });
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600e3;
  try { assert.equal((await lookupCode(env, lookup)).status, 404); } finally { Date.now = realNow; }
});

test('code: lookups are rate limited', async () => {
  const env = makeEnv();
  env.CODE_LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await lookupCode(env, b64(rand(32)))).status, 429);
});
