// Where "My links" lives on this device.
//
// Each saved link contains its decryption key and owner token, so anyone who opens this browser
// could open or revoke it. With the passcode lock on, every link is encrypted before it is
// written to localStorage:
//
//   - A P-256 key pair is made once. The public key is stored as-is; the private key is
//     encrypted with a key derived from your passcode (PBKDF2-SHA256, 310,000 rounds).
//   - Each link is sealed to the public key (ephemeral ECDH + HKDF + AES-256-GCM), so new links
//     can be saved while My links is locked, and only the passcode can open them again.
//
// The passcode never leaves the device and cannot be recovered.

import { enc, b64url, b64urlDecode } from './crypto.js';

const K_PLAIN = 'ashdrop.links';
const K_SEALED = 'ashdrop.links.sealed';
const K_LOCK = 'ashdrop.linklock';
const KEEP_MS = 8 * 864e5; // the longest a link can live, plus a day
const MAX = 50;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const read = (k, fallback) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const drop = (k) => { try { localStorage.removeItem(k); } catch {} };
const fresh = (t) => Date.now() - t < KEEP_MS;

export const hasLock = () => !!read(K_LOCK, null);
export const loadPlain = () => read(K_PLAIN, []).filter((l) => fresh(l.createdAt));
export const savePlain = (list) => write(K_PLAIN, list.slice(0, MAX));
export const sealedCount = () => read(K_SEALED, []).filter((s) => fresh(s.t)).length;

async function passKey(passcode, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wrapPrivate(privJwk, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passcode, salt), enc.encode(JSON.stringify(privJwk)));
  return { salt: b64url(salt), iv: b64url(iv), ct: b64url(ct) };
}

async function sharedKey(priv, pub, usage) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('ashdrop/v1/links') }, hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

async function sealOne(pubJwk, record) {
  const pub = await crypto.subtle.importKey('jwk', pubJwk, ECDH, false, []);
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const key = await sharedKey(eph.privateKey, pub, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(record)));
  const epk = await crypto.subtle.exportKey('raw', eph.publicKey);
  // `t` (when it was sent) stays readable so old entries can be pruned without the passcode.
  return { t: record.createdAt, epk: b64url(epk), iv: b64url(iv), ct: b64url(ct) };
}

async function openOne(priv, s) {
  const epk = await crypto.subtle.importKey('raw', b64urlDecode(s.epk), ECDH, false, []);
  const key = await sharedKey(priv, epk, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(s.iv) }, key, b64urlDecode(s.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Save a new link. Works while locked. */
export async function addLink(record) {
  const lock = read(K_LOCK, null);
  if (!lock) { savePlain([record, ...loadPlain()]); return; }
  const sealed = read(K_SEALED, []).filter((s) => fresh(s.t));
  write(K_SEALED, [await sealOne(lock.pub, record), ...sealed].slice(0, MAX));
}

/** Turn the lock on, moving any plain links into the sealed store. */
export async function createLock(passcode, existing = loadPlain()) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const sealed = [];
  for (const r of existing) sealed.push(await sealOne(pub, r));
  write(K_LOCK, { v: 1, pub, wrapped: await wrapPrivate(privJwk, passcode) });
  write(K_SEALED, sealed.slice(0, MAX));
  drop(K_PLAIN);
  return { priv: pair.privateKey, privJwk, records: existing };
}

/** Unlock with the passcode. Throws Error('wrong_passcode') on a bad passcode. */
export async function unlock(passcode) {
  const lock = read(K_LOCK, null);
  if (!lock) throw new Error('no_lock');
  const { salt, iv, ct } = lock.wrapped;
  let privJwk;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, await passKey(passcode, b64urlDecode(salt)), b64urlDecode(ct));
    privJwk = JSON.parse(new TextDecoder().decode(pt));
  } catch { throw new Error('wrong_passcode'); }
  const priv = await crypto.subtle.importKey('jwk', privJwk, ECDH, false, ['deriveBits']);
  return { priv, privJwk, records: await openAll(priv) };
}

/** Decrypt every saved link with an unlocked private key. Newest first. */
export async function openAll(priv) {
  const sealed = read(K_SEALED, []).filter((s) => fresh(s.t));
  const out = [];
  for (const s of sealed) { try { out.push(await openOne(priv, s)); } catch { /* skip damaged entries */ } }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Turn the lock off: keep the links, stored readable on this device. */
export async function removeLock(priv) {
  savePlain(await openAll(priv));
  drop(K_SEALED);
  drop(K_LOCK);
}

/** Change the passcode without re-encrypting the links. */
export async function changePasscode(privJwk, newPasscode) {
  const lock = read(K_LOCK, null);
  if (!lock) throw new Error('no_lock');
  write(K_LOCK, { ...lock, wrapped: await wrapPrivate(privJwk, newPasscode) });
}

/** Forgot the passcode: the saved links cannot be read, so delete them. The links themselves keep working. */
export function forgetAll() {
  drop(K_SEALED);
  drop(K_LOCK);
  drop(K_PLAIN);
}
