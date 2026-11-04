// Accounts and the encrypted vault, end to end: the real browser code (src/lib/account.js, vault.js)
// against the real Worker, with in-memory storage. Run with: npm test
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
const vault = await import('../src/lib/vault.js');
const OWNER = 'owner-key-' + 'x'.repeat(40);
const bytes = (n, seed = 1) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; };
const fileOf = (name, data, type = '') => new File([data], name, { type });

async function setup() {
  const env = makeEnv(); env.OWNER_KEY = OWNER;
  const owner = browser(env);
  const invite = await inside(owner, async () => (await account.makeInvites(OWNER, 2, 1)).codes);
  return { env, invite };
}

test('accounts: invite-only sign-up, sign-in elsewhere, wrong password, no reading the password', async () => {
  const { env, invite } = await setup();
  const phone = browser(env);
  await assert.rejects(inside(phone, () => account.signUp({ email: 'a@b.co', password: 'correct horse 1', invite: 'NOPE-NOPE-NOPE' })), /invite code/);
  const { account: acc, recoveryKey } = await inside(phone, () => account.signUp({ email: 'Chinguun@Example.com ', password: 'correct horse 1', invite: invite[0] }));
  assert.equal(acc.email, 'chinguun@example.com');
  assert.equal(acc.quota, 1024 ** 3, 'quota from the invite (1 GB)');
  assert.match(recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  // the invite is used up
  await assert.rejects(inside(browser(env), () => account.signUp({ email: 'x@y.co', password: 'pw pw pw 1', invite: invite[0] })), /invite code/);
  // same email twice
  await assert.rejects(inside(browser(env), () => account.signUp({ email: 'chinguun@example.com', password: 'pw pw pw 1', invite: invite[1] })), /already an account/);
  // sign in on another device
  const pc = browser(env);
  await assert.rejects(inside(pc, () => account.signIn({ email: 'chinguun@example.com', password: 'wrong' })), /do not match/);
  await assert.rejects(inside(pc, () => account.signIn({ email: 'nobody@example.com', password: 'wrong' })), /do not match/, 'same answer for unknown emails');
  const again = await inside(pc, () => account.signIn({ email: 'CHINGUUN@example.com', password: 'correct horse 1' }));
  assert.equal(again.uid, acc.uid);
  // the server never holds the password or the vault key in any readable form
  const dump = JSON.stringify([...env._users.values()].map((o) => o.state.storage)) + JSON.stringify([...env._blobs.keys()]);
  assert.ok(!dump.includes('correct horse'));
});

test('vault: chunked upload of a 20 MB file, list, download byte-identical, quota, rename, delete', async () => {
  const { env, invite } = await setup();
  const me = browser(env);
  await inside(me, () => account.signUp({ email: 'v@e.co', password: 'vault pass 1', invite: invite[0] }));
  const big = bytes(20 * 1024 * 1024 + 123, 7);
  let last = 0;
  const up = await inside(me, () => vault.uploadFile(fileOf('trip video.mp4', big, 'video/mp4'), { folder: 'Mongolia', onProgress: (p) => { last = p; } }));
  assert.equal(up.chunks, 3);
  assert.ok(Math.abs(last - 1) < 1e-9, 'progress reaches 100%');
  await inside(me, () => vault.uploadFile(fileOf('empty.txt', new Uint8Array(0))));
  // nothing readable in storage: names are sealed, chunks are ciphertext
  const blobs = [...env._blobs.entries()].filter(([k]) => k.startsWith('v/'));
  assert.equal(blobs.length, 4);
  assert.ok(!JSON.stringify([...env._users.values()].map((o) => o.state.storage)).includes('trip video'));
  const firstChunk = blobs.find(([k]) => k.endsWith('/0'))[1];
  assert.notDeepEqual(firstChunk.slice(12, 40), big.slice(0, 28));
  // list from another device after signing in there
  const pc = browser(env);
  await inside(pc, () => account.signIn({ email: 'v@e.co', password: 'vault pass 1' }));
  const { files, used, quota } = await inside(pc, () => vault.listFiles());
  assert.deepEqual(files.map((f) => f.name).sort(), ['empty.txt', 'trip video.mp4']);
  assert.equal(files.find((f) => f.name === 'trip video.mp4').folder, 'Mongolia');
  assert.equal(used, big.length + 3 * 28 + 28);
  assert.equal(quota, 1024 ** 3);
  const blob = await inside(pc, () => vault.downloadFile(files.find((f) => f.name === 'trip video.mp4')));
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), big);
  const empty = await inside(pc, () => vault.downloadFile(files.find((f) => f.name === 'empty.txt')));
  assert.equal(empty.size, 0);
  // rename and move
  const vid = files.find((f) => f.name === 'trip video.mp4');
  await inside(pc, () => vault.updateFile(vid, { name: 'taimen.mp4', folder: null }));
  const after = await inside(me, () => vault.listFiles());
  assert.ok(after.files.some((f) => f.name === 'taimen.mp4' && f.folder === null));
  // swapping chunks is detected (positions are bound into the encryption)
  const k0 = blobs.find(([k]) => k.endsWith('/0'))[0], k1 = blobs.find(([k]) => k.endsWith('/1'))[0];
  const c0 = env._blobs.get(k0); env._blobs.set(k0, env._blobs.get(k1)); env._blobs.set(k1, c0);
  await assert.rejects(inside(pc, () => vault.downloadFile(vid)), /could not be decrypted/);
  env._blobs.set(k1, env._blobs.get(k0)); env._blobs.set(k0, c0);
  // delete frees the space and the stored chunks
  await inside(pc, () => vault.deleteFile(vid));
  assert.equal([...env._blobs.keys()].filter((k) => k.startsWith('v/')).length, 1);
  assert.equal((await inside(pc, () => vault.listFiles())).used, 28);
  // quota: 1 GB account cannot take more than 1 GB
  await assert.rejects(inside(me, () => vault.uploadFile({ name: 'huge', type: '', size: 1024 ** 3 + 1, slice: () => new Blob([]) })), /Not enough space/);
});

test('vault: other people and stale sessions get nothing', async () => {
  const { env, invite } = await setup();
  const alice = browser(env), bob = browser(env);
  await inside(alice, () => account.signUp({ email: 'alice@e.co', password: 'alice pass 1', invite: invite[0] }));
  const f = await inside(alice, () => vault.uploadFile(fileOf('secret.pdf', bytes(5000))));
  await inside(bob, () => account.signUp({ email: 'bob@e.co', password: 'bob pass 11', invite: invite[1] }));
  assert.equal((await inside(bob, () => vault.listFiles())).files.length, 0);
  // Bob asks for Alice's chunk with his own session: not found
  const r = await inside(bob, () => fetch(`/api/vault/files/${f.id}/0`, { headers: account.authHeader() }));
  assert.equal(r.status, 404);
  // no session at all
  assert.equal((await inside(browser(env), () => fetch('/api/vault/files'))).status, 401);
  // signing out kills the session
  const header = await inside(alice, () => account.authHeader());
  await inside(alice, () => account.signOut());
  assert.equal((await inside(browser(env), () => fetch('/api/vault/files', { headers: header }))).status, 401);
});

test('recovery key resets a forgotten password; the files survive; old sessions end', async () => {
  const { env, invite } = await setup();
  const me = browser(env);
  const { recoveryKey } = await inside(me, () => account.signUp({ email: 'r@e.co', password: 'old password 1', invite: invite[0] }));
  await inside(me, () => vault.uploadFile(fileOf('passport scan.jpg', bytes(3000, 3))));
  const oldHeader = await inside(me, () => account.authHeader());
  const other = browser(env);
  await assert.rejects(inside(other, () => account.recover({ email: 'r@e.co', recoveryKey: account.newRecoveryKey(), newPassword: 'x' })), /does not match/);
  await inside(other, () => account.recover({ email: 'r@e.co', recoveryKey: recoveryKey.toLowerCase().replace(/-/g, ' '), newPassword: 'new password 2' }));
  const { files } = await inside(other, () => vault.listFiles());
  assert.equal(files[0].name, 'passport scan.jpg');
  assert.deepEqual(new Uint8Array(await (await inside(other, () => vault.downloadFile(files[0]))).arrayBuffer()), bytes(3000, 3));
  assert.equal((await inside(browser(env), () => fetch('/api/vault/files', { headers: oldHeader }))).status, 401, 'old session signed out');
  await assert.rejects(inside(browser(env), () => account.signIn({ email: 'r@e.co', password: 'old password 1' })), /do not match/);
  await inside(browser(env), () => account.signIn({ email: 'r@e.co', password: 'new password 2' }));
});

test('change password, unlock, delete account removes everything', async () => {
  const { env, invite } = await setup();
  const me = browser(env);
  await inside(me, () => account.signUp({ email: 'd@e.co', password: 'first pass 1', invite: invite[0] }));
  await inside(me, () => vault.uploadFile(fileOf('a.txt', bytes(100))));
  await assert.rejects(inside(me, () => account.changePassword({ oldPassword: 'nope', newPassword: 'second pass 2' })), /current password/);
  await inside(me, () => account.changePassword({ oldPassword: 'first pass 1', newPassword: 'second pass 2' }));
  // lock, then unlock with the new password
  await inside(me, () => account.lockVault());
  await assert.rejects(inside(me, () => vault.listFiles()), /locked/);
  await assert.rejects(inside(me, () => account.unlock('first pass 1')), /not right/);
  await inside(me, () => account.unlock('second pass 2'));
  assert.equal((await inside(me, () => vault.listFiles())).files.length, 1);
  await inside(me, () => account.deleteAccount('second pass 2'));
  assert.equal([...env._blobs.keys()].filter((k) => k.startsWith('v/')).length, 0, 'all chunks deleted');
  await assert.rejects(inside(browser(env), () => account.signIn({ email: 'd@e.co', password: 'second pass 2' })), /do not match/);
  // the email can be used again
  const inv = await inside(browser(env), async () => (await account.makeInvites(OWNER, 1, 1)).codes[0]);
  await inside(browser(env), () => account.signUp({ email: 'd@e.co', password: 'third pass 3', invite: inv }));
});

test('only the site owner can make invites', async () => {
  const env = makeEnv(); env.OWNER_KEY = OWNER;
  await assert.rejects(inside(browser(env), () => account.makeInvites('wrong-key-' + 'y'.repeat(40), 1, 5)), /Not found/);
});

test('ten wrong passwords lock the account for 15 minutes', async () => {
  const { env, invite } = await setup();
  await inside(browser(env), () => account.signUp({ email: 'l@e.co', password: 'right password 1', invite: invite[0] }));
  for (let i = 0; i < 10; i++) await assert.rejects(inside(browser(env), () => account.signIn({ email: 'l@e.co', password: 'wrong ' + i })), /do not match/);
  await assert.rejects(inside(browser(env), () => account.signIn({ email: 'l@e.co', password: 'right password 1' })), /Wait 15 minutes/);
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60e3;
  try { await inside(browser(env), () => account.signIn({ email: 'l@e.co', password: 'right password 1' })); } finally { Date.now = realNow; }
});
