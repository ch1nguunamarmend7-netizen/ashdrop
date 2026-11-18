// Live transfer ("send in parts"): for files too big for a normal link.
//
// The sender's browser cuts the file into 8 MiB pieces and encrypts each one. The server is only a relay:
// it holds at most WINDOW pieces at a time. As soon as the receiver has a piece, it is deleted, and the
// sender may upload the next one. So a 5 GB file never sits on the server; at most ~24 MB of it, encrypted.
// Both browsers must be open at the same time. The key travels in the link's # fragment, as with links.
//
// One Durable Object per transfer (named "stream:<id>") keeps the counters, so uploads, downloads and
// acknowledgements never race. Pieces live in R2 under s/<id>/<n> only while in flight.

import { json, sha256b64, safeEqual, bytesToB64url } from './link.js';
import { countStat } from './vault.js';

export const CHUNK = 8 * 1024 * 1024;      // plaintext bytes per piece
const CHUNK_MAX = CHUNK + 12 + 16;         // + IV + GCM tag
export const LIVE_MAX = 5 * 1024 ** 3;     // 5 GB per transfer
const WINDOW = 3;                          // pieces the server may hold at once
const IDLE_MS = 10 * 60e3;                 // nobody moved for 10 minutes: give up and delete
const MAX_AGE_MS = 12 * 3600e3;            // no transfer runs longer than 12 hours
const KEEP_MS = 3600e3;                    // a finished or cancelled transfer keeps its status for an hour
const ID_RE = /^[a-hjkmnp-z2-9]{10}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const pieceKey = (id, n) => `s/${id}/${n}`;
const rand = (n) => bytesToB64url(crypto.getRandomValues(new Uint8Array(n)));

/* ===================== the Durable Object side ===================== */

export async function streamRoute(obj, b) {
  const s = obj.state.storage;
  let st = await s.get('stream');
  const now = Date.now();
  const save = async () => { st.touchedAt = now; await s.put('stream', st); };
  const TOKEN = /^[A-Za-z0-9_-]{43}$/; // anything else is not a token (and must not reach the decoder)
  if (b.token !== undefined && !(typeof b.token === 'string' && TOKEN.test(b.token)) && b.op !== 'init') b.token = undefined;
  const isSender = async () => !!st && typeof b.token === 'string' && safeEqual(await sha256b64(b.token), st.senderHash);
  const isRecv = async () => !!st && !!st.recvHash && typeof b.token === 'string' && safeEqual(await sha256b64(b.token), st.recvHash);
  const view = () => ({ state: st.state, size: st.size, chunks: st.chunks, uploaded: st.uploaded, acked: st.acked, claimed: !!st.recvHash,
    senderAgo: now - st.senderSeen, recvAgo: st.recvSeen ? now - st.recvSeen : null });

  if (b.op === 'init') {
    if (st) return json({ error: 'exists' }, 409);
    st = { id: b.id, size: b.size, chunks: b.chunks, hdr: b.hdr, senderHash: await sha256b64(b.token), recvHash: null,
      uploaded: 0, acked: 0, state: 'waiting', createdAt: now, senderSeen: now, recvSeen: 0 };
    await save();
    await s.setAlarm(now + 60e3);
    return json({ ok: true });
  }
  if (!st) return json({ error: 'not_found' }, 404);
  const ended = st.state === 'done' || st.state === 'cancelled';

  switch (b.op) {
    case 'meta': // anyone with the link: what is coming (the header is encrypted), and how far along it is
      return json({ ...view(), hdr: st.hdr });
    case 'claim': { // one receiver only, like a burn link
      if (ended) return json({ error: st.state }, 410);
      if (st.recvHash) return json({ error: 'claimed' }, 409);
      const token = rand(32);
      st.recvHash = await sha256b64(token); st.recvSeen = now;
      if (st.state === 'waiting') st.state = 'sending';
      await save();
      return json({ token });
    }
    case 'status': // the sender polls this while it waits
      if (!(await isSender())) return json({ error: 'forbidden' }, 403);
      st.senderSeen = now; await save();
      return json(view());
    case 'put-ok': { // may the sender upload piece n now?
      if (!(await isSender())) return json({ error: 'forbidden' }, 403);
      st.senderSeen = now;
      if (ended) { await save(); return json({ error: st.state }, 410); }
      const n = b.n;
      if (!Number.isSafeInteger(n) || n < 0 || n >= st.chunks) { await save(); return json({ error: 'bad_piece' }, 400); }
      if (n < st.uploaded) { await save(); return json({ error: 'already', uploaded: st.uploaded }, 409); }
      if (n > st.uploaded) { await save(); return json({ error: 'out_of_order', uploaded: st.uploaded }, 409); }
      if (n - st.acked >= WINDOW) { await save(); return json({ error: 'wait', acked: st.acked, claimed: !!st.recvHash }, 429); }
      await save();
      return json({ ok: true });
    }
    case 'put-done': {
      if (!(await isSender())) return json({ error: 'forbidden' }, 403);
      st.senderSeen = now;
      if (b.n === st.uploaded && !ended) st.uploaded = b.n + 1;
      await save();
      return json(view());
    }
    case 'get-ok': { // may the receiver download piece n?
      if (!(await isRecv())) return json({ error: 'forbidden' }, 403);
      st.recvSeen = now;
      await save();
      if (st.state === 'cancelled') return json({ error: 'cancelled' }, 410);
      if (b.n !== st.acked) return json({ error: 'wrong_piece', acked: st.acked }, 409);
      if (b.n >= st.uploaded) return json({ error: 'not_yet', senderAgo: now - st.senderSeen }, 425);
      return json({ ok: true });
    }
    case 'ack': { // the receiver has piece n: delete it, and let the sender send the next one
      if (!(await isRecv())) return json({ error: 'forbidden' }, 403);
      st.recvSeen = now;
      if (b.n === st.acked && b.n < st.uploaded) {
        await obj.env.BLOBS.delete(pieceKey(st.id, b.n));
        st.acked++;
        if (st.acked === st.chunks) { st.state = 'done'; st.endedAt = now; await countStat(obj.env, 'live_done'); }
      }
      await save();
      return json(view());
    }
    case 'cancel': {
      if (!(await isSender()) && !(await isRecv())) return json({ error: 'forbidden' }, 403);
      if (!ended) await cancel(obj, st, now);
      return json(view());
    }
  }
  return json({ error: 'not_found' }, 404);
}

async function cancel(obj, st, now) {
  const keys = [];
  for (let n = st.acked; n < st.uploaded; n++) keys.push(pieceKey(st.id, n));
  if (keys.length) await obj.env.BLOBS.delete(keys);
  st.state = 'cancelled'; st.endedAt = now; st.touchedAt = now;
  await obj.state.storage.put('stream', st);
}

/** Called from LinkDO.alarm when the object holds a transfer. */
export async function streamAlarm(obj, st) {
  const now = Date.now();
  if (st.state === 'done' || st.state === 'cancelled') {
    if (now - (st.endedAt || now) >= KEEP_MS) { await obj.state.storage.deleteAll(); return; }
  } else if (now - st.touchedAt >= IDLE_MS || now - st.createdAt >= MAX_AGE_MS) {
    await cancel(obj, st, now);
  }
  await obj.state.storage.setAlarm(now + 60e3);
}

/* ===================== the HTTP side: /api/s/... ===================== */

const bearer = (request) => { const h = request.headers.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');

export async function handleStream(request, env, parts, { allowed, ctx }) {
  const stubFor = (id) => env.LINKS.get(env.LINKS.idFromName('stream:' + id));
  const op = async (id, body) => {
    const r = await stubFor(id).fetch('https://link/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const out = (r) => json(r.data, r.status);
  const [, , id, n, action] = parts; // ['api','s', id?, n|'claim'|'status', 'ack'?]

  // POST /api/s { size, chunks, hdr }: start a transfer
  if (!id && request.method === 'POST') {
    if (!(await allowed(env.CREATE_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
    const b = await request.json().catch(() => ({}));
    if (!Number.isSafeInteger(b.size) || b.size < 1 || b.size > LIVE_MAX) return json({ error: 'too_big', max: LIVE_MAX }, 413);
    if (b.chunks !== Math.ceil(b.size / CHUNK)) return json({ error: 'bad_chunks' }, 400);
    if (typeof b.hdr !== 'string' || b.hdr.length > 20000 || !B64.test(b.hdr)) return json({ error: 'bad_header' }, 400);
    const sid = newId(), token = rand(32);
    const r = await op(sid, { op: 'init', id: sid, size: b.size, chunks: b.chunks, hdr: b.hdr, token });
    if (r.status !== 200) return out(r);
    const counted = countStat(env, 'live_created'); ctx?.waitUntil?.(counted);
    return json({ id: sid, token, chunk: CHUNK, window: WINDOW }, 201);
  }
  if (!ID_RE.test(id || '')) return json({ error: 'not_found' }, 404);
  const token = bearer(request);

  if (n === undefined && request.method === 'GET') return out(await op(id, { op: 'meta' }));
  if (n === undefined && request.method === 'DELETE') return out(await op(id, { op: 'cancel', token }));
  if (n === 'claim' && request.method === 'POST') {
    if (!(await allowed(env.OPEN_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
    return out(await op(id, { op: 'claim' }));
  }
  if (n === 'status' && request.method === 'GET') return out(await op(id, { op: 'status', token }));

  const idx = Number(n);
  if (!/^\d{1,6}$/.test(n || '') || !Number.isSafeInteger(idx)) return json({ error: 'not_found' }, 404);

  if (action === 'ack' && request.method === 'POST') return out(await op(id, { op: 'ack', token, n: idx }));
  if (action) return json({ error: 'not_found' }, 404);

  if (request.method === 'PUT') { // the sender uploads piece n
    const len = Number(request.headers.get('content-length'));
    if (!request.headers.has('content-length') || !(len >= 29 && len <= CHUNK_MAX)) return json({ error: 'bad_piece' }, 400);
    const ok = await op(id, { op: 'put-ok', token, n: idx });
    if (ok.status !== 200) return out(ok);
    let body = request.body;
    if (typeof FixedLengthStream === 'function') { const f = new FixedLengthStream(len); request.body.pipeTo(f.writable).catch(() => {}); body = f.readable; }
    try { await env.BLOBS.put(pieceKey(id, idx), body); } catch { return json({ error: 'upload_incomplete' }, 400); }
    return out(await op(id, { op: 'put-done', token, n: idx }));
  }
  if (request.method === 'GET') { // the receiver downloads piece n
    const ok = await op(id, { op: 'get-ok', token, n: idx });
    // Not uploaded yet is normal while the sender catches up: answer "nothing yet" rather than an error.
    if (ok.status === 425) return new Response(null, { status: 204, headers: { 'x-ashdrop-sender-ago': String(ok.data.senderAgo || 0) } });
    if (ok.status !== 200) return out(ok);
    const obj = await env.BLOBS.get(pieceKey(id, idx));
    if (!obj) return json({ error: 'missing' }, 410);
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
  }
  return json({ error: 'not_found' }, 404);
}
