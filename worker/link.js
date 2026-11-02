// One Durable Object per link. Every request for a link is handled by its object one at a
// time, so the attempt counter and the burn are atomic: two guesses can never land at once,
// and a burn link can never be opened twice.

const TOMBSTONE_MS = 7 * 24 * 3600e3; // keep "burned/revoked/expired" status for the sender's My links view
const blobKey = (id) => `p/${id}`;
const PAIR_TTL = 10 * 60e3;                  // a pairing must be completed within 10 minutes
const INBOX_MAX = 50;                         // waiting messages per device
const INBOX_MSG_MS = 7 * 24 * 3600e3;         // a message never waits longer than 7 days
const INBOX_IDLE_MS = 90 * 24 * 3600e3;       // an inbox nobody checks for 90 days is deleted
const pub = (m) => ({ id: m.id, msg: m.msg, at: m.at });

export class LinkDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // A device listening for its inbox. Hibernatable: idle sockets cost nothing and survive restarts.
    if (url.pathname === '/inbox-ws') return this.inboxSocket(request);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    // Run each request to completion before the next one starts. Without this, two opens could
    // interleave while one awaits hashing, and a burn link could be read twice.
    return this.state.blockConcurrencyWhile(() => this.route(url.pathname, body));
  }

  async route(path, body) {
    switch (path) {
      case '/init': return this.init(body);
      case '/meta': return this.meta();
      case '/open': return this.open(body);
      case '/revoke': return this.revoke(body);
      case '/status': return this.status(body);
      case '/remove': return this.remove(); // admin only; the Worker checks the admin token first
      // Typeable codes. A code record lives in its own object, named after the hash of the code's lookup value.
      case '/code-init': return this.codeInit(body);
      case '/code-get': return this.codeGet();
      case '/code-drop': return this.codeDrop();
      // Daily upload quota per network (see quota() in index.js). Two kinds of tiny short-lived records.
      // Device inboxes: paired devices drop encrypted messages ("open this link") for each other.
      case '/inbox-register': return this.inboxRegister(body);
      case '/inbox-drop': return this.inboxDrop(body);
      case '/inbox-list': return this.inboxList(body);
      case '/inbox-ack': return this.inboxAck(body);
      case '/pair': return this.pair(body);
      case '/salt': return this.salt(body);
      case '/quota': return this.quota(body);
      default: return json({ error: 'not_found' }, 404);
    }
  }

  async load() {
    const rec = await this.state.storage.get('rec');
    if (rec && rec.state === 'live' && Date.now() >= rec.expiresAt) {
      await this.kill(rec, 'expired');
    }
    return rec;
  }

  async save(rec) {
    await this.state.storage.put('rec', rec);
  }

  // Mark the link dead, delete its ciphertext, keep a small tombstone for a week.
  async kill(rec, why, { keepBlob = false } = {}) {
    rec.state = why;
    rec.endedAt = Date.now();
    rec.purgeAt = Date.now() + TOMBSTONE_MS;
    // Drop everything a dead link no longer needs.
    rec.salt = rec.iv = rec.iv2 = rec.verifier = null;
    await this.save(rec);
    if (!keepBlob) await this.env.BLOBS.delete(blobKey(rec.id));
    // keepBlob: the Worker deletes it right after reading; the alarm is a safety net.
    await this.state.storage.setAlarm(keepBlob ? Date.now() + 15 * 60e3 : rec.purgeAt); // time for a big download to finish
  }

  async init(b) {
    if (await this.state.storage.get('rec')) return json({ error: 'exists' }, 409);
    const rec = {
      id: b.id,
      state: 'live',
      createdAt: Date.now(),
      expiry: b.expiry,
      expiresAt: b.expiresAt,
      maxAttempts: b.maxAttempts || null,
      attemptsLeft: b.maxAttempts || null,
      salt: b.salt || null,
      iv: b.iv,
      iv2: b.iv2 || null,
      verifier: b.verifier || null,
      ownerHash: b.ownerHash,
      size: b.size,
      opens: 0,
    };
    await this.save(rec);
    await this.state.storage.setAlarm(rec.expiresAt);
    return json({ ok: true });
  }

  // What the recipient page learns before anything is decrypted.
  async meta() {
    const rec = await this.load();
    if (!rec) return json({ gone: true, reason: 'not_found' }, 404);
    if (rec.state !== 'live') return json({ gone: true, reason: rec.state }, 410);
    return json({
      gone: false,
      needsPassword: !!rec.verifier,
      salt: rec.salt,
      maxAttempts: rec.maxAttempts,
      attemptsLeft: rec.attemptsLeft,
      expiry: rec.expiry,
      expiresAt: rec.expiresAt,
    });
  }

  // Check the password token, count the attempt, release or destroy.
  async open(b) {
    const rec = await this.load();
    if (!rec) return json({ status: 'gone', reason: 'not_found' }, 404);
    if (rec.state !== 'live') return json({ status: 'gone', reason: rec.state }, 410);

    if (rec.verifier) {
      const given = typeof b.authToken === 'string' ? await sha256b64(b.authToken) : '';
      if (!safeEqual(given, rec.verifier)) {
        rec.attemptsLeft -= 1;
        if (rec.attemptsLeft <= 0) {
          await this.kill(rec, 'locked');
          return json({ status: 'locked' }, 410);
        }
        await this.save(rec);
        return json({ status: 'denied', attemptsLeft: rec.attemptsLeft }, 401);
      }
    }

    rec.opens += 1;
    const release = { status: 'ok', iv: rec.iv, iv2: rec.iv2, burned: rec.expiry === 'burn', expiresAt: rec.expiresAt };
    if (rec.expiry === 'burn') await this.kill(rec, 'burned', { keepBlob: true });
    else await this.save(rec);
    return json(release);
  }

  async revoke(b) {
    const rec = await this.load();
    if (!rec) return json({ error: 'not_found' }, 404);
    if (!(await this.isOwner(rec, b.ownerToken))) return json({ error: 'forbidden' }, 403);
    if (rec.state === 'live') await this.kill(rec, 'revoked');
    return json({ ok: true, state: rec.state });
  }

  // Taken down after an abuse report. Needs no key: we delete the ciphertext without reading it.
  async remove() {
    const rec = await this.load();
    if (!rec) return json({ ok: true, state: 'not_found' });
    if (rec.state === 'live') await this.kill(rec, 'removed');
    return json({ ok: true, state: rec.state });
  }

  // The sender's view in My links.
  async status(b) {
    const rec = await this.load();
    if (!rec) return json({ state: 'expired' });
    if (!(await this.isOwner(rec, b.ownerToken))) return json({ error: 'forbidden' }, 403);
    if (rec.state !== 'live') return json({ state: rec.state, opens: rec.opens, endedAt: rec.endedAt });
    return json({
      state: rec.opens > 0 ? 'opened' : 'waiting',
      opens: rec.opens,
      maxAttempts: rec.maxAttempts,
      attemptsLeft: rec.attemptsLeft,
      expiresAt: rec.expiresAt,
    });
  }

  // A code record holds only: which link, the link key wrapped with a key derived from the code, and when it dies.
  async codeInit(b) {
    const old = await this.state.storage.get('code');
    if (old && Date.now() < old.expiresAt) return json({ error: 'exists' }, 409);
    const code = { linkId: b.linkId, wrapped: b.wrapped, wrapIv: b.wrapIv, expiresAt: b.expiresAt };
    await this.state.storage.put('code', code);
    await this.state.storage.setAlarm(code.expiresAt);
    return json({ ok: true });
  }

  async codeGet() {
    const code = await this.state.storage.get('code');
    if (!code || Date.now() >= code.expiresAt) {
      if (code) await this.state.storage.deleteAll();
      return json({ error: 'not_found' }, 404);
    }
    return json({ linkId: code.linkId, wrapped: code.wrapped, wrapIv: code.wrapIv });
  }

  async codeDrop() {
    await this.state.storage.deleteAll();
    return json({ ok: true });
  }

  // A random value for one day. Network addresses are hashed with it, and it is deleted after the day,
  // so the hashes can no longer be linked back to any address.
  async salt(b) {
    let s = await this.state.storage.get('salt');
    if (!s) {
      s = { value: bytesToB64url(crypto.getRandomValues(new Uint8Array(32))), deleteAt: b.deleteAt };
      await this.state.storage.put('salt', s);
      await this.state.storage.setAlarm(s.deleteAt);
    }
    return json({ value: s.value });
  }

  // Bytes uploaded today from one (hashed) network. Reserve before the upload, refund if it fails.
  async quota(b) {
    const q = (await this.state.storage.get('quota')) || { used: 0, deleteAt: b.deleteAt };
    if (b.refund) q.used = Math.max(0, q.used - b.bytes);
    else if (q.used + b.bytes > b.limit) return json({ ok: false, used: q.used });
    else q.used += b.bytes;
    await this.state.storage.put('quota', q);
    await this.state.storage.setAlarm(q.deleteAt);
    return json({ ok: true, used: q.used });
  }

  /* ---------- pairing: two devices swap encrypted name cards through a short-lived slot ---------- */
  async pair(b) {
    const p = await this.state.storage.get('pair');
    if (b.role === 'a') {
      if (!p) {
        if (!b.card) return json({ error: 'not_found' }, 404);
        await this.state.storage.put('pair', { a: b.card, b: null, deleteAt: Date.now() + PAIR_TTL });
        await this.state.storage.setAlarm(Date.now() + PAIR_TTL);
        return json({ other: null });
      }
      if (b.card && p.a !== b.card) return json({ error: 'exists' }, 409);
      return json({ other: p.b });
    }
    if (!p || Date.now() >= p.deleteAt) return json({ error: 'not_found' }, 404);
    if (p.b && p.b !== b.card) return json({ error: 'taken' }, 409); // only one device can join a pairing
    p.b = b.card;
    await this.state.storage.put('pair', p);
    return json({ other: p.a });
  }

  /* ---------- inbox ---------- */
  async inboxRegister(b) {
    const inbox = await this.state.storage.get('inbox');
    const tokenHash = await sha256b64(b.token);
    if (inbox && !safeEqual(tokenHash, inbox.tokenHash)) return json({ error: 'taken' }, 409);
    const rec = { tokenHash, deleteAt: Date.now() + INBOX_IDLE_MS };
    await this.state.storage.put('inbox', rec);
    await this.scheduleInbox();
    return json({ ok: true });
  }

  async authed(b) {
    const inbox = await this.state.storage.get('inbox');
    return inbox && typeof b.token === 'string' && safeEqual(await sha256b64(b.token), inbox.tokenHash) ? inbox : null;
  }

  async messages() {
    const all = await this.state.storage.list({ prefix: 'm:' });
    const now = Date.now(), live = [], dead = [];
    for (const [k, m] of all) (m.expiresAt > now ? live : dead).push(k === m.key ? m : { ...m, key: k });
    if (dead.length) await this.state.storage.delete(dead.map((m) => m.key));
    return live.sort((x, y) => x.at - y.at);
  }

  async inboxDrop(b) {
    if (!(await this.state.storage.get('inbox'))) return json({ error: 'not_found' }, 404);
    const live = await this.messages();
    if (live.length >= INBOX_MAX) return json({ error: 'inbox_full' }, 429);
    const at = Date.now();
    const m = { key: '', id: bytesToB64url(crypto.getRandomValues(new Uint8Array(9))), msg: b.msg, at, expiresAt: Math.min(b.expiresAt || at + INBOX_MSG_MS, at + INBOX_MSG_MS) };
    m.key = 'm:' + m.id;
    await this.state.storage.put(m.key, m);
    await this.scheduleInbox();
    // Push it to every signed-in listener right away.
    for (const ws of this.state.getWebSockets?.() || []) {
      if (ws.deserializeAttachment?.()?.authed) { try { ws.send(JSON.stringify({ type: 'msg', message: pub(m) })); } catch {} }
    }
    return json({ ok: true }, 202);
  }

  async inboxList(b) {
    const inbox = await this.authed(b);
    if (!inbox) return json({ error: 'forbidden' }, 403);
    inbox.deleteAt = Date.now() + INBOX_IDLE_MS; // an inbox that is used stays alive
    await this.state.storage.put('inbox', inbox);
    return json({ messages: (await this.messages()).map(pub) });
  }

  async inboxAck(b) {
    if (!(await this.authed(b))) return json({ error: 'forbidden' }, 403);
    const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, INBOX_MAX) : [];
    if (ids.length) await this.state.storage.delete(ids.map((id) => 'm:' + id));
    return json({ ok: true });
  }

  async scheduleInbox() {
    const inbox = await this.state.storage.get('inbox');
    if (!inbox) return;
    const next = Math.min(inbox.deleteAt, ...(await this.messages()).map((m) => m.expiresAt));
    await this.state.storage.setAlarm(next);
  }

  // WebSocket: the client connects, then sends { type: 'auth', token } as its first message.
  async inboxSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket' || typeof WebSocketPair !== 'function') return new Response('Expected a WebSocket', { status: 426 });
    if ((this.state.getWebSockets?.() || []).length >= 20) return new Response('Too many listeners', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return ws.close(1003, 'bad message'); }
    if (m.type === 'auth') {
      if (await this.authed({ token: m.token })) { ws.serializeAttachment({ authed: true }); ws.send(JSON.stringify({ type: 'ready' })); }
      else ws.close(1008, 'unauthorized');
    } else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  }

  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch {} }

  async isOwner(rec, token) {
    if (typeof token !== 'string' || !token) return false;
    return safeEqual(await sha256b64(token), rec.ownerHash);
  }

  async alarm() {
    return this.state.blockConcurrencyWhile(() => this.runAlarm());
  }

  async runAlarm() {
    if (await this.state.storage.get('inbox')) {
      const inbox = await this.state.storage.get('inbox');
      if (Date.now() >= inbox.deleteAt) { await this.state.storage.deleteAll(); return; }
      await this.messages(); // drops expired ones
      await this.scheduleInbox();
      return;
    }
    const tmp = (await this.state.storage.get('salt')) || (await this.state.storage.get('quota')) || (await this.state.storage.get('pair'));
    if (tmp) {
      if (Date.now() >= tmp.deleteAt) await this.state.storage.deleteAll();
      else await this.state.storage.setAlarm(tmp.deleteAt);
      return;
    }
    const code = await this.state.storage.get('code');
    if (code) {
      if (Date.now() >= code.expiresAt) await this.state.storage.deleteAll();
      else await this.state.storage.setAlarm(code.expiresAt);
      return;
    }
    const rec = await this.state.storage.get('rec');
    if (!rec) return;
    if (rec.state === 'live') {
      if (Date.now() >= rec.expiresAt) await this.kill(rec, 'expired');
      else await this.state.storage.setAlarm(rec.expiresAt);
      return;
    }
    // Dead link: make sure the ciphertext is gone, then drop the tombstone when it is due.
    await this.env.BLOBS.delete(blobKey(rec.id));
    if (Date.now() >= rec.purgeAt) await this.state.storage.deleteAll();
    else await this.state.storage.setAlarm(rec.purgeAt);
  }
}

export async function sha256b64(text) {
  const bytes = b64urlToBytes(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToB64url(new Uint8Array(digest));
}

// Constant-time comparison of two short strings.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  const pad = '==='.slice((s.length + 3) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
