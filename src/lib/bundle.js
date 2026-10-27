// Several files in one link, and a small zip writer for "Download all".
// Everything here runs in the browser on plaintext that never leaves the device.

export const MAX_FILES = 100;
export const MAX_TOTAL = 25 * 1024 * 1024; // free per-link cap; the server allows a little extra for headers
export const OWNER_MAX_TOTAL = 95 * 1024 * 1024; // with the site owner's key (see lib/owner.js)

/** Concatenate files; the list of names, types and sizes goes into the sealed header. */
export async function bundleFiles(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const f of files) { out.set(new Uint8Array(await f.arrayBuffer()), at); at += f.size; }
  return { header: { kind: 'files', files: files.map((f) => ({ name: f.name, mime: f.type || '', size: f.size })) }, content: out };
}

/** Split a bundle back into files. Checks the sizes add up before slicing anything. */
export function unbundleFiles(header, content) {
  const list = Array.isArray(header.files) ? header.files : [];
  const total = list.reduce((n, f) => n + (Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : NaN), 0);
  if (!list.length || total !== content.byteLength) throw new Error('The file list does not match the content');
  let at = 0;
  return list.map((f) => {
    const data = content.slice(at, at + f.size);
    at += f.size;
    return { name: String(f.name || 'file'), mime: String(f.mime || ''), size: f.size, data };
  });
}

/* ---------- zip (stored, no compression: the files are usually already compressed) ---------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Give repeated names a " (2)" suffix so nothing is overwritten when unzipped. */
function uniqueNames(items) {
  const seen = new Map();
  return items.map(({ name }) => {
    const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || 'file';
    const n = (seen.get(clean.toLowerCase()) || 0) + 1;
    seen.set(clean.toLowerCase(), n);
    if (n === 1) return clean;
    const dot = clean.lastIndexOf('.');
    return dot > 0 ? `${clean.slice(0, dot)} (${n})${clean.slice(dot)}` : `${clean} (${n})`;
  });
}

/** Build a .zip Blob from [{ name, data: Uint8Array }]. */
export function makeZip(items) {
  const te = new TextEncoder();
  const names = uniqueNames(items);
  const parts = [], central = [];
  let offset = 0;
  // Fixed DOS timestamp (1 Jan 2026): the archive does not reveal when it was made.
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  items.forEach((it, i) => {
    const data = it.data instanceof Uint8Array ? it.data : new Uint8Array(it.data);
    const name = te.encode(names[i]);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  });
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, items.length, true); end.setUint16(10, items.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
