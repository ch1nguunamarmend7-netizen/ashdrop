// The encrypted vault, client side. Each file gets its own random key; the file is cut into 8 MiB
// chunks, each sealed with AES-GCM (its position is bound in as associated data, so chunks cannot be
// swapped or reordered). Name, type, folder and the file key are sealed with the vault key ("meta").

import { enc, b64url, b64urlDecode } from './crypto.js';
import { authHeader, vaultKeyRaw } from './account.js';

export const CHUNK = 8 * 1024 * 1024;
const dec = new TextDecoder();

async function vk() {
  const raw = vaultKeyRaw();
  if (!raw) throw Object.assign(new Error('Your vault is locked.'), { code: 'locked' });
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64url(out);
}
async function open(key, b64) {
  const b = b64urlDecode(b64);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))));
}

async function req(method, path, body, raw) {
  const res = await fetch('/api/vault/' + path, {
    method, headers: { ...authHeader(), ...(raw ? {} : { 'content-type': 'application/json' }) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw === 'download') return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error === 'quota' ? 'Not enough space left in your vault.' : data.error === 'signed_out' ? 'You were signed out. Sign in again.' : `Vault error (${data.error || res.status}).`), { code: data.error || res.status, data });
  return data;
}

/** List files, with their names and folders decrypted. */
export async function listFiles() {
  const key = await vk();
  const { files, used, quota } = await req('GET', 'files');
  const out = [];
  for (const f of files) {
    try { out.push({ ...f, ...(await open(key, f.meta)) }); }
    catch { out.push({ ...f, name: 'Unreadable file', mime: '', folder: null, broken: true }); }
  }
  return { files: out, used, quota };
}

// PUT with upload progress (fetch cannot report it).
function putChunk(path, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', '/api/vault/' + path);
    for (const [k, v] of Object.entries(authHeader())) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
    x.onload = () => (x.status === 200 ? resolve() : reject(new Error(`Upload failed (${x.status}).`)));
    x.onerror = () => reject(new Error('The upload was interrupted. Check your connection.'));
    x.send(bytes);
  });
}

/** Encrypt and upload one File. onProgress(0..1). Returns the new file entry. */
export async function uploadFile(file, { folder = null, onProgress } = {}) {
  const key = await vk();
  const fileKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const fileKey = await crypto.subtle.importKey('raw', fileKeyRaw, 'AES-GCM', false, ['encrypt']);
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
  const size = file.size + chunks * 28;
  const info = { name: file.name, mime: file.type || '', folder, plainSize: file.size, fileKey: b64url(fileKeyRaw), v: 1 };
  const { id } = await req('POST', 'files', { size, chunks, meta: await seal(key, info) });
  let done = 0;
  for (let n = 0; n < chunks; n++) {
    const plain = await file.slice(n * CHUNK, (n + 1) * CHUNK).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${id}:${n}:${chunks}`) }, fileKey, plain));
    const body = new Uint8Array(12 + ct.length); body.set(iv); body.set(ct, 12);
    await putChunk(`files/${id}/${n}`, body, (sent) => onProgress?.((done + sent) / size));
    done += body.length;
    onProgress?.(done / size);
  }
  await req('POST', `files/${id}/done`, { chunks });
  return { id, size, chunks, created: Date.now(), ...info };
}

/** Download and decrypt a file entry from listFiles(). Returns a Blob. */
export async function downloadFile(f, { onProgress } = {}) {
  const fileKey = await crypto.subtle.importKey('raw', b64urlDecode(f.fileKey), 'AES-GCM', false, ['decrypt']);
  const parts = [];
  for (let n = 0; n < f.chunks; n++) {
    const res = await req('GET', `files/${f.id}/${n}`, undefined, 'download');
    if (!res.ok) throw new Error(`Could not download part ${n + 1} of ${f.name}.`);
    const b = new Uint8Array(await res.arrayBuffer());
    try {
      parts.push(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(`${f.id}:${n}:${f.chunks}`) }, fileKey, b.slice(12)));
    } catch { throw new Error(`${f.name} could not be decrypted. It may be damaged.`); }
    onProgress?.((n + 1) / f.chunks);
  }
  return new Blob(parts, { type: f.mime || 'application/octet-stream' });
}

/** Rename or move: re-seal the metadata. */
export async function updateFile(f, changes) {
  const key = await vk();
  const info = { name: f.name, mime: f.mime, folder: f.folder ?? null, plainSize: f.plainSize, fileKey: f.fileKey, v: 1, ...changes };
  await req('PATCH', `files/${f.id}`, { meta: await seal(key, info) });
  return { ...f, ...changes };
}

export const deleteFile = (f) => req('DELETE', `files/${f.id}`);

/** Folders and their colors, sealed with the vault key. */
export async function loadPrefs() {
  const res = await fetch('/api/account/prefs', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeader() }, body: '{}' });
  const { blob } = await res.json().catch(() => ({}));
  if (!blob) return { folders: [], colors: {} };
  try { return await open(await vk(), blob); } catch { return { folders: [], colors: {} }; }
}
export async function savePrefs(prefs) {
  await fetch('/api/account/prefs', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeader() }, body: JSON.stringify({ blob: await seal(await vk(), prefs) }) });
}
