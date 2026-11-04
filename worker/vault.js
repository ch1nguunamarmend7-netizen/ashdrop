// Ashdrop accounts and the encrypted vault.
//
// Zero-knowledge, like a password manager:
//   - The browser turns the password into two unrelated keys (PBKDF2 → HKDF). One proves who you are
//     ("auth key"); the other never leaves the browser and unlocks the vault key.
//   - The vault key is stored here only wrapped (encrypted) by the password key, by the recovery key,
//     and by each passkey. We cannot unwrap any of them.
//   - Every file is encrypted in the browser with its own key, in chunks. File names, types and folders
//     are encrypted too ("meta"). We store bytes, sizes and dates.
//
// One UserDO per account holds the account, its sessions, passkeys and file list, so quota checks and
// updates are atomic. Small index objects map an email, a passkey or an invite code to an account.

import { json, sha256b64, bytesToB64url, b64urlToBytes, safeEqual } from './link.js';

const B64 = /^[A-Za-z0-9_-]+$/;
const isB64 = (v, min = 1, max = 4096) => typeof v === 'string' && v.length >= min && v.length <= max && B64.test(v);
const CHUNK_MAX = 8 * 1024 * 1024 + 64;          // 8 MiB of plaintext per chunk, plus IV and tag
const SESSION_MS = 30 * 24 * 3600e3;
const UPLOAD_STALE_MS = 24 * 3600e3;            // unfinished uploads are cleaned up after a day
const DEFAULT_QUOTA = 5 * 1024 ** 3;            // 5 GB
const MAX_QUOTA = 2 * 1024 ** 4;                // 2 TB
const enc = new TextEncoder();

const sha = async (s) => bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)));
const rand = (n) => bytesToB64url(crypto.getRandomValues(new Uint8Array(n)));
const userStub = (env, uid) => env.USERS.get(env.USERS.idFromName('u:' + uid));
const indexStub = (env, name) => env.USERS.get(env.USERS.idFromName(name));
const call = async (stub, path, body) => {
  const r = await stub.fetch('https://user/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const normEmail = (e) => String(e || '').trim().toLowerCase();
const okEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export class UserDO {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    return this.state.blockConcurrencyWhile(() => this.route(url.pathname.slice(1), body));
  }

  get s() { return this.state.storage; }

  async route(path, b) {
    switch (path) {
      // ----- index objects (email:, cred:, invite:, chal:) -----
      case 'index-get': { const v = await this.s.get('v'); return v && (!v.exp || Date.now() < v.exp) ? json(v) : json({ error: 'not_found' }, 404); }
      case 'index-claim': {
        const v = await this.s.get('v');
        if (v && (!v.exp || Date.now() < v.exp)) return json({ error: 'exists' }, 409);
        await this.s.put('v', b.value); if (b.value.exp) await this.s.setAlarm(b.value.exp);
        return json({ ok: true });
      }
      case 'index-take': { // read once, then delete (challenges, invites)
        const v = await this.s.get('v');
        await this.s.deleteAll();
        return v && (!v.exp || Date.now() < v.exp) ? json(v) : json({ error: 'not_found' }, 404);
      }
      case 'index-drop': await this.s.deleteAll(); return json({ ok: true });

      // ----- the account -----
      case 'create': return this.create(b);
      case 'login': return this.login(b);
      case 'auth': return this.auth(b);
      case 'logout': return this.logout(b);
      case 'password': return this.password(b);
      case 'recover': return this.recover(b);
      case 'account': return this.account(b);
      case 'delete-account': return this.deleteAccount(b);
      case 'passkey-add': return this.passkeyAdd(b);
      case 'passkey-remove': return this.passkeyRemove(b);
      case 'passkey-login': return this.passkeyLogin(b);
      case 'prefs': return this.prefs(b);
      // ----- files -----
      case 'file-new': return this.fileNew(b);
      case 'file-chunk-ok': return this.fileChunkOk(b);
      case 'file-done': return this.fileDone(b);
      case 'file-list': return this.fileList(b);
      case 'file-get': return this.fileGet(b);
      case 'file-meta': return this.fileMeta(b);
      case 'file-delete': return this.fileDelete(b);
      default: return json({ error: 'not_found' }, 404);
    }
  }

  async alarm() {
    const v = await this.s.get('v');
    if (v?.exp && Date.now() >= v.exp) await this.s.deleteAll();
  }

  // ---------- helpers ----------
  async user() { return this.s.get('user'); }
  async session(b) {
    const u = await this.user();
    if (!u || typeof b.token !== 'string') return null;
    const h = await sha(b.token);
    const sess = (await this.s.get('sessions')) || {};
    const s = sess[h];
    if (!s || Date.now() > s.exp) return null;
    if (Date.now() - s.seen > 3600e3) { s.seen = Date.now(); s.exp = Date.now() + SESSION_MS; await this.s.put('sessions', sess); }
    return u;
  }
  async newSession(label) {
    const token = rand(32);
    const sess = (await this.s.get('sessions')) || {};
    const now = Date.now();
    for (const [k, v] of Object.entries(sess)) if (v.exp < now) delete sess[k];
    sess[await sha(token)] = { created: now, seen: now, exp: now + SESSION_MS, label: String(label || '').slice(0, 60) };
    await this.s.put('sessions', sess);
    return token;
  }
  checkAuth(u, authKey) { return Promise.all([sha(u.salt + '|' + authKey)]).then(([h]) => safeEqual(h, u.authHash)); }
  public(u) {
    return { uid: u.uid, email: u.email, wrapped: u.wrapped, quota: u.quota, used: u.used, owner: !!u.owner,
      passkeys: (u.passkeys || []).map((p) => ({ id: p.id, name: p.name, created: p.created })), created: u.created };
  }

  // ---------- account ----------
  async create(b) {
    if (await this.user()) return json({ error: 'exists' }, 409);
    const salt = rand(16);
    const u = {
      uid: b.uid, email: b.email, created: Date.now(), salt, authHash: await sha(salt + '|' + b.authKey),
      wrapped: b.wrapped, recovery: { wrapped: b.recoveryWrapped, authHash: await sha(salt + '|' + b.recoveryAuth) },
      quota: b.quota, used: 0, owner: !!b.owner, passkeys: [],
    };
    await this.s.put('user', u);
    return json({ token: await this.newSession(b.label), account: this.public(u) });
  }

  async login(b) {
    const u = await this.user();
    if (!u) return json({ error: 'wrong' }, 401);
    // 10 wrong passwords in a row → wait 15 minutes. Stops guessing against one account from many networks.
    if (u.fails?.until > Date.now()) return json({ error: 'locked_out', until: u.fails.until }, 429);
    if (!(await this.checkAuth(u, b.authKey))) {
      const n = (u.fails?.n || 0) + 1;
      u.fails = n >= 10 ? { n: 0, until: Date.now() + 15 * 60e3 } : { n };
      await this.s.put('user', u);
      return json({ error: 'wrong' }, 401);
    }
    if (u.fails) { delete u.fails; await this.s.put('user', u); }
    return json({ token: await this.newSession(b.label), account: this.public(u) });
  }

  async auth(b) { const u = await this.session(b); return u ? json({ ok: true }) : json({ error: 'signed_out' }, 401); }

  async logout(b) {
    const sess = (await this.s.get('sessions')) || {};
    delete sess[await sha(b.token || '')];
    await this.s.put('sessions', sess);
    return json({ ok: true });
  }

  async account(b) { const u = await this.session(b); return u ? json(this.public(u)) : json({ error: 'signed_out' }, 401); }

  // Change password while signed in: the old auth key proves it is you; the vault key is re-wrapped in the browser.
  async password(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    if (!(await this.checkAuth(u, b.authKey))) return json({ error: 'wrong' }, 401);
    u.authHash = await sha(u.salt + '|' + b.newAuthKey); u.wrapped = b.newWrapped;
    await this.s.put('user', u);
    await this.s.put('sessions', {});                     // sign out everywhere else
    return json({ token: await this.newSession(b.label), account: this.public(u) });
  }

  // Forgot password: the recovery key proves it is you; the browser re-wraps the vault key with a new password.
  async recover(b) {
    const u = await this.user();
    if (!u) return json({ error: 'wrong' }, 401);
    if (b.step === 'start') {
      if (!safeEqual(await sha(u.salt + '|' + b.recoveryAuth), u.recovery.authHash)) return json({ error: 'wrong' }, 401);
      return json({ recoveryWrapped: u.recovery.wrapped });
    }
    if (!safeEqual(await sha(u.salt + '|' + b.recoveryAuth), u.recovery.authHash)) return json({ error: 'wrong' }, 401);
    u.authHash = await sha(u.salt + '|' + b.newAuthKey); u.wrapped = b.newWrapped;
    await this.s.put('user', u);
    await this.s.put('sessions', {});
    return json({ token: await this.newSession(b.label), account: this.public(u) });
  }

  async deleteAccount(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    if (!(await this.checkAuth(u, b.authKey))) return json({ error: 'wrong' }, 401);
    const files = await this.s.list({ prefix: 'f:' });
    const keys = [];
    for (const [, f] of files) for (let n = 0; n < f.chunks; n++) keys.push(chunkKey(u.uid, f.id, n));
    for (let i = 0; i < keys.length; i += 1000) await this.env.BLOBS.delete(keys.slice(i, i + 1000));
    await this.s.deleteAll();
    return json({ ok: true, email: u.email, passkeys: (u.passkeys || []).map((p) => p.id) });
  }

  async prefs(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    if (typeof b.blob === 'string') { await this.s.put('prefs', b.blob); return json({ ok: true }); }
    return json({ blob: (await this.s.get('prefs')) || null });
  }

  // ---------- passkeys ----------
  async passkeyAdd(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    u.passkeys = (u.passkeys || []).filter((p) => p.id !== b.passkey.id);
    if (u.passkeys.length >= 10) return json({ error: 'too_many' }, 429);
    u.passkeys.push({ ...b.passkey, created: Date.now() });
    await this.s.put('user', u);
    return json(this.public(u));
  }
  async passkeyRemove(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    u.passkeys = (u.passkeys || []).filter((p) => p.id !== b.id);
    await this.s.put('user', u);
    return json(this.public(u));
  }
  // The Worker has already verified the signature against the stored key (it asks for the key first).
  async passkeyLogin(b) {
    const u = await this.user();
    const p = u?.passkeys?.find((x) => x.id === b.id);
    if (!p) return json({ error: 'not_found' }, 404);
    if (b.peek) return json({ spki: p.spki, alg: p.alg, counter: p.counter || 0 });
    if (b.counter && p.counter && b.counter <= p.counter) return json({ error: 'cloned' }, 401); // a copied key replays old counters
    p.counter = b.counter || 0;
    await this.s.put('user', u);
    return json({ token: await this.newSession(b.label), account: this.public(u), wrappedByPasskey: p.wrapped });
  }

  // ---------- files ----------
  async fileNew(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    await this.cleanStale(u);
    if (u.used + b.size > u.quota) return json({ error: 'quota', used: u.used, quota: u.quota }, 413);
    const f = { id: rand(12), size: b.size, chunks: b.chunks, meta: b.meta, state: 'uploading', created: Date.now(), got: 0 };
    u.used += f.size;
    await this.s.put('user', u);
    await this.s.put('f:' + f.id, f);
    return json({ id: f.id, uid: u.uid });
  }
  async fileChunkOk(b) { // may this chunk be uploaded? (asked before streaming it to storage)
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    const f = await this.s.get('f:' + b.id);
    if (!f || f.state !== 'uploading' || !(b.n >= 0 && b.n < f.chunks)) return json({ error: 'not_found' }, 404);
    return json({ ok: true, uid: u.uid });
  }
  async fileDone(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    const f = await this.s.get('f:' + b.id);
    if (!f || f.state !== 'uploading') return json({ error: 'not_found' }, 404);
    if (b.stored !== f.size) return json({ error: 'incomplete' }, 400);
    f.state = 'ready'; delete f.got;
    await this.s.put('f:' + f.id, f);
    return json({ ok: true });
  }
  async fileList(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    await this.cleanStale(u);
    const all = await this.s.list({ prefix: 'f:' });
    const files = [...all.values()].filter((f) => f.state === 'ready').map(({ id, size, chunks, meta, created }) => ({ id, size, chunks, meta, created }));
    return json({ files, used: u.used, quota: u.quota });
  }
  async fileGet(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    const f = await this.s.get('f:' + b.id);
    if (!f || f.state !== 'ready' || !(b.n >= 0 && b.n < f.chunks)) return json({ error: 'not_found' }, 404);
    return json({ uid: u.uid });
  }
  async fileMeta(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    const f = await this.s.get('f:' + b.id);
    if (!f) return json({ error: 'not_found' }, 404);
    f.meta = b.meta;
    await this.s.put('f:' + f.id, f);
    return json({ ok: true });
  }
  async fileDelete(b) {
    const u = await this.session(b);
    if (!u) return json({ error: 'signed_out' }, 401);
    const f = await this.s.get('f:' + b.id);
    if (!f) return json({ error: 'not_found' }, 404);
    await this.removeFile(u, f);
    await this.s.put('user', u);
    return json({ ok: true, used: u.used });
  }
  async removeFile(u, f) {
    const keys = Array.from({ length: f.chunks }, (_, n) => chunkKey(u.uid, f.id, n));
    for (let i = 0; i < keys.length; i += 1000) await this.env.BLOBS.delete(keys.slice(i, i + 1000));
    await this.s.delete('f:' + f.id);
    u.used = Math.max(0, u.used - f.size);
  }
  async cleanStale(u) {
    const all = await this.s.list({ prefix: 'f:' });
    let changed = false;
    for (const f of all.values()) if (f.state === 'uploading' && Date.now() - f.created > UPLOAD_STALE_MS) { await this.removeFile(u, f); changed = true; }
    if (changed) await this.s.put('user', u);
  }
}

const chunkKey = (uid, fid, n) => `v/${uid}/${fid}/${n}`;

/* ===================== HTTP routes ===================== */

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer ([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/);
  return m ? { uid: m[1], token: m[2] } : null;
}

// /api/account/*
export async function handleAccount(request, env, url, parts, { allowed, isSiteOwner }) {
  const action = parts.slice(2).join('/');
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
  const limited = () => allowed(env.CODE_LIMITER || env.OPEN_LIMITER, request);
  const b = await request.json().catch(() => ({}));
  const label = (request.headers.get('user-agent') || '').slice(0, 60);
  const who = bearer(request);

  switch (action) {
    case 'signup': {
      if (!(await limited())) return json({ error: 'rate_limited' }, 429);
      const email = normEmail(b.email);
      if (!okEmail(email)) return json({ error: 'bad_email' }, 400);
      if (![b.authKey, b.recoveryAuth].every((v) => isB64(v, 43, 43)) || !isB64(b.wrapped, 40, 200) || !isB64(b.recoveryWrapped, 40, 200)) return json({ error: 'bad_keys' }, 400);
      // Invite codes while the vault is invite-only (the site owner can sign up without one).
      const owner = await isSiteOwner(request, env);
      let quota = DEFAULT_QUOTA;
      let inviteName = null;
      if (!owner) {
        if (typeof b.invite !== 'string' || b.invite.length > 64) return json({ error: 'bad_invite' }, 400);
        inviteName = 'invite:' + (await sha(b.invite.trim().toUpperCase()));
        const inv = await call(indexStub(env, inviteName), 'index-get');
        if (inv.status !== 200) return json({ error: 'bad_invite' }, 403);
        quota = inv.data.quota || DEFAULT_QUOTA;
      } else quota = MAX_QUOTA;
      const uid = rand(12);
      const claim = await call(indexStub(env, 'email:' + (await sha(email))), 'index-claim', { value: { uid } });
      if (claim.status === 409) return json({ error: 'email_taken' }, 409);
      if (inviteName) await call(indexStub(env, inviteName), 'index-take'); // one account per invite
      const r = await call(userStub(env, uid), 'create', { uid, email, authKey: b.authKey, wrapped: b.wrapped, recoveryWrapped: b.recoveryWrapped, recoveryAuth: b.recoveryAuth, quota, owner, label });
      return json(r.data, r.status === 200 ? 201 : r.status);
    }
    case 'login': {
      if (!(await limited())) return json({ error: 'rate_limited' }, 429);
      const email = normEmail(b.email);
      const idx = await call(indexStub(env, 'email:' + (await sha(email))), 'index-get');
      if (idx.status !== 200 || !isB64(b.authKey, 43, 43)) return json({ error: 'wrong' }, 401); // same answer for "no such account"
      const r = await call(userStub(env, idx.data.uid), 'login', { authKey: b.authKey, label });
      return json(r.data, r.status);
    }
    case 'recover': {
      if (!(await limited())) return json({ error: 'rate_limited' }, 429);
      const idx = await call(indexStub(env, 'email:' + (await sha(normEmail(b.email)))), 'index-get');
      if (idx.status !== 200 || !isB64(b.recoveryAuth, 43, 43)) return json({ error: 'wrong' }, 401);
      if (b.step !== 'start' && (!isB64(b.newAuthKey, 43, 43) || !isB64(b.newWrapped, 40, 200))) return json({ error: 'bad_keys' }, 400);
      const r = await call(userStub(env, idx.data.uid), 'recover', { step: b.step, recoveryAuth: b.recoveryAuth, newAuthKey: b.newAuthKey, newWrapped: b.newWrapped, label });
      return json(r.data, r.status);
    }
    case 'invites': { // site owner only: make invite codes
      if (!(await isSiteOwner(request, env))) return json({ error: 'not_found' }, 404);
      const count = Math.min(Math.max(1, b.count | 0), 20);
      const quota = Math.min(Math.max(1, Number(b.quotaGb) || 5), 2048) * 1024 ** 3;
      const codes = [];
      for (let i = 0; i < count; i++) {
        const code = inviteCode();
        await call(indexStub(env, 'invite:' + (await sha(code))), 'index-claim', { value: { quota, created: Date.now(), exp: Date.now() + 30 * 864e5 } });
        codes.push(code);
      }
      return json({ codes, quotaGb: quota / 1024 ** 3, expiresInDays: 30 });
    }
    // ----- passkeys: challenge, register, sign in -----
    case 'passkey/challenge': {
      if (!(await limited())) return json({ error: 'rate_limited' }, 429);
      const challenge = rand(32);
      await call(indexStub(env, 'chal:' + challenge), 'index-claim', { value: { exp: Date.now() + 5 * 60e3 } });
      return json({ challenge });
    }
    case 'passkey/login': {
      if (!(await limited())) return json({ error: 'rate_limited' }, 429);
      const v = await verifyAssertion(request, env, url, b);
      if (v.error) return json({ error: v.error }, 401);
      const r = await call(userStub(env, v.uid), 'passkey-login', { id: b.id, counter: v.counter, label });
      return json(r.data, r.status);
    }
  }

  // Everything below needs a signed-in session.
  if (!who) return json({ error: 'signed_out' }, 401);
  const me = userStub(env, who.uid);
  switch (action) {
    case 'me': { const r = await call(me, 'account', { token: who.token }); return json(r.data, r.status); }
    case 'logout': { const r = await call(me, 'logout', { token: who.token }); return json(r.data, r.status); }
    case 'password': {
      if (!isB64(b.authKey, 43, 43) || !isB64(b.newAuthKey, 43, 43) || !isB64(b.newWrapped, 40, 200)) return json({ error: 'bad_keys' }, 400);
      const r = await call(me, 'password', { token: who.token, authKey: b.authKey, newAuthKey: b.newAuthKey, newWrapped: b.newWrapped, label });
      return json(r.data, r.status);
    }
    case 'delete': {
      const r = await call(me, 'delete-account', { token: who.token, authKey: b.authKey });
      if (r.status === 200) {
        await call(indexStub(env, 'email:' + (await sha(r.data.email))), 'index-drop');
        for (const id of r.data.passkeys) await call(indexStub(env, 'cred:' + id), 'index-drop');
      }
      return json({ ok: r.status === 200 }, r.status);
    }
    case 'prefs': { const r = await call(me, 'prefs', { token: who.token, blob: b.blob }); return json(r.data, r.status); }
    case 'passkey/register': {
      const v = await verifyRegistration(request, env, url, b);
      if (v.error) return json({ error: v.error }, 400);
      const claim = await call(indexStub(env, 'cred:' + b.id), 'index-claim', { value: { uid: who.uid } });
      if (claim.status === 409) return json({ error: 'exists' }, 409);
      const name = String(b.name || 'Passkey').replace(/[<>]/g, '').slice(0, 40);
      const r = await call(me, 'passkey-add', { token: who.token, passkey: { id: b.id, name, spki: b.spki, alg: b.alg, counter: v.counter, wrapped: b.wrapped } });
      if (r.status !== 200) await call(indexStub(env, 'cred:' + b.id), 'index-drop');
      return json(r.data, r.status);
    }
    case 'passkey/remove': {
      const r = await call(me, 'passkey-remove', { token: who.token, id: b.id });
      if (r.status === 200) await call(indexStub(env, 'cred:' + b.id), 'index-drop');
      return json(r.data, r.status);
    }
  }
  return json({ error: 'not_found' }, 404);
}

// /api/vault/*
export async function handleVault(request, env, url, parts) {
  const who = bearer(request);
  if (!who) return json({ error: 'signed_out' }, 401);
  const me = userStub(env, who.uid);
  const [, , what, id, n] = parts; // ['api','vault','files', id?, chunk?]
  if (what !== 'files') return json({ error: 'not_found' }, 404);

  if (!id && request.method === 'GET') { const r = await call(me, 'file-list', { token: who.token }); return json(r.data, r.status); }
  if (!id && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!Number.isSafeInteger(b.size) || b.size < 1 || !Number.isSafeInteger(b.chunks) || b.chunks < 1 || b.chunks > 100000 || b.size > b.chunks * CHUNK_MAX || !isB64(b.meta, 20, 4000)) return json({ error: 'bad_file' }, 400);
    const r = await call(me, 'file-new', { token: who.token, size: b.size, chunks: b.chunks, meta: b.meta });
    return json(r.data, r.status);
  }
  if (!/^[A-Za-z0-9_-]{16}$/.test(id || '')) return json({ error: 'not_found' }, 404);

  if (n === undefined) {
    if (request.method === 'PATCH') {
      const b = await request.json().catch(() => ({}));
      if (!isB64(b.meta, 20, 4000)) return json({ error: 'bad_meta' }, 400);
      const r = await call(me, 'file-meta', { token: who.token, id, meta: b.meta }); return json(r.data, r.status);
    }
    if (request.method === 'DELETE') { const r = await call(me, 'file-delete', { token: who.token, id }); return json(r.data, r.status); }
    return json({ error: 'not_found' }, 404);
  }
  if (n === 'done' && request.method === 'POST') {
    // Add up what is really in storage, so a file can't be "done" with parts missing.
    const b = await request.json().catch(() => ({}));
    let stored = 0;
    for (let i = 0; i < (b.chunks | 0) && i < 100000; i++) { const h = await env.BLOBS.head(chunkKey(who.uid, id, i)); if (!h) { stored = -1; break; } stored += h.size; }
    const r = await call(me, 'file-done', { token: who.token, id, stored });
    return json(r.data, r.status);
  }
  const idx = Number(n);
  if (!Number.isSafeInteger(idx) || idx < 0) return json({ error: 'not_found' }, 404);
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('content-length'));
    if (!request.headers.has('content-length') || !(len >= 28 && len <= CHUNK_MAX)) return json({ error: 'bad_chunk' }, 400);
    const ok = await call(me, 'file-chunk-ok', { token: who.token, id, n: idx });
    if (ok.status !== 200) return json(ok.data, ok.status);
    const body = typeof FixedLengthStream === 'function' ? (() => { const f = new FixedLengthStream(len); request.body.pipeTo(f.writable).catch(() => {}); return f.readable; })() : request.body;
    try { await env.BLOBS.put(chunkKey(who.uid, id, idx), body); } catch { return json({ error: 'upload_incomplete' }, 400); }
    return json({ ok: true });
  }
  if (request.method === 'GET') {
    const ok = await call(me, 'file-get', { token: who.token, id, n: idx });
    if (ok.status !== 200) return json(ok.data, ok.status);
    const obj = await env.BLOBS.get(chunkKey(who.uid, id, idx));
    if (!obj) return json({ error: 'missing' }, 410);
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
  }
  return json({ error: 'not_found' }, 404);
}

function inviteCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(r, (x) => A[x % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/* ===================== WebAuthn (passkeys) =====================
   We use the "none" attestation: the browser hands us the passkey's public key (SPKI) when it is
   created, in a signed-in session. Sign-in then has to prove possession of the private key by
   signing our one-time challenge, which we check here with Web Crypto. */

async function takeChallenge(env, challenge) {
  if (!isB64(challenge, 43, 43)) return false;
  const r = await call(indexStub(env, 'chal:' + challenge), 'index-take');
  return r.status === 200;
}

async function parseAuthData(b64, url) {
  const ad = b64urlToBytes(b64);
  if (ad.length < 37) return { error: 'bad_auth_data' };
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(url.hostname)));
  for (let i = 0; i < 32; i++) if (ad[i] !== rpHash[i]) return { error: 'bad_rp' };
  const flags = ad[32];
  if (!(flags & 0x01)) return { error: 'no_user_presence' };
  if (!(flags & 0x04)) return { error: 'no_user_verification' };
  const counter = new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0);
  return { ad, counter };
}

async function verifyRegistration(request, env, url, b) {
  if (!isB64(b.id, 16, 1400) || !isB64(b.spki, 60, 1200) || ![-7, -257].includes(b.alg) || !isB64(b.wrapped, 40, 200)) return { error: 'bad_passkey' };
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(b64urlToBytes(b.clientData))); } catch { return { error: 'bad_client_data' }; }
  if (cd.type !== 'webauthn.create' || cd.origin !== url.origin) return { error: 'bad_client_data' };
  if (!(await takeChallenge(env, cd.challenge))) return { error: 'bad_challenge' };
  const a = await parseAuthData(b.authData, url);
  if (a.error) return a;
  try { await importKey(b.spki, b.alg); } catch { return { error: 'bad_key' }; }
  return { counter: a.counter };
}

async function verifyAssertion(request, env, url, b) {
  if (!isB64(b.id, 16, 1400) || !isB64(b.clientData) || !isB64(b.authData) || !isB64(b.signature)) return { error: 'bad_passkey' };
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(b64urlToBytes(b.clientData))); } catch { return { error: 'bad_client_data' }; }
  if (cd.type !== 'webauthn.get' || cd.origin !== url.origin) return { error: 'bad_client_data' };
  if (!(await takeChallenge(env, cd.challenge))) return { error: 'bad_challenge' };
  const a = await parseAuthData(b.authData, url);
  if (a.error) return a;
  const idx = await call(indexStub(env, 'cred:' + b.id), 'index-get');
  if (idx.status !== 200) return { error: 'unknown_passkey' };
  const peek = await call(userStub(env, idx.data.uid), 'passkey-login', { id: b.id, peek: true });
  if (peek.status !== 200) return { error: 'unknown_passkey' };
  const key = await importKey(peek.data.spki, peek.data.alg);
  const signed = new Uint8Array([...a.ad, ...new Uint8Array(await crypto.subtle.digest('SHA-256', b64urlToBytes(b.clientData)))]);
  let sig = b64urlToBytes(b.signature);
  const algo = peek.data.alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  if (peek.data.alg === -7) sig = derToRaw(sig);
  const ok = await crypto.subtle.verify(algo, key, sig, signed);
  if (!ok) return { error: 'bad_signature' };
  return { uid: idx.data.uid, counter: a.counter };
}

function importKey(spkiB64, alg) {
  const spki = b64urlToBytes(spkiB64);
  return alg === -7
    ? crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    : crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

// WebAuthn ECDSA signatures are DER-encoded; Web Crypto wants raw r||s (32 bytes each).
function derToRaw(der) {
  if (der[0] !== 0x30) throw new Error('bad signature');
  let i = 2;
  const read = () => {
    if (der[i++] !== 0x02) throw new Error('bad signature');
    let len = der[i++]; let v = der.slice(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = read(), s = read();
  return new Uint8Array([...r, ...s]);
}
