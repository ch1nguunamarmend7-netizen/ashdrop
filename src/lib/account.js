// Ashdrop accounts, zero-knowledge. See worker/vault.js for what the server keeps.
//
//   password ─PBKDF2(600,000)─▶ master ─HKDF─▶ authKey   (sent; proves it is you)
//                                         └──▶ kek       (never sent; wraps the vault key)
//   recovery key (shown once) ─HKDF─▶ recoveryAuth (sent only to reset) + recovery kek
//   passkey (WebAuthn PRF output) ─HKDF─▶ passkey kek
//
// The vault key lives only in this tab's memory and sessionStorage while the vault is unlocked.

import { enc, b64url, b64urlDecode } from './crypto.js';

const ITER = 600000;
const ACCOUNT = 'ashdrop.account';
const VAULT_KEY = 'ashdrop.vk';
const PRF_SALT = enc.encode('ashdrop/v1/passkey-prf');

export const normEmail = (e) => String(e || '').trim().toLowerCase();

async function hkdf(raw, infos) {
  const k = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(s) });
  const out = {};
  for (const [name, s, kind] of infos) {
    out[name] = kind === 'bits' ? b64url(await crypto.subtle.deriveBits(info(s), k, 256))
      : await crypto.subtle.deriveKey(info(s), k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  return out;
}

export async function passwordKeys(email, password) {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('ashdrop/account/v1|' + normEmail(email))));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, 256);
  return hkdf(master, [['authKey', 'ashdrop/v1/account-auth', 'bits'], ['kek', 'ashdrop/v1/account-kek', 'key']]);
}

// Recovery key: 20 random bytes, shown as 8 groups of 4 letters/digits (Crockford base32, no I/L/O/U).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRecoveryKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}
function recoveryBytes(str) {
  const clean = String(str).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== 32 || /[U]/.test(clean)) throw new Error('A recovery key has 32 letters and digits.');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
const recoveryKeys = (str) => hkdf(recoveryBytes(str), [['recoveryAuth', 'ashdrop/v1/recovery-auth', 'bits'], ['kek', 'ashdrop/v1/recovery-kek', 'key']]);

export async function wrap(kek, raw) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64url(out);
}
export async function unwrap(kek, wrapped) {
  const b = b64urlDecode(wrapped);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, kek, b.slice(12)));
}

/* ---------- talking to the server ---------- */

export function session() { try { return JSON.parse(localStorage.getItem(ACCOUNT) || 'null'); } catch { return null; } }
function saveSession(s) { try { s ? localStorage.setItem(ACCOUNT, JSON.stringify(s)) : localStorage.removeItem(ACCOUNT); } catch {} }
export const authHeader = () => { const s = session(); return s ? { authorization: `Bearer ${s.uid}.${s.token}` } : {}; };

export function vaultKeyRaw() { try { const v = sessionStorage.getItem(VAULT_KEY); return v ? b64urlDecode(v) : null; } catch { return null; } }
function keepVaultKey(raw) { try { raw ? sessionStorage.setItem(VAULT_KEY, b64url(raw)) : sessionStorage.removeItem(VAULT_KEY); } catch {} }
export const lockVault = () => keepVaultKey(null);

async function api(path, body, { auth = false, headers = {} } = {}) {
  const res = await fetch('/api/account/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? authHeader() : {}), ...headers }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(errorText(data.error, res.status)); e.code = data.error || res.status; throw e; }
  return data;
}
function errorText(code, status) {
  return ({
    wrong: 'That email and password do not match an account.', email_taken: 'There is already an account with that email. Sign in instead.',
    bad_invite: 'That invite code is not valid, or it was already used.', bad_email: 'Enter a valid email address.',
    rate_limited: 'Too many tries. Wait a minute and try again.', locked_out: 'Too many wrong passwords. Wait 15 minutes, or reset it with your recovery key.', signed_out: 'You were signed out. Sign in again.',
    quota: 'Not enough space left in your vault.', not_found: 'Not found.',
  })[code] || `Something went wrong (${code || status}).`;
}

function start(email, data, raw) {
  saveSession({ uid: data.account.uid, token: data.token, email: data.account.email });
  keepVaultKey(raw);
  return data.account;
}

export async function signUp({ email, password, invite, ownerKey }) {
  const { authKey, kek } = await passwordKeys(email, password);
  const vaultKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = newRecoveryKey();
  const rk = await recoveryKeys(recoveryKey);
  const data = await api('signup', {
    email: normEmail(email), invite, authKey, wrapped: await wrap(kek, vaultKey),
    recoveryAuth: rk.recoveryAuth, recoveryWrapped: await wrap(rk.kek, vaultKey),
  }, { headers: ownerKey ? { 'x-ashdrop-owner-key': ownerKey } : {} });
  return { account: start(email, data, vaultKey), recoveryKey };
}

export async function signIn({ email, password }) {
  const { authKey, kek } = await passwordKeys(email, password);
  const data = await api('login', { email: normEmail(email), authKey });
  return start(email, data, await unwrap(kek, data.account.wrapped));
}

// Signed in on this device but the vault is locked (new tab, or locked by hand): unlock with the password.
export async function unlock(password) {
  const me = await api('me', {}, { auth: true });
  const { kek } = await passwordKeys(me.email, password);
  try { keepVaultKey(await unwrap(kek, me.wrapped)); } catch { throw new Error('That password is not right.'); }
  return me;
}

export const me = () => api('me', {}, { auth: true });
export async function signOut() { try { await api('logout', {}, { auth: true }); } catch {} saveSession(null); keepVaultKey(null); }

export async function recover({ email, recoveryKey, newPassword, newPin }) {
  const rk = await recoveryKeys(recoveryKey);
  let start1;
  try { start1 = await api('recover', { step: 'start', email: normEmail(email), recoveryAuth: rk.recoveryAuth }); }
  catch (e) { if (e.code === 'wrong') throw new Error('That recovery key does not match this email.'); throw e; }
  const vaultKey = await unwrap(rk.kek, start1.recoveryWrapped);
  const body = { step: 'finish', email: normEmail(email), recoveryAuth: rk.recoveryAuth };
  if (newPassword) { const { authKey, kek } = await passwordKeys(email, newPassword); Object.assign(body, { newAuthKey: authKey, newWrapped: await wrap(kek, vaultKey) }); }
  if (newPin) body.newPin = await pinRecord(newPin, vaultKey);
  const data = await api('recover', body);
  return start(email, data, vaultKey);
}

export async function changePassword({ oldPassword, newPassword }) {
  const s = session();
  const vaultKey = vaultKeyRaw();
  if (!s || !vaultKey) throw new Error('Unlock your vault first.');
  const old = await passwordKeys(s.email, oldPassword);
  const next = await passwordKeys(s.email, newPassword);
  try {
    const data = await api('password', { authKey: old.authKey, newAuthKey: next.authKey, newWrapped: await wrap(next.kek, vaultKey) }, { auth: true });
    return start(s.email, data, vaultKey);
  } catch (e) { if (e.code === 'wrong') throw new Error('Your current password is not right.'); throw e; }
}

export async function deleteAccount(secret) {
  const s = session();
  const info = await api('me', {}, { auth: true });
  const body = info.hasPassword ? { authKey: (await passwordKeys(s.email, secret)).authKey } : { pinAuth: (await pinKeys(secret, info.pin?.salt || 'AAAAAAAAAAAAAAAAAAAAAA')).auth };
  try { await api('delete', body, { auth: true }); } catch (e) { if (e.code === 'wrong') throw new Error(info.hasPassword ? 'That password is not right.' : 'That PIN is not right.'); throw e; }
  saveSession(null); keepVaultKey(null);
}

export const makeInvites = (ownerKey, count, quotaGb) => api('invites', { count, quotaGb }, { headers: { 'x-ashdrop-owner-key': ownerKey } });

/* ---------- passkeys (WebAuthn + the PRF extension) ---------- */

export const passkeysSupported = () => typeof PublicKeyCredential === 'function' && !!navigator.credentials?.create;
const b64 = (buf) => b64url(buf);

async function challenge() { return (await api('passkey/challenge', {})).challenge; }

/** Add a passkey that can unlock the vault on this device. Needs the vault unlocked. */
export async function addPasskey(name) {
  const s = session(); const vaultKey = vaultKeyRaw();
  if (!s || !vaultKey) throw new Error('Unlock your vault first.');
  const ch = await challenge();
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64urlDecode(ch), rp: { name: 'Ashdrop', id: location.hostname },
    user: { id: b64urlDecode(s.uid), name: s.email, displayName: s.email },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none', extensions: { prf: { eval: { first: PRF_SALT } } },
  } });
  if (!cred.getClientExtensionResults().prf?.enabled) throw new Error('This device\'s passkeys cannot unlock a vault (no PRF support). Use your password here.');
  let prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) { // some platforms only give the PRF value when the passkey is used, so use it once now
    const ch2 = await challenge();
    const got = await navigator.credentials.get({ publicKey: { challenge: b64urlDecode(ch2), rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required', extensions: { prf: { eval: { first: PRF_SALT } } } } });
    prf = got.getClientExtensionResults().prf?.results?.first;
    if (!prf) throw new Error('This passkey did not return the key needed to unlock a vault.');
  }
  const { kek } = await hkdf(new Uint8Array(prf), [['kek', 'ashdrop/v1/passkey-kek', 'key']]);
  const r = cred.response;
  return api('passkey/register', {
    id: b64(cred.rawId), name: name || 'Passkey', alg: r.getPublicKeyAlgorithm(), spki: b64(r.getPublicKey()),
    clientData: b64(r.clientDataJSON), authData: b64(r.getAuthenticatorData()), wrapped: await wrap(kek, vaultKey),
  }, { auth: true });
}

/** Sign in and unlock with a passkey, no email or password. */
export async function signInWithPasskey() {
  const ch = await challenge();
  const got = await navigator.credentials.get({ publicKey: { challenge: b64urlDecode(ch), rpId: location.hostname, userVerification: 'required', extensions: { prf: { eval: { first: PRF_SALT } } } } });
  const prf = got.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new Error('This passkey cannot unlock a vault on this device. Sign in with your password.');
  const r = got.response;
  let data;
  try { data = await api('passkey/login', { id: b64(got.rawId), clientData: b64(r.clientDataJSON), authData: b64(r.authenticatorData), signature: b64(r.signature) }); }
  catch (e) { if (['unknown_passkey', 'not_found'].includes(e.code)) throw new Error('That passkey is not linked to an Ashdrop account any more.'); throw e; }
  const { kek } = await hkdf(new Uint8Array(prf), [['kek', 'ashdrop/v1/passkey-kek', 'key']]);
  return start(data.account.email, data, await unwrap(kek, data.wrappedByPasskey));
}

export const removePasskey = (id) => api('passkey/remove', { id }, { auth: true });

/* ---------- vault PIN (for Google/Apple accounts, or as a quick unlock) ----------
   PIN ─PBKDF2(600,000, random salt)─▶ pinAuth (sent, checked by the server, 10 tries)
                                    └▶ part ─┐
   server "share" (handed out after a correct PIN) ─┴─HKDF─▶ PIN kek, which wraps the vault key. */
async function pinKeys(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const m = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64urlDecode(salt), iterations: ITER, hash: 'SHA-256' }, base, 256);
  const k = await hkdf(m, [['auth', 'ashdrop/v1/pin-auth', 'bits'], ['part', 'ashdrop/v1/pin-part', 'bits']]);
  return k;
}
async function pinKek(part, share) {
  const both = new Uint8Array([...b64urlDecode(part), ...b64urlDecode(share)]);
  return (await hkdf(both, [['kek', 'ashdrop/v1/pin-kek', 'key']])).kek;
}
async function pinRecord(pin, vaultKey) {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const share = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const { auth, part } = await pinKeys(pin, salt);
  return { salt, auth, share, wrapped: await wrap(await pinKek(part, share), vaultKey) };
}
export const pinOk = (pin) => String(pin).length >= 6;

export async function unlockWithPin(pin) {
  const info = await api('me', {}, { auth: true });
  if (!info.pin) throw new Error('PIN unlock is off for this account. Use a passkey or your recovery key.');
  const { auth, part } = await pinKeys(pin, info.pin.salt);
  let r;
  try { r = await api('pin/unlock', { pinAuth: auth }, { auth: true }); }
  catch (e) {
    if (e.code === 'wrong_pin') throw new Error('That PIN is not right.');
    if (e.code === 'pin_disabled') throw new Error('Too many wrong PINs, so PIN unlock is now off. Use a passkey or your recovery key, then choose a new PIN.');
    throw e;
  }
  keepVaultKey(await unwrap(await pinKek(part, r.share), r.wrapped));
  return info;
}

export async function setPin(pin) {
  const vaultKey = vaultKeyRaw();
  if (!vaultKey) throw new Error('Unlock your vault first.');
  if (!pinOk(pin)) throw new Error('Use a PIN of at least 6 digits or characters.');
  return api('pin/set', { pin: await pinRecord(pin, vaultKey) }, { auth: true });
}

/* ---------- Sign in with Google / Apple ---------- */
const OAUTH_STATE = 'ashdrop.oauthState';
export async function oauthProviders() {
  try { return await (await fetch('/api/oauth/providers')).json(); } catch { return {}; }
}
/** Go to Google or Apple. mode 'link' connects it to the signed-in account. */
export async function startOAuth(provider, mode = 'signin') {
  const res = await fetch(`/api/oauth/${provider}/prepare`, { method: 'POST', headers: { 'content-type': 'application/json', ...(mode === 'link' ? authHeader() : {}) }, body: JSON.stringify({ mode }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error === 'rate_limited' ? 'Too many tries. Wait a minute.' : 'Could not start signing in.');
  try { sessionStorage.setItem(OAUTH_STATE, data.state); } catch {}
  location.assign(data.url);
}
const OAUTH_ERRORS = {
  cancelled: 'Signing in was cancelled.', expired: 'That took too long. Try again.', no_email: 'Your account there has no verified email address.',
  email_has_account: 'There is already an Ashdrop account with that email. Sign in with your password, then connect Google in Settings.',
  identity_in_use: 'That account is already connected to another Ashdrop account.', bad_state: 'This sign-in did not start in this browser tab. Try again.',
};
/** After coming back: read #oauth=…&state=… (or #oauth_error=…). Returns null when there is nothing to finish. */
export async function finishOAuth(hash = location.hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  if (q.get('oauth_error')) return { error: OAUTH_ERRORS[q.get('oauth_error')] || 'Signing in did not work. Try again.' };
  const ticket = q.get('oauth');
  if (!ticket) return null;
  let expected = null;
  try { expected = sessionStorage.getItem(OAUTH_STATE); sessionStorage.removeItem(OAUTH_STATE); } catch {}
  if (!expected || expected !== q.get('state')) return { error: OAUTH_ERRORS.bad_state };
  const res = await fetch('/api/oauth/exchange', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeader() }, body: JSON.stringify({ ticket }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: OAUTH_ERRORS[data.error] || 'Signing in did not work. Try again.' };
  if (data.status === 'signedin') saveSession({ uid: data.account.uid, token: data.token, email: data.account.email }); // still locked
  return data;
}
/** New account after Google/Apple: choose a vault PIN; get a recovery key. */
export async function oauthSignUp({ signupTicket, email, pin, invite, ownerKey }) {
  if (!pinOk(pin)) throw new Error('Use a PIN of at least 6 digits or characters.');
  const vaultKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = newRecoveryKey();
  const rk = await recoveryKeys(recoveryKey);
  const res = await fetch('/api/oauth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(ownerKey ? { 'x-ashdrop-owner-key': ownerKey } : {}) },
    body: JSON.stringify({ signupTicket, invite, recoveryAuth: rk.recoveryAuth, recoveryWrapped: await wrap(rk.kek, vaultKey), pin: await pinRecord(pin, vaultKey) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorText(data.error, res.status) + (data.error === 'expired' ? ' Start again.' : ''));
  return { account: start(email, data, vaultKey), recoveryKey };
}
