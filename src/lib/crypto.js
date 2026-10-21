// All encryption happens here, in the browser. Nothing in this file talks to the network.

export const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const b64urlDecode = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const hex = (buf, n = 32) => Array.from(new Uint8Array(buf).slice(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
export const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

/* The file name, type and text format travel inside the ciphertext, so the server
   learns nothing but a size. Layout: [4-byte header length][JSON header][content]. */
export function pack(header, content) {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + content.byteLength);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(new Uint8Array(content), 4 + h.length);
  return out;
}
export function unpack(buf) {
  const bytes = new Uint8Array(buf);
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  if (len > 64 * 1024 || 4 + len > bytes.length) throw new Error('Unrecognized payload');
  const header = JSON.parse(dec.decode(bytes.subarray(4, 4 + len)));
  return { header, content: bytes.subarray(4 + len) };
}

/* One password gives two unrelated keys. The encryption key never leaves the browser;
   the auth token is what the server checks before it releases any ciphertext. */
export async function derivePasswordKeys(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, 256);
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(s) });
  const pwKey = await crypto.subtle.deriveKey(info('ashdrop/v1/enc'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const token = await crypto.subtle.deriveBits(info('ashdrop/v1/auth'), hk, 256);
  return { pwKey, token };
}

export async function sealPayload(bytes, password) {
  const t0 = performance.now();
  const log = [];
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', key);
  log.push(['Generated 256-bit key', `${(performance.now() - t0).toFixed(1)} ms`]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  log.push(['AES-256-GCM encrypt (layer 1)', fmtBytes(ct.byteLength)]);
  let salt = null, iv2 = null, authToken = null;
  if (password) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    iv2 = crypto.getRandomValues(new Uint8Array(12));
    const { pwKey, token } = await derivePasswordKeys(password, salt);
    authToken = token;
    log.push(['PBKDF2-SHA256 · 310,000 rounds → HKDF', 'enc key + auth token']);
    ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, pwKey, ct);
    log.push(['AES-256-GCM encrypt (password layer)', fmtBytes(ct.byteLength)]);
    const inner = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, pwKey, ct);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, inner);
  } else {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  }
  log.push(['Decrypted locally to verify', 'auth tag OK']);
  return { keyStr: b64url(rawKey), iv, salt, iv2, ct, authToken, ms: performance.now() - t0, log };
}

/* Undo both layers. pwKey is null when the link has no password. */
export async function openPayload({ ct, iv, iv2, keyStr, pwKey }) {
  const inner = pwKey ? await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv2 }, pwKey, ct) : ct;
  const key = await crypto.subtle.importKey('raw', b64urlDecode(keyStr), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, inner);
}
