// "My links" for signed-in accounts: kept in the encrypted vault, so they open when the vault opens
// and show up on every device you sign in on.
//
//   - The account has a links key pair (P-256). The public key is stored readable; the private key is
//     stored sealed with the vault key, so only an unlocked vault can read the links.
//   - Each link (with its key and owner token) is sealed to the public key in this browser, the same
//     way as the device lock in linkStore.js. That way a link can be saved while the vault is locked.
//   - The server sees an id, a size and a time per link. Never a link's key, label or contents.
//
// Signed out, My links stays on this device (linkStore.js).

import * as account from './account.js';
import { vk, seal, open } from './vault.js';
import * as linkStore from './linkStore.js';
import { enc, b64url, b64urlDecode } from './crypto.js';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const PUB = 'ashdrop.linkspub';

async function req(method, path, body) {
  const res = await fetch('/api/vault/' + path, {
    method, headers: { ...account.authHeader(), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error === 'signed_out' ? 'You were signed out. Sign in again.' : `Could not reach your vault (${data.error || res.status}).`), { code: data.error || res.status });
  return data;
}

const cachedPub = () => {
  try { const v = JSON.parse(localStorage.getItem(PUB) || 'null'); const s = account.session(); return v && s && v.uid === s.uid ? v.key : null; } catch { return null; }
};
const keepPub = (key) => { try { localStorage.setItem(PUB, JSON.stringify({ uid: account.session().uid, key: { x: key.x, y: key.y } })); } catch {} };
const pubJwk = (k) => ({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true });
const pack = (o) => b64url(enc.encode(JSON.stringify(o)));
const unpack = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

/** Signed in: links go to the vault. */
export const active = () => !!account.session();

/** The account's links key. Made the first time it is needed with the vault unlocked. */
async function getKey(create) {
  let { key } = await req('GET', 'links-key');
  if (!key && create) {
    const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    ({ key } = await req('POST', 'links-key', { key: { x: pub.x, y: pub.y, priv: await seal(await vk(), privJwk) } }));
  }
  if (key) keepPub(key);
  return key;
}

async function put(key, record) {
  await req('POST', 'links', { id: record.id, blob: pack(await linkStore.sealOne(pubJwk(key), record)) });
}

/**
 * Save a new link. Works while the vault is locked. If the vault cannot be reached (offline, or the
 * account has never opened its vault), the link is kept on this device and moved in on the next unlock.
 * Returns 'vault' or 'device'.
 */
export async function add(record) {
  try {
    const key = cachedPub() || (await getKey(!!account.vaultKeyRaw()));
    if (!key) throw new Error('no_key');
    await put(key, record);
    return 'vault';
  } catch {
    await linkStore.addLink(record);
    return 'device';
  }
}

/** Move links into the vault (from this device). Needs the vault unlocked. */
export async function importRecords(records) {
  if (!records.length) return;
  const key = await getKey(true);
  for (const r of records) await put(key, r);
}

/**
 * Every link in the vault, newest first. Needs the vault unlocked. Readable links saved on this
 * device (before signing in, or while offline) are moved into the vault first.
 */
export async function list() {
  const key = await getKey(true);
  if (!linkStore.hasLock()) {
    const local = linkStore.loadPlain();
    if (local.length) { await importRecords(local); linkStore.savePlain([]); }
  }
  const priv = await crypto.subtle.importKey('jwk', await open(await vk(), key.priv), ECDH, false, ['deriveBits']);
  const { links } = await req('GET', 'links');
  const out = [];
  for (const l of links) { try { out.push(await linkStore.openOne(priv, unpack(l.blob))); } catch { /* skip damaged entries */ } }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Take a link off the list (the link itself keeps working until it burns or expires). */
export const remove = (id) => req('DELETE', 'links/' + id);
