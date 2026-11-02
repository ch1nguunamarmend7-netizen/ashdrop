// Your devices: pair them once, then send a link to one with a single tap.
//
// Each browser gets a device identity, kept in this browser's localStorage:
//   inboxId    random 16 bytes; paired devices drop messages here
//   token      random 32 bytes; proves to the server that this browser may read that inbox
//   key pair   ECDH P-256; paired devices encrypt messages to the public key
// Pairing: one device shows 4 words (or a QR code with them). Both devices stretch the words with
// PBKDF2 and swap name cards (name, inbox id, public key) encrypted with the result, through a slot
// on the server that dies after 10 minutes. The server never sees the words, the cards or the keys.
// Sending: the link id and key go into a message encrypted to the other device's public key with a
// fresh ephemeral key (ECDH + AES-GCM). The server stores it until the device picks it up, and pushes
// it right away when that device is online.

import { enc, b64url, b64urlDecode } from './crypto.js';
import { generateCode } from './code.js';

const DEVICE = 'ashdrop.device';
const PEERS = 'ashdrop.peers';
const dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux computer' : 'Device';
  return os;
}

/** This browser's device identity, created on first use. Registers its inbox with the server. */
export async function getDevice() {
  let d = load(DEVICE, null);
  if (!d) {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    d = {
      inboxId: b64url(crypto.getRandomValues(new Uint8Array(16))),
      token: b64url(crypto.getRandomValues(new Uint8Array(32))),
      name: defaultDeviceName(),
      pub: await crypto.subtle.exportKey('jwk', kp.publicKey),
      priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    };
    save(DEVICE, d);
  }
  return d;
}

export const hasDevice = () => !!load(DEVICE, null);
export const renameDevice = (name) => { const d = load(DEVICE, null); if (d) save(DEVICE, { ...d, name: name.slice(0, 40) }); };
export const getPeers = () => load(PEERS, []);
export const removePeer = (inboxId) => save(PEERS, getPeers().filter((p) => p.inboxId !== inboxId));
const addPeer = (card) => {
  const peer = { inboxId: card.inboxId, name: String(card.name || 'Device').slice(0, 40), pub: card.pub, addedAt: Date.now() };
  save(PEERS, [peer, ...getPeers().filter((p) => p.inboxId !== peer.inboxId)]);
  return peer;
};

/** Forget this device completely (its inbox stops being read and is deleted by the server after 90 days). */
export function resetDevice() { try { localStorage.removeItem(DEVICE); localStorage.removeItem(PEERS); } catch {} }

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Tell the server this inbox exists (and keep it alive). */
export async function registerDevice() {
  const d = await getDevice();
  const r = await postJson('/api/inbox/register', { inboxId: d.inboxId, token: d.token });
  if (r.status === 409) { resetDevice(); return registerDevice(); } // id collision: start over with a new one
  return d;
}

/* ---------- pairing ---------- */

async function pairKeys(words) {
  const base = await crypto.subtle.importKey('raw', enc.encode(words), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('ashdrop/pair/v1'), iterations: 310000, hash: 'SHA-256' }, base, 256);
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(s) });
  return {
    lookup: b64url(await crypto.subtle.deriveBits(info('ashdrop/v1/pair-lookup'), hk, 256)),
    key: await crypto.subtle.deriveKey(info('ashdrop/v1/pair-card'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
}

async function sealCard(key, d) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ name: d.name, inboxId: d.inboxId, pub: d.pub })));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64url(out);
}
async function openCard(key, card) {
  const bytes = b64urlDecode(card);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  const c = JSON.parse(dec.decode(plain));
  if (!/^[A-Za-z0-9_-]{22}$/.test(c.inboxId) || c.pub?.kty !== 'EC') throw new Error('Not a valid device card');
  return c;
}

/** Device A: start a pairing. Returns the words to show and wait() which resolves with the new peer. */
export async function startPairing({ signal } = {}) {
  const d = await registerDevice();
  const words = generateCode();
  const { lookup, key } = await pairKeys(words);
  const first = await postJson('/api/pair', { lookup, role: 'a', card: await sealCard(key, d) });
  if (first.status !== 200) throw new Error(first.status === 429 ? 'Too many tries. Wait a minute.' : 'Could not start pairing.');
  const wait = async () => {
    const until = Date.now() + 10 * 60e3;
    while (Date.now() < until) {
      if (signal?.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, 2000));
      const r = await postJson('/api/pair', { lookup, role: 'a' }).catch(() => null);
      if (r?.status === 200 && r.data.other) {
        const card = await openCard(key, r.data.other);
        if (card.inboxId === d.inboxId) continue;
        return addPeer(card);
      }
    }
    throw new Error('expired');
  };
  return { words, wait };
}

/** Device B: join with the words shown on device A. Returns the new peer. */
export async function joinPairing(words) {
  const d = await registerDevice();
  const { lookup, key } = await pairKeys(words);
  const r = await postJson('/api/pair', { lookup, role: 'b', card: await sealCard(key, d) });
  if (r.status === 404) throw new Error('No device is waiting with those words. They may have expired; start pairing again.');
  if (r.status === 409) throw new Error('Another device already used these words. Start pairing again.');
  if (r.status === 429) throw new Error('Too many tries. Wait a minute.');
  if (r.status !== 200) throw new Error('Could not pair.');
  const card = await openCard(key, r.data.other);
  if (card.inboxId === d.inboxId) throw new Error('That is this same device.');
  return addPeer(card);
}

/* ---------- sending and receiving ---------- */

async function sharedKey(privJwk, pubJwk, usage) {
  const priv = await crypto.subtle.importKey('jwk', privJwk, ECDH, false, ['deriveKey']);
  const pub = await crypto.subtle.importKey('jwk', { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Send { id, keyStr, label, kind, expiry, expiresAt } to a paired device. */
export async function sendToPeer(peer, item) {
  const d = await getDevice();
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const ephPriv = await crypto.subtle.exportKey('jwk', eph.privateKey);
  const key = await sharedKey(ephPriv, peer.pub, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = { v: 1, from: d.inboxId, fromName: d.name, sentAt: Date.now(), ...item };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(body)));
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  const msg = b64url(enc.encode(JSON.stringify({ epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, iv: b64url(iv), ct: b64url(ct) })));
  const r = await postJson('/api/inbox/drop', { inboxId: peer.inboxId, msg, expiresAt: item.expiresAt });
  if (r.status === 404) throw new Error(`${peer.name} has not been online since pairing.`);
  if (r.status === 429) throw new Error(r.data.error === 'inbox_full' ? `${peer.name} has too many unopened items.` : 'Too many sends. Wait a minute.');
  if (r.status !== 202) throw new Error('Could not send.');
}

/** Decrypt one inbox message. Returns null for anything not from a paired device. */
export async function openMessage(m) {
  try {
    const d = await getDevice();
    const { epk, iv, ct } = JSON.parse(dec.decode(b64urlDecode(m.msg)));
    const key = await sharedKey(d.priv, epk, 'decrypt');
    const body = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, key, b64urlDecode(ct))));
    const peer = getPeers().find((p) => p.inboxId === body.from);
    if (!peer || !/^[a-z2-9]{10}$/.test(body.id) || typeof body.keyStr !== 'string') return null;
    return { ...body, msgId: m.id, fromName: peer.name };
  } catch { return null; }
}

export async function listInbox() {
  const d = await getDevice();
  const r = await postJson('/api/inbox/list', { inboxId: d.inboxId, token: d.token });
  return r.status === 200 ? r.data.messages : [];
}

export async function ackInbox(ids) {
  if (!ids.length) return;
  const d = await getDevice();
  await postJson('/api/inbox/ack', { inboxId: d.inboxId, token: d.token, ids }).catch(() => {});
}

/** Listen for new items: a live WebSocket, plus a check on focus and every 30 s as a fallback.
    onItems receives decrypted items; anything that cannot be opened is removed. Returns stop(). */
export function listenInbox(onItems) {
  let ws = null, stopped = false, retry = 1000, timer = null;
  const seen = new Set();
  const handle = async (messages) => {
    const items = [], junk = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const item = await openMessage(m);
      if (item) items.push(item); else junk.push(m.id);
    }
    ackInbox(junk);
    if (items.length) onItems(items);
  };
  const check = () => { if (!stopped && document.visibilityState !== 'hidden') listInbox().then(handle).catch(() => {}); };
  const connect = async () => {
    if (stopped || typeof WebSocket !== 'function') return;
    const d = await getDevice();
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/inbox/ws?inbox=${d.inboxId}`); } catch { return; }
    ws.onopen = () => { retry = 1000; ws.send(JSON.stringify({ type: 'auth', token: d.token })); };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'msg') handle([m.message]); if (m.type === 'ready') check(); } catch {} };
    ws.onclose = () => { ws = null; if (!stopped) { setTimeout(connect, retry); retry = Math.min(retry * 2, 60000); } };
  };
  registerDevice().then(() => { check(); connect(); }).catch(() => {});
  const onVis = () => check();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', onVis);
  timer = setInterval(() => { if (!ws || ws.readyState !== 1) check(); }, 30000); // only needed when the live socket is down
  return () => {
    stopped = true; clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis);
    try { ws?.close(); } catch {}
  };
}
