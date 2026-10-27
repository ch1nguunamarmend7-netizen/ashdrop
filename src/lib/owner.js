// The site owner's key. Whoever runs Ashdrop sets OWNER_KEY as a Cloudflare secret and pastes the same
// value into Settings on their own devices. Links made there may be bigger (up to 95 MB) and last 7 days.
// The server checks the key on every upload, so the public code alone unlocks nothing.
// It is kept in this browser's localStorage only and sent only with uploads and the one-time check.

const KEY = 'ashdrop.ownerKey';

export function getOwnerKey() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

/** Ask the server whether this key is right. Saves it only if it is. */
export async function saveOwnerKey(key) {
  const res = await fetch('/api/owner', { method: 'POST', headers: { 'x-ashdrop-owner-key': key } });
  if (res.status === 429) throw new Error('Too many tries. Wait a minute.');
  if (!res.ok) throw new Error('That key was not accepted.');
  try { localStorage.setItem(KEY, key); } catch { throw new Error('This browser would not save it (private window?).'); }
  return res.json();
}

export function clearOwnerKey() {
  try { localStorage.removeItem(KEY); } catch {}
}
