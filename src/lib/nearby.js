// Nearby: send files and text straight to devices on the same network, like AirDrop or LocalSend.
//
// The Ashdrop server only introduces devices that share a network (a room per scrambled network id)
// and passes their connection offers along. The transfer itself is a WebRTC data channel: encrypted
// (DTLS) end to end between the two browsers, never stored anywhere, with no size limit.
// Both sides show a 4-digit check code made from the two connection fingerprints. If the codes match,
// nobody (including our server) sits in the middle.

const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();

const ADJ = ['Amber', 'Blue', 'Brave', 'Calm', 'Clever', 'Coral', 'Crimson', 'Golden', 'Green', 'Happy', 'Jade', 'Lucky', 'Misty', 'Quiet', 'Rapid', 'Silver', 'Snowy', 'Sunny', 'Swift', 'Wild'];
const ANIMAL = ['Otter', 'Fox', 'Owl', 'Falcon', 'Lynx', 'Panda', 'Heron', 'Wolf', 'Yak', 'Taimen', 'Seal', 'Marmot', 'Crane', 'Badger', 'Tiger', 'Koala', 'Raven', 'Gecko', 'Bison', 'Hare'];

export function nearbyIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem('ashdrop.nearby') || 'null');
    if (saved?.name) return saved;
  } catch {}
  const r = crypto.getRandomValues(new Uint8Array(2));
  const me = { name: `${ADJ[r[0] % ADJ.length]} ${ANIMAL[r[1] % ANIMAL.length]}` };
  try { localStorage.setItem('ashdrop.nearby', JSON.stringify(me)); } catch {}
  return me;
}
export function renameNearby(name) {
  const me = { name: String(name).replace(/[<>]/g, '').trim().slice(0, 32) || nearbyIdentity().name };
  try { localStorage.setItem('ashdrop.nearby', JSON.stringify(me)); } catch {}
  return me;
}
export function deviceType() {
  const ua = navigator.userAgent || '';
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Browser';
}

// 4 digits from both DTLS fingerprints, the same on both devices.
async function checkCode(pc) {
  const fp = (sdp) => (sdp?.match(/a=fingerprint:\S+ (\S+)/) || [])[1] || '';
  const both = [fp(pc.localDescription?.sdp), fp(pc.remoteDescription?.sdp)].sort().join('|');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(both)));
  return String(((h[0] << 8) | h[1]) % 10000).padStart(4, '0');
}

/**
 * Join the Nearby room. Callbacks:
 *   onPeers(peers)            visible devices on this network
 *   onIncoming(request)       { from, files, text, totalBytes, code, accept(), decline() }
 *   onStatus(status)          'connecting' | 'online' | 'offline'
 * Returns { setVisible, rename, send, close }.
 */
export function joinNearby({ visible = true, onPeers, onIncoming, onStatus }) {
  let ws = null, myId = null, closed = false, retry = 1000, state = { visible, ...nearbyIdentity() };
  const sessions = new Map(); // peerId -> { pc, dc, pending: [] }
  const signal = (to, data) => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'signal', to, data }));
  const hello = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'hello', name: state.name, device: deviceType(), visible: state.visible }));

  const connect = () => {
    if (closed) return;
    onStatus?.('connecting');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/nearby/ws`);
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'welcome') { myId = m.id; retry = 1000; hello(); onStatus?.('online'); }
      if (m.type === 'peers') onPeers?.(m.peers);
      if (m.type === 'signal') onSignal(m);
    };
    ws.onclose = () => { onStatus?.('offline'); onPeers?.([]); if (!closed) { setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); } };
  };

  const newPc = (peerId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const s = { pc, dc: null, pending: [] };
    pc.onicecandidate = (e) => e.candidate && signal(peerId, { candidate: e.candidate.toJSON() });
    sessions.set(peerId, s);
    return s;
  };

  async function onSignal(m) {
    const { from, data } = m;
    if (!data) return;
    let s = sessions.get(from);
    if (data.sdp?.type === 'offer') {
      if (s) { s.pc.close(); }
      s = newPc(from);
      s.pc.ondatachannel = (e) => receive(from, m, s, e.channel);
      await s.pc.setRemoteDescription(data.sdp);
      for (const c of s.pending.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
      await s.pc.setLocalDescription(await s.pc.createAnswer());
      signal(from, { sdp: s.pc.localDescription.toJSON() });
    } else if (data.sdp?.type === 'answer' && s) {
      await s.pc.setRemoteDescription(data.sdp);
      for (const c of s.pending.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate && s) {
      if (s.pc.remoteDescription) await s.pc.addIceCandidate(data.candidate).catch(() => {});
      else s.pending.push(data.candidate);
    }
  }

  // ---------- receiving ----------
  function receive(peerId, m, s, dc) {
    s.dc = dc; dc.binaryType = 'arraybuffer';
    let req = null, cur = -1, parts = [], got = 0, curGot = 0, out = [], text = null, handlers = {};
    const finish = () => { try { dc.close(); s.pc.close(); } catch {} sessions.delete(peerId); };
    dc.onmessage = async (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        if (msg.type === 'request') {
          req = msg;
          const code = await checkCode(s.pc);
          onIncoming?.({
            from: { id: peerId, name: m.name || 'A nearby device', device: m.device || '' },
            files: msg.files || [], text: !!msg.text, totalBytes: msg.totalBytes || 0, code,
            accept: (h = {}) => { handlers = h; dc.send(JSON.stringify({ type: 'accept' })); h.onProgress?.(0); },
            decline: () => { dc.send(JSON.stringify({ type: 'decline' })); setTimeout(finish, 200); },
          });
        } else if (msg.type === 'file') { cur = msg.i; parts = []; curGot = 0; }
        else if (msg.type === 'file-end') {
          const f = req.files[cur];
          if (curGot !== f.size) { handlers.onError?.('A file arrived incomplete.'); return finish(); }
          out.push({ name: f.name, mime: f.mime, size: f.size, blob: new Blob(parts, { type: f.mime || 'application/octet-stream' }) });
          parts = [];
        } else if (msg.type === 'text') { text = String(msg.text || ''); }
        else if (msg.type === 'done') {
          dc.send(JSON.stringify({ type: 'received' }));
          handlers.onDone?.({ files: out, text });
          setTimeout(finish, 500);
        } else if (msg.type === 'cancel') { handlers.onError?.('The sender cancelled.'); finish(); }
      } else {
        parts.push(e.data); got += e.data.byteLength; curGot += e.data.byteLength;
        handlers.onProgress?.(req.totalBytes ? got / req.totalBytes : 1);
      }
    };
    dc.onclose = () => { if (sessions.has(peerId)) { handlers.onError?.('The connection closed.'); sessions.delete(peerId); } };
  }

  // ---------- sending ----------
  /** Send files (File[]) and/or text to a peer. cb: onState(state, extra), onProgress(0..1). Returns cancel(). */
  function send(peer, { files = [], text = '' }, cb = {}) {
    const s = newPc(peer.id);
    const dc = s.pc.createDataChannel('ashdrop', { ordered: true });
    s.dc = dc; dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
    let done = false, cancelled = false;
    const end = (st, extra) => { if (done) return; done = true; cb.onState?.(st, extra); setTimeout(() => { try { dc.close(); s.pc.close(); } catch {} sessions.delete(peer.id); }, 500); };
    const timer = setTimeout(() => { if (dc.readyState !== 'open') end('failed', 'Could not connect directly. This network may block it; send a link instead.'); }, 20000);
    cb.onState?.('connecting');
    (async () => {
      await s.pc.setLocalDescription(await s.pc.createOffer());
      signal(peer.id, { sdp: s.pc.localDescription.toJSON() });
    })().catch(() => end('failed', 'Could not start the connection.'));
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    dc.onopen = async () => {
      clearTimeout(timer);
      cb.onState?.('waiting', { code: await checkCode(s.pc) });
      dc.send(JSON.stringify({ type: 'request', files: files.map((f) => ({ name: f.name, size: f.size, mime: f.type || '' })), text: !!text, totalBytes }));
    };
    const drain = () => new Promise((r) => { if (dc.bufferedAmount < HIGH_WATER) r(); else dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
    dc.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'decline') return end('declined');
      if (msg.type === 'received') return end('sent');
      if (msg.type !== 'accept') return;
      cb.onState?.('sending');
      let sent = 0;
      try {
        if (text) dc.send(JSON.stringify({ type: 'text', text }));
        for (let i = 0; i < files.length; i++) {
          dc.send(JSON.stringify({ type: 'file', i }));
          for (let at = 0; at < files[i].size; at += CHUNK) {
            if (cancelled || dc.readyState !== 'open') throw new Error('stopped');
            await drain();
            const buf = await files[i].slice(at, at + CHUNK).arrayBuffer();
            dc.send(buf); sent += buf.byteLength;
            cb.onProgress?.(totalBytes ? sent / totalBytes : 1);
          }
          dc.send(JSON.stringify({ type: 'file-end', i }));
        }
        await drain();
        dc.send(JSON.stringify({ type: 'done' }));
      } catch { end(cancelled ? 'cancelled' : 'failed', 'The connection dropped.'); }
    };
    dc.onclose = () => { clearTimeout(timer); if (!done) end('failed', 'The connection closed.'); };
    return () => { cancelled = true; try { dc.readyState === 'open' && dc.send(JSON.stringify({ type: 'cancel' })); } catch {} end('cancelled'); };
  }

  connect();
  return {
    setVisible: (v) => { state.visible = v; hello(); },
    rename: (name) => { state = { ...state, ...renameNearby(name) }; hello(); return state.name; },
    send,
    close: () => { closed = true; try { ws?.close(); } catch {} for (const s of sessions.values()) { try { s.pc.close(); } catch {} } sessions.clear(); },
  };
}
