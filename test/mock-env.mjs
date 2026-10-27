// In-memory stand-ins for R2 and Durable Objects, for tests and local smoke runs.
import { LinkDO } from '../worker/index.js';

export function makeEnv() {
  const blobs = new Map();
  const objects = new Map();
  const BLOBS = {
    async put(k, v) { blobs.set(k, new Uint8Array(v instanceof ReadableStream ? await new Response(v).arrayBuffer() : v)); },
    async get(k) {
      const v = blobs.get(k);
      return v ? { size: v.length, body: new Blob([v]).stream(), arrayBuffer: async () => v.buffer.slice(0) } : null;
    },
    async delete(k) { blobs.delete(k); },
  };
  const env = { BLOBS, _waits: [] };
  function state() {
    // Mirrors blockConcurrencyWhile: one request at a time per object.
    let chain = Promise.resolve();
    return {
      storage: storage(),
      blockConcurrencyWhile(fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; },
    };
  }
  function storage() {
    const m = new Map();
    return {
      alarmAt: null,
      async get(k) { return structuredClone(m.get(k)); },
      async put(k, v) { m.set(k, structuredClone(v)); },
      async delete(k) { m.delete(k); },
      async deleteAll() { m.clear(); },
      async setAlarm(t) { this.alarmAt = t; },
    };
  }
  env.LINKS = {
    idFromName: (n) => n,
    get(id) {
      if (!objects.has(id)) objects.set(id, new LinkDO(state(), env));
      const obj = objects.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
  env.ASSETS = { fetch: async () => new Response('<!doctype html>index', { headers: { 'content-type': 'text/html' } }) };
  env._blobs = blobs;
  env._objects = objects;
  return env;
}

