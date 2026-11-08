// My links kept in the vault, end to end: the real browser code (src/lib/myLinks.js) against the
// real Worker, with in-memory storage. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { makeEnv } from './mock-env.mjs';

// ---- a tiny browser: fetch → Worker, localStorage, sessionStorage, XMLHttpRequest ----
function browser(env, { ownerKey } = {}) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
  const g = { localStorage: store(), sessionStorage: store() };
  g.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body instanceof Uint8Array && !headers.has('content-length')) headers.set('content-length', String(init.body.length));
    return worker.fetch(new Request('https://ashdrop.test' + path, { ...init, headers }), env, { waitUntil() {} });
  };
  g.XMLHttpRequest = class {
    open(m, p) { this.m = m; this.p = p; this.h = {}; this.upload = {}; }
    setRequestHeader(k, v) { this.h[k] = v; }
    async send(body) {
      const r = await g.fetch(this.p, { method: this.m, headers: this.h, body });
      this.status = r.status; this.responseText = await r.text();
      this.upload.onprogress?.({ lengthComputable: true, loaded: body?.length || 0 });
      this.onload?.();
    }
  };
  return g;
}
// Run a function "inside" a browser (swap the globals the libraries use).
async function inside(b, fn) {
  const keep = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, XMLHttpRequest: globalThis.XMLHttpRequest };
  Object.assign(globalThis, b);
  try { return await fn(); } finally { Object.assign(globalThis, keep); }
}
const account = await import('../src/lib/account.js');
const myLinks = await import('../src/lib/myLinks.js');
const linkStore = await import('../src/lib/linkStore.js');
const OWNER = 'owner-key-' + 'x'.repeat(40);
const bytes = (n, seed = 1) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; };
const fileOf = (name, data, type = '') => new File([data], name, { type });

async function setup() {
  const env = makeEnv(); env.OWNER_KEY = OWNER;
  const owner = browser(env);
  const invite = await inside(owner, async () => (await account.makeInvites(OWNER, 2, 1)).codes);
  return { env, invite };
}


const rec = (id, label, t) => ({ id, keyStr: 'KEY-' + id + '-secret', ownerToken: 'OWN-' + id, expiresAt: t + 864e5, kind: 'paste', label, createdAt: t });

test('My links: saved in the vault, readable only with it unlocked, on every device', async () => {
  const { env, invite } = await setup();
  const phone = browser(env);
  await inside(phone, () => account.signUp({ email: 'me@ash.co', password: 'pw for links 1', invite: invite[0] }));
  const now = Date.now();
  assert.equal(await inside(phone, () => myLinks.add(rec('aaaaaaaaaaaa', 'Wi-Fi', now - 2000))), 'vault');
  // locked vault: new links still save (sealed to the public key) but cannot be read
  await inside(phone, () => account.lockVault());
  assert.equal(await inside(phone, () => myLinks.add(rec('bbbbbbbbbbbb', 'Door code', now - 1000))), 'vault');
  await assert.rejects(inside(phone, () => myLinks.list()), /locked/);
  // the server never sees keys, tokens or labels
  let dump = '';
  for (const obj of env._users.values()) dump += JSON.stringify([...(await obj.state.storage.list())]);
  assert.ok(dump.includes('aaaaaaaaaaaa'), 'the dump really holds the saved links');
  for (const secret of ['KEY-aaaaaaaaaaaa', 'OWN-bbbbbbbbbbbb', 'Door code']) assert.ok(!dump.includes(secret), secret);
  // a links-free device that signs in sees both, newest first, and moves its own device links in
  const pc = browser(env);
  await inside(pc, () => linkStore.savePlain([rec('cccccccccccc', 'Made before sign-in', now - 500)]));
  await inside(pc, () => account.signIn({ email: 'me@ash.co', password: 'pw for links 1' }));
  const got = await inside(pc, () => myLinks.list());
  assert.deepEqual(got.map((l) => l.label), ['Made before sign-in', 'Door code', 'Wi-Fi']);
  assert.equal(got[1].keyStr, 'KEY-bbbbbbbbbbbb-secret');
  assert.deepEqual(await inside(pc, () => linkStore.loadPlain()), [], 'device copy cleared after moving in');
  // remove one; the phone sees it gone after unlocking
  await inside(pc, () => myLinks.remove('aaaaaaaaaaaa'));
  await inside(phone, () => account.signIn({ email: 'me@ash.co', password: 'pw for links 1' }));
  assert.deepEqual((await inside(phone, () => myLinks.list())).map((l) => l.id), ['cccccccccccc', 'bbbbbbbbbbbb']);
});

test('My links: old passcode-locked device links move in once; another account cannot read them', async () => {
  const { env, invite } = await setup();
  const me = browser(env);
  const now = Date.now();
  await inside(me, async () => { await linkStore.createLock('old passcode', [rec('dddddddddddd', 'Locked one', now)]); });
  await inside(me, () => account.signUp({ email: 'x@ash.co', password: 'pw for links 2', invite: invite[0] }));
  const r = await inside(me, () => linkStore.unlock('old passcode'));
  await inside(me, () => myLinks.importRecords(r.records));
  await inside(me, () => linkStore.forgetAll());
  assert.deepEqual((await inside(me, () => myLinks.list())).map((l) => l.label), ['Locked one']);
  // someone else's account sees nothing
  const other = browser(env);
  await inside(other, () => account.signUp({ email: 'y@ash.co', password: 'pw for links 3', invite: invite[1] }));
  assert.deepEqual(await inside(other, () => myLinks.list()), []);
  // bad input is refused
  const res = await inside(other, () => fetch('/api/vault/links', { method: 'POST', headers: { ...account.authHeader(), 'content-type': 'application/json' }, body: JSON.stringify({ id: '../x', blob: 'a' }) }));
  assert.equal(res.status, 400);
  const res2 = await inside(browser(env), () => fetch('/api/vault/links', { method: 'GET' }));
  assert.equal(res2.status, 401, 'signed out');
});
