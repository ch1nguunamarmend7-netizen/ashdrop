// Sign in with Google, end to end, with a fake Google token endpoint. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { makeEnv } from './mock-env.mjs';

const FAKE = 'https://fake-google.test';
const b64j = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function world() {
  const env = makeEnv();
  env.OWNER_KEY = 'owner-key-' + 'x'.repeat(40);
  Object.assign(env, { GOOGLE_CLIENT_ID: 'ashdrop-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh', GOOGLE_AUTH_URL: FAKE + '/auth', GOOGLE_TOKEN_URL: FAKE + '/token' });
  const codes = new Map(); // code -> claims (what "Google" will say about the person)
  const fakeGoogle = async (url, init) => {
    const form = new URLSearchParams(await new Response(init.body).text());
    const claims = codes.get(form.get('code'));
    if (!claims || form.get('client_secret') !== 'shh' || !form.get('code_verifier')) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({ id_token: `${b64j({ alg: 'RS256' })}.${b64j(claims)}.sig` });
  };
  return { env, codes, fakeGoogle };
}

function browser(w) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const g = { localStorage: store(), sessionStorage: store(), location: { hash: '', assigned: null, assign(u) { this.assigned = u; } } };
  g.fetch = async (path, init = {}) => {
    if (String(path).startsWith(FAKE)) return w.fakeGoogle(path, init); // the Worker talking to "Google"
    const headers = new Headers(init.headers);
    if (init.body instanceof Uint8Array && !headers.has('content-length')) headers.set('content-length', String(init.body.length));
    return worker.fetch(new Request('https://ashdrop.test' + path, { ...init, headers }), w.env, { waitUntil() {} });
  };
  g.XMLHttpRequest = class {
    open(m, p) { this.m = m; this.p = p; this.h = {}; this.upload = {}; }
    setRequestHeader(k, v) { this.h[k] = v; }
    async send(body) { const r = await g.fetch(this.p, { method: this.m, headers: this.h, body }); this.status = r.status; this.responseText = await r.text(); this.onload?.(); }
  };
  return g;
}
async function inside(b, fn) {
  const keys = ['fetch', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'location'];
  const keep = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of keys) Object.defineProperty(globalThis, k, { value: b[k], configurable: true, writable: true });
  try { return await fn(); } finally { for (const k of keys) keep[k] ? Object.defineProperty(globalThis, k, keep[k]) : delete globalThis[k]; }
}
const account = await import('../src/lib/account.js');
const vault = await import('../src/lib/vault.js');

/** Click "Continue with Google" in browser b, "be" the given Google user, and come back. Returns the hash. */
async function viaGoogle(w, b, who, { mode = 'signin', tamper } = {}) {
  await inside(b, () => account.startOAuth('google', mode));
  const u = new URL(b.location.assigned);
  assert.equal(u.origin + u.pathname, FAKE + '/auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const code = 'code-' + Math.random();
  w.codes.set(code, { iss: 'https://accounts.google.com', aud: w.env.GOOGLE_CLIENT_ID, sub: who.sub, email: who.email, email_verified: true, nonce: u.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 600, ...(tamper || {}) });
  // Google redirects the browser back; the Worker then talks to (fake) Google itself.
  const r = await inside(b, () => worker.fetch(new Request(`https://ashdrop.test/api/oauth/google/callback?code=${code}&state=${u.searchParams.get('state')}`), w.env, {}));
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.pathname, '/vault');
  return loc.hash;
}
const finish = (b, hash) => inside(b, () => account.finishOAuth(hash));

async function invite(w) { return inside(browser(w), async () => (await account.makeInvites(w.env.OWNER_KEY, 1, 2)).codes[0]); }

test('Google: new person signs up with invite + PIN, then signs in on another device and unlocks with the PIN', async () => {
  const w = world();
  const me = browser(w);
  const res = await finish(me, await viaGoogle(w, me, { sub: 'g-111', email: 'Chinguun@Gmail.com' }));
  assert.equal(res.status, 'new');
  assert.equal(res.email, 'chinguun@gmail.com');
  const inv0 = await invite(w);
  await assert.rejects(inside(me, () => account.oauthSignUp({ ...res, pin: '123', invite: inv0 })), /at least 6/);
  const { account: acc, recoveryKey } = await inside(me, async () => account.oauthSignUp({ ...res, pin: '481516', invite: await invite(w) }));
  assert.equal(acc.hasPassword, false);
  assert.deepEqual(acc.identities, [{ provider: 'google', email: 'chinguun@gmail.com' }]);
  assert.ok(recoveryKey);
  await inside(me, () => vault.uploadFile(new File([new Uint8Array([1, 2, 3])], 'note.txt')));
  // another device
  const pc = browser(w);
  const r2 = await finish(pc, await viaGoogle(w, pc, { sub: 'g-111', email: 'chinguun@gmail.com' }));
  assert.equal(r2.status, 'signedin');
  await assert.rejects(inside(pc, () => vault.listFiles()), /locked/, 'signed in, but Google alone cannot unlock');
  await assert.rejects(inside(pc, () => account.unlockWithPin('000000')), /not right/);
  await inside(pc, () => account.unlockWithPin('481516'));
  assert.equal((await inside(pc, () => vault.listFiles())).files[0].name, 'note.txt');
  // a password sign-in does not exist for this account
  await assert.rejects(inside(browser(w), () => account.signIn({ email: 'chinguun@gmail.com', password: '481516' })), /do not match/);
});

test('PIN: 10 wrong tries turn PIN unlock off; the recovery key sets a new PIN', async () => {
  const w = world();
  const me = browser(w);
  const res = await finish(me, await viaGoogle(w, me, { sub: 'g-222', email: 'p@gmail.com' }));
  const { recoveryKey } = await inside(me, async () => account.oauthSignUp({ ...res, pin: 'my pin 1', invite: await invite(w) }));
  await inside(me, () => account.lockVault());
  for (let i = 0; i < 9; i++) await assert.rejects(inside(me, () => account.unlockWithPin('nope' + i)), /not right/);
  await assert.rejects(inside(me, () => account.unlockWithPin('nope 10')), /PIN unlock is now off/);
  await assert.rejects(inside(me, () => account.unlockWithPin('my pin 1')), /PIN unlock is off/, 'even the right PIN no longer works');
  await inside(me, () => account.recover({ email: 'p@gmail.com', recoveryKey, newPin: 'new pin 22' }));
  await inside(me, () => account.lockVault());
  await inside(me, () => account.unlockWithPin('new pin 22'));
});

test('Google: an email that already has a password account is not taken over; it can be connected from inside', async () => {
  const w = world();
  const owner = browser(w);
  await inside(owner, async () => account.signUp({ email: 'same@gmail.com', password: 'password account', invite: await invite(w) }));
  const stranger = browser(w);
  const res = await finish(stranger, await viaGoogle(w, stranger, { sub: 'g-333', email: 'same@gmail.com' }));
  assert.match(res.error, /already an Ashdrop account/);
  // the real owner connects Google while signed in
  const linked = await finish(owner, await viaGoogle(w, owner, { sub: 'g-333', email: 'same@gmail.com' }, { mode: 'link' }));
  assert.equal(linked.status, 'linked');
  assert.equal(linked.account.identities[0].provider, 'google');
  // now Google signs in to that account (locked; the password unlocks it)
  const pc = browser(w);
  const r = await finish(pc, await viaGoogle(w, pc, { sub: 'g-333', email: 'same@gmail.com' }));
  assert.equal(r.status, 'signedin');
  await inside(pc, () => account.unlock('password account'));
  assert.equal((await inside(pc, () => vault.listFiles())).files.length, 0);
});

test('Google: tickets are single-use, must come back to the same tab, and bad tokens are refused', async () => {
  const w = world();
  const a = browser(w);
  const hash = await viaGoogle(w, a, { sub: 'g-444', email: 'q@gmail.com' });
  // another tab/browser cannot finish it (login CSRF protection)
  assert.match((await finish(browser(w), hash)).error, /did not start in this browser tab/);
  // the ticket was not used up by the failed attempt in the other browser; this tab can finish once
  assert.equal((await finish(a, hash)).status, 'new');
  assert.ok((await finish(a, hash)).error, 'second use refused');
  for (const tamper of [{ aud: 'someone-else' }, { nonce: 'replayed' }, { email_verified: false }, { iss: 'https://evil.test' }, { exp: 1 }]) {
    const h = await viaGoogle(w, a, { sub: 'g-555', email: 'r@gmail.com' }, { tamper });
    assert.match(h, /oauth_error=/, JSON.stringify(tamper));
  }
  // an unknown or replayed state at the callback
  const r = await worker.fetch(new Request('https://ashdrop.test/api/oauth/google/callback?code=x&state=' + 'A'.repeat(32)), w.env, {});
  assert.match(r.headers.get('location'), /oauth_error=expired/);
});

test('providers: off until configured; Apple stays off without its keys', async () => {
  const env = makeEnv();
  assert.deepEqual(await (await worker.fetch(new Request('https://ashdrop.test/api/oauth/providers'), env, {})).json(), { google: false, apple: false });
  assert.equal((await worker.fetch(new Request('https://ashdrop.test/api/oauth/google/prepare', { method: 'POST', body: '{}' }), env, {})).status, 404);
  const w = world();
  assert.deepEqual(await (await worker.fetch(new Request('https://ashdrop.test/api/oauth/providers'), w.env, {})).json(), { google: true, apple: false });
});
