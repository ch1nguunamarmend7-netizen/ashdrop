// Thin client for the Worker API. Only ciphertext and non-secret parameters are sent.
import { b64url, b64urlDecode } from './crypto.js';

const BASE = '/api/p';

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || body.reason || `HTTP ${res.status}`;
}

/** Upload a sealed payload. Returns { id, ownerToken, expiresAt }. */
export async function createLink({ ct, iv, iv2, salt, authToken, expiry, maxAttempts, code = null }) {
  const meta = { expiry, iv: b64url(iv) };
  if (code) meta.code = code; // { lookup, wrapped, wrapIv } from sealCode()
  if (authToken) Object.assign(meta, { maxAttempts, salt: b64url(salt), iv2: b64url(iv2), authToken: b64url(authToken) });
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-ashdrop-meta': JSON.stringify(meta) },
    body: ct,
  });
  if (res.status === 413) throw new Error('That is too large for a free link (25 MB).');
  if (res.status === 429) throw new Error('Too many links in a short time. Wait a minute and try again.');
  if (res.status === 409) { const e = new Error('code_taken'); e.code = 'code_taken'; throw e; }
  if (!res.ok) throw new Error(`Could not create the link: ${await readError(res)}`);
  return res.json();
}

/** What the recipient page may know before unlocking. */
export async function getMeta(id) {
  const res = await fetch(`${BASE}/${id}`);
  const body = await res.json().catch(() => ({ gone: true, reason: 'error' }));
  if (!res.ok) return { gone: true, reason: body.reason || 'not_found' };
  return { ...body, salt: body.salt ? b64urlDecode(body.salt) : null };
}

/** Ask the server to release the ciphertext. */
export async function openLink(id, authToken) {
  const res = await fetch(`${BASE}/${id}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(authToken ? { authToken: b64url(authToken) } : {}),
  });
  if (res.status === 401) return { status: 'denied', attemptsLeft: (await res.json()).attemptsLeft };
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { status: body.status === 'locked' ? 'locked' : 'gone', reason: body.reason };
  }
  const iv2 = res.headers.get('x-ashdrop-iv2');
  return {
    status: 'ok',
    ct: await res.arrayBuffer(),
    iv: b64urlDecode(res.headers.get('x-ashdrop-iv')),
    iv2: iv2 ? b64urlDecode(iv2) : null,
    burned: res.headers.get('x-ashdrop-burned') === '1',
    expiresAt: Number(res.headers.get('x-ashdrop-expires')),
  };
}

export async function revokeLink(id, ownerToken) {
  const res = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${ownerToken}` } });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function linkStatus(id, ownerToken) {
  const res = await fetch(`${BASE}/${id}/status`, { headers: { authorization: `Bearer ${ownerToken}` } });
  if (!res.ok) return { state: 'unknown' };
  return res.json();
}

/** Find the link a typed code belongs to. Returns { status: 'ok', id, wrapped, wrapIv } or a reason. */
export async function lookupCode(lookup) {
  const res = await fetch('/api/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lookup }) });
  if (res.ok) return { status: 'ok', ...(await res.json()) };
  if (res.status === 429) return { status: 'rate_limited' };
  const body = await res.json().catch(() => ({}));
  return { status: res.status === 410 ? 'gone' : 'not_found', reason: body.reason };
}
