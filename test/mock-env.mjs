// In-memory stand-ins for R2 and Durable Objects, for tests and local smoke runs.
import { LinkDO, UserDO } from '../worker/index.js';

export function makeEnv() {
  const blobs = new Map();
  const objects = new Map();
  const BLOBS = {
    async put(k, v) { blobs.set(k, new Uint8Array(v instanceof ReadableStream ? await new Response(v).arrayBuffer() : v)); },
    async get(k) {
      const v = blobs.get(k);
      return v ? { size: v.length, body: new Blob([v]).stream(), arrayBuffer: async () => v.buffer.slice(0) } : null;
    },
    async delete(k) { for (const x of [].concat(k)) blobs.delete(x); },
    async head(k) { const v = blobs.get(k); return v ? { size: v.length } : null; },
  };
  const env = { BLOBS, _waits: [] };
  function state() {
    // Mirrors blockConcurrencyWhile: one request at a time per object.
    let chain = Promise.resolve();
    const sockets = [];
    return {
      storage: storage(),
      blockConcurrencyWhile(fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; },
      // Durable Object WebSocket hibernation API, enough for tests.
      acceptWebSocket(ws) { ws._do = this._obj; sockets.push(ws); },
      getWebSockets() { return sockets.filter((w) => !w.closed); },
      sockets,
    };
  }
  function storage() {
    const m = new Map();
    return {
      alarmAt: null,
      async get(k) { return structuredClone(m.get(k)); },
      async put(k, v) { m.set(k, structuredClone(v)); },
      async delete(k) { for (const x of [].concat(k)) m.delete(x); },
      async deleteAll() { m.clear(); },
      async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
      async setAlarm(t) { this.alarmAt = t; },
    };
  }
  env.LINKS = {
    idFromName: (n) => n,
    get(id) {
      if (!objects.has(id)) { const st = state(); const obj = new LinkDO(st, env); st._obj = obj; objects.set(id, obj); }
      const obj = objects.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
  const users = new Map();
  env.USERS = {
    idFromName: (n) => n,
    get(id) {
      if (!users.has(id)) { const st = state(); users.set(id, new UserDO(st, env)); }
      const obj = users.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };
  env._users = users;
  env.ASSETS = { fetch: async () => new Response('<!doctype html>index', { headers: { 'content-type': 'text/html' } }) };
  env._blobs = blobs;
  env._objects = objects;
  return env;
}

