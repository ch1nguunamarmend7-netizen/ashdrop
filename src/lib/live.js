// Live transfer ("send in parts"), browser side. See worker/stream.js for the server.
//
// The file (or several files, back to back) is read 8 MiB at a time, each piece sealed with AES-256-GCM
// under a fresh key that only lives in the link's # fragment. The piece's number is bound in as
// associated data, so pieces cannot be swapped, dropped or replayed. The server holds at most a few
// pieces at once and deletes each one as soon as the receiver has it.

import { enc, b64url, b64urlDecode } from './crypto.js';

export const CHUNK = 8 * 1024 * 1024;
export const LIVE_MAX = 5 * 1024 ** 3; // 5 GB
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const importKey = (raw, usage) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usage);
async function seal(key, bytes, ad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(ad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function open(key, bytes, ad) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(ad) }, key, bytes.slice(12)));
}
const pieceAd = (id, n, chunks) => `ashdrop/live:${id}:${n}:${chunks}`;

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await fetch('/api/s' + path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (raw === 'download') return res;
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/**
 * Start sending. Returns { id, keyStr, done, cancel }.
 * onStatus({ phase: 'waiting'|'sending'|'done'|'cancelled'|'error', sent, total, claimed, message })
 */
export async function startLive(files, { onStatus = () => {} } = {}) {
  const list = Array.from(files);
  const whole = new Blob(list); // a view over the files back to back; nothing is copied
  const size = whole.size;
  if (size > LIVE_MAX) throw new Error('Live transfers can be up to 5 GB.');
  const chunks = Math.max(1, Math.ceil(size / CHUNK));
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importKey(raw, ['encrypt']);
  const header = { v: 1, files: list.map((f) => ({ name: f.name, mime: f.type || '', size: f.size })) };
  const hdr = b64url(await seal(key, enc.encode(JSON.stringify(header)), 'ashdrop/live:header'));
  const r = await api('POST', '', { body: { size, chunks, hdr } });
  if (r.status === 429) throw new Error('Too many transfers started. Wait a minute.');
  if (r.status !== 201) throw new Error(r.data.error === 'too_big' ? 'Live transfers can be up to 5 GB.' : 'Could not start the live transfer.');
  const { id, token } = r.data;
  const windowSize = r.data.window || 3; // pieces the server will hold at once
  let stopped = false, claimed = false, acked = 0;
  const report = (phase, sent, extra = {}) => onStatus({ phase, sent, total: chunks, size, claimed, ...extra });

  const run = async () => {
    report('waiting', 0);
    for (let n = 0; n < chunks; n++) {
      const piece = await seal(key, new Uint8Array(await whole.slice(n * CHUNK, (n + 1) * CHUNK).arrayBuffer()), pieceAd(id, n, chunks));
      for (;;) { // upload piece n, once the server has room for it
        if (stopped) return report('cancelled', n);
        if (n - acked >= windowSize) { // the window is full: ask how far the receiver is before sending 8 MB for nothing
          const st = await api('GET', `/${id}/status`, { token }).catch(() => null);
          if (st?.status === 200) {
            acked = st.data.acked; claimed = st.data.claimed;
            if (st.data.state === 'cancelled') return report('cancelled', acked, { message: 'The other device cancelled the transfer.' });
            report(claimed ? 'sending' : 'waiting', acked);
          }
          if (n - acked >= windowSize) { await sleep(claimed ? 250 : 1000); continue; }
        }
        let res;
        try { res = await api('PUT', `/${id}/${n}`, { token, body: piece, raw: true }); } catch { await sleep(1500); continue; } // network blip: try again
        if (res.status === 200) { claimed = res.data.claimed; acked = res.data.acked; report(claimed ? 'sending' : 'waiting', acked); break; }
        if (res.status === 429 && res.data.error === 'wait') { claimed = res.data.claimed; acked = res.data.acked; report(claimed ? 'sending' : 'waiting', acked); await sleep(claimed ? 300 : 1000); continue; }
        if (res.status === 409 && res.data.error === 'already') break; // our earlier try got through
        if (res.status === 410) return report('cancelled', n, { message: 'The other device cancelled the transfer.' });
        if (res.status === 429) { await sleep(2000); continue; }
        throw new Error('The transfer stopped (' + (res.data.error || res.status) + ').');
      }
    }
    for (;;) { // everything is uploaded: wait until the last pieces are picked up
      if (stopped) return report('cancelled', chunks);
      const st = await api('GET', `/${id}/status`, { token }).catch(() => null);
      if (st?.status === 200) {
        claimed = st.data.claimed;
        if (st.data.state === 'done') return report('done', chunks);
        if (st.data.state === 'cancelled') return report('cancelled', st.data.acked, { message: 'The other device cancelled the transfer.' });
        report('sending', st.data.acked);
      }
      await sleep(700);
    }
  };
  const done = run().catch((e) => report('error', 0, { message: e.message }));
  return {
    id, keyStr: b64url(raw), size, chunks, files: header.files, done,
    cancel: async () => { stopped = true; await api('DELETE', `/${id}`, { token }).catch(() => {}); },
  };
}

/** What a live link holds: file names and sizes (decrypted here), and how far along it is. */
export async function liveInfo(id, keyStr) {
  const r = await api('GET', `/${id}`);
  if (r.status === 404) throw Object.assign(new Error('This live transfer does not exist, or it ended over an hour ago.'), { code: 'gone' });
  if (r.status !== 200) throw new Error('Could not reach Ashdrop. Check your connection.');
  let header;
  try { header = JSON.parse(dec.decode(await open(await importKey(b64urlDecode(keyStr), ['decrypt']), b64urlDecode(r.data.hdr), 'ashdrop/live:header'))); }
  catch { throw Object.assign(new Error('This link is incomplete or damaged. Ask the sender to copy it again.'), { code: 'key' }); }
  return { ...r.data, files: header.files };
}

/**
 * Receive. sink: { write(Uint8Array), close() } or omitted to collect in memory.
 * onProgress({ got, total, waiting, senderAgo }). Returns { files: [{ name, mime, size, blob }] } (blobs only when collected).
 */
export async function receiveLive(id, keyStr, info, { sink, onProgress = () => {}, signal } = {}) {
  const c = await api('POST', `/${id}/claim`);
  if (c.status === 409) throw Object.assign(new Error('This live transfer was already opened on another device.'), { code: 'claimed' });
  if (c.status === 410) throw Object.assign(new Error('The sender cancelled this transfer.'), { code: 'cancelled' });
  if (c.status !== 200) throw new Error(c.status === 429 ? 'Too many tries. Wait a minute.' : 'Could not start receiving.');
  const { token } = c.data;
  const key = await importKey(b64urlDecode(keyStr), ['decrypt']);
  const parts = [];
  for (let n = 0; n < info.chunks; n++) {
    for (;;) {
      if (signal?.aborted) { await api('DELETE', `/${id}`, { token }).catch(() => {}); throw Object.assign(new Error('Cancelled.'), { code: 'aborted' }); }
      let res;
      try { res = await api('GET', `/${id}/${n}`, { token, raw: 'download' }); } catch { await sleep(1500); continue; }
      if (res.status === 200) {
        let plain;
        try { plain = await open(key, new Uint8Array(await res.arrayBuffer()), pieceAd(id, n, info.chunks)); }
        catch { throw new Error('A piece could not be decrypted. The transfer was stopped.'); }
        if (sink) await sink.write(plain); else parts.push(new Blob([plain]));
        await api('POST', `/${id}/${n}/ack`, { token }).catch(() => {});
        onProgress({ got: n + 1, total: info.chunks, waiting: false });
        break;
      }
      if (res.status === 204) { onProgress({ got: n, total: info.chunks, waiting: true, senderAgo: Number(res.headers.get('x-ashdrop-sender-ago')) || 0 }); await sleep(300); continue; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 410) throw Object.assign(new Error('The sender cancelled the transfer.'), { code: 'cancelled' });
      if (res.status === 429) { await sleep(2000); continue; }
      throw new Error('The transfer stopped (' + (data.error || res.status) + ').');
    }
  }
  if (sink) { await sink.close(); return { files: info.files }; }
  // Cut the joined bytes back into the original files.
  const all = new Blob(parts);
  let at = 0;
  return { files: info.files.map((f) => { const blob = new Blob([all.slice(at, at + f.size)], { type: f.mime || 'application/octet-stream' }); at += f.size; return { ...f, blob }; }) };
}
