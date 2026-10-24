// Typeable codes: open a link on a device that cannot scan the QR code.
//
// A code is 4 random words from a 2048-word list (44 bits). In the browser, the code is
// stretched with PBKDF2 (310,000 rounds) and split with HKDF into two unrelated values:
//   lookup  - sent to the server, which stores only its SHA-256 and uses it to find the link
//   wrapKey - never leaves the browser; it encrypts the link's real 256-bit key
// The server keeps the wrapped key next to the lookup hash. Without the code it can neither
// find which link a code belongs to nor unwrap the key, and every guess costs a full PBKDF2.
// A code is weaker than a full link (44 bits instead of 256), so a password on top is advised
// for anything very sensitive; the password layer works exactly as it does for links.

import { WORDS } from './words.js';
import { enc, b64url, b64urlDecode } from './crypto.js';

const BY_PREFIX = new Map(WORDS.map((w) => [w.slice(0, 4), w]));
const WORD_SET = new Set(WORDS);
export const CODE_WORDS = 4;

/** 4 uniformly random words, joined with dashes: "tiger-orbit-lamp-river". */
export function generateCode() {
  const r = crypto.getRandomValues(new Uint16Array(CODE_WORDS));
  return Array.from(r, (x) => WORDS[x & 2047]).join('-'); // 2048 = 2^11, so no bias
}

/** Match one typed word. Every word in the list is unique in its first 4 letters. */
export function matchWord(typed) {
  const t = typed.toLowerCase();
  if (t.length === 3) return WORD_SET.has(t) ? t : null;   // a few words are only 3 letters long
  if (t.length < 4) return null;
  const w = BY_PREFIX.get(t.slice(0, 4));
  return w && w.startsWith(t) ? w : null;                    // the whole word, or any start of it from 4 letters
}

/** Read what someone typed: any separators, any case, full words or their first 4 letters.
    Returns { words: [{ typed, word }], code } where code is set only when all 4 words match. */
export function parseCode(input) {
  const parts = String(input).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const words = parts.map((typed) => ({ typed, word: matchWord(typed) }));
  const ok = words.length === CODE_WORDS && words.every((x) => x.word);
  return { words, code: ok ? words.map((x) => x.word).join('-') : null };
}

async function codeKeys(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('ashdrop/code/v1'), iterations: 310000, hash: 'SHA-256' }, base, 256);
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(s) });
  const lookup = await crypto.subtle.deriveBits(info('ashdrop/v1/code-lookup'), hk, 256);
  const wrapKey = await crypto.subtle.deriveKey(info('ashdrop/v1/code-wrap'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { lookup: b64url(lookup), wrapKey };
}

/** For the sender: what the server needs to let this code open the link. */
export async function sealCode(code, keyStr) {
  const { lookup, wrapKey } = await codeKeys(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, b64urlDecode(keyStr));
  return { lookup, wrapped: b64url(wrapped), wrapIv: b64url(iv) };
}

/** For the recipient: the lookup value to send, and a function that unwraps the link key. */
export async function openCode(code) {
  const { lookup, wrapKey } = await codeKeys(code);
  return {
    lookup,
    unwrap: async (wrapped, wrapIv) =>
      b64url(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(wrapIv) }, wrapKey, b64urlDecode(wrapped))),
  };
}
