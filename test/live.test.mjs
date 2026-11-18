// Live transfer ("send in parts"), end to end: the real browser code (src/lib/live.js) against the real
// Worker, with in-memory storage. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { makeEnv } from './mock-env.mjs';

const live = await import('../src/lib/live.js');
const MB = 1024 * 1024;
function useWorker(env) {
  globalThis.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body instanceof Uint8Array && !headers.has('content-length')) headers.set('content-length', String(init.body.length));
    return worker.fetch(new Request('https://ashdrop.test' + path, { ...init, headers }), env, { waitUntil() {} });
  };
}
const bytes = (n, seed) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; };
const piecesOnServer = (env) => [...env._blobs.keys()].filter((k) => k.startsWith('s/')).length;

test('live: a 20 MB and a small file arrive intact; the server never holds more than 3 pieces', async () => {
  const env = makeEnv(); useWorker(env);
  const a = bytes(20 * MB + 123, 1), b = bytes(1000, 2);
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, piecesOnServer(env)); }, 5);
  const phases = [];
  const send = await live.startLive([new File([a], 'video.mov', { type: 'video/quicktime' }), new File([b], 'notes.txt')], { onStatus: (s) => phases.push(s.phase) });
  assert.equal(send.chunks, 3);
  const info = await live.liveInfo(send.id, send.keyStr);
  assert.deepEqual(info.files.map((f) => f.name), ['video.mov', 'notes.txt'], 'names are inside the encrypted header');
  // nothing readable on the server: the header is ciphertext
  const meta = await (await fetch(`/api/s/${send.id}`)).json();
  assert.ok(!JSON.stringify(meta).includes('video.mov'));
  const got = await live.receiveLive(send.id, send.keyStr, info);
  await send.done;
  clearInterval(watch);
  assert.equal(got.files.length, 2);
  assert.deepEqual(new Uint8Array(await got.files[0].blob.arrayBuffer()), a);
  assert.deepEqual(new Uint8Array(await got.files[1].blob.arrayBuffer()), b);
  assert.equal(got.files[0].blob.type, 'video/quicktime');
  assert.ok(most <= 3, `server held at most ${most} pieces`);
  assert.equal(piecesOnServer(env), 0, 'every piece deleted once received');
  assert.equal(phases.at(-1), 'done');
});

test('live: one receiver only; a wrong key fails; cancel deletes what is in flight', async () => {
  const env = makeEnv(); useWorker(env);
  const send = await live.startLive([new File([bytes(17 * MB, 3)], 'big.bin')]);
  try {
  await new Promise((r) => setTimeout(r, 300)); // the sender pre-uploads while it waits
  assert.ok(piecesOnServer(env) >= 1);
  await assert.rejects(live.liveInfo(send.id, 'A'.repeat(43)), /incomplete or damaged/);
  const info = await live.liveInfo(send.id, send.keyStr);
  // the first device takes the transfer...
  const claim = await (await fetch(`/api/s/${send.id}/claim`, { method: 'POST' })).json();
  assert.match(claim.token, /^[A-Za-z0-9_-]{43}$/);
  // ...so a second one cannot
  await assert.rejects(live.receiveLive(send.id, send.keyStr, info), /already opened on another device/);
  // the receiver cancels: the sender stops and the waiting pieces are deleted
  assert.equal((await fetch(`/api/s/${send.id}`, { method: 'DELETE', headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await fetch(`/api/s/${send.id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + claim.token } })).status, 200);
  await send.done;
  assert.equal(piecesOnServer(env), 0, 'cancelled: nothing left on the server');
  assert.equal((await (await fetch(`/api/s/${send.id}`)).json()).state, 'cancelled');
  } finally { await send.cancel(); }
});

test('live: limits and bad input', async () => {
  const env = makeEnv(); useWorker(env);
  const post = (body) => fetch('/api/s', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ size: 6 * 1024 ** 3, chunks: 768, hdr: 'abc' })).status, 413, 'over 5 GB');
  assert.equal((await post({ size: 20 * MB, chunks: 2, hdr: 'abc' })).status, 400, 'wrong piece count');
  assert.equal((await post({ size: 10, chunks: 1, hdr: '<script>' })).status, 400);
  const r = await (await post({ size: 10, chunks: 1, hdr: 'abc' })).json();
  // only the sender's token may upload, and only within the size of a piece
  assert.equal((await fetch(`/api/s/${r.id}/0`, { method: 'PUT', headers: { authorization: 'Bearer nope', 'content-length': '40' }, body: new Uint8Array(40) })).status, 403);
  assert.equal((await fetch(`/api/s/${r.id}/0`, { method: 'PUT', headers: { authorization: 'Bearer ' + r.token, 'content-length': String(9 * MB) }, body: new Uint8Array(9 * MB) })).status, 400);
  assert.equal((await fetch(`/api/s/${r.id}/5`, { method: 'PUT', headers: { authorization: 'Bearer ' + r.token, 'content-length': '40' }, body: new Uint8Array(40) })).status, 400, 'no such piece');
  assert.equal((await fetch(`/api/s/${r.id}/0`)).status, 403, 'downloading needs the receiver token');
  assert.equal((await fetch('/api/s/notanid')).status, 404);
});
