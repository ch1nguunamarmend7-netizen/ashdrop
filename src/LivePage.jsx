// /s/<id>#<key>: the receiving end of a live transfer ("send in parts"). See lib/live.js.
import React, { useEffect, useRef, useState } from 'react';
import { Logo } from './App.jsx';
import { Footer } from './Legal.jsx';
import { fmtBytes } from './lib/crypto.js';
import { liveInfo, receiveLive } from './lib/live.js';

const save = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

export function LivePage({ id, keyStr }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(keyStr ? '' : 'This link is incomplete. It is missing the part after the #, which is the key. Ask the sender to copy the whole link.');
  const [phase, setPhase] = useState('loading'); // loading | ready | receiving | done | failed
  const [prog, setProg] = useState({ got: 0, total: 1, waiting: false });
  const [files, setFiles] = useState([]);
  const [toDisk, setToDisk] = useState(false);
  const ctl = useRef(null);

  const load = () => liveInfo(id, keyStr).then((i) => { setInfo(i); setPhase((p) => (p === 'loading' ? 'ready' : p)); }).catch((e) => { setErr(e.message); setPhase('failed'); });
  useEffect(() => { if (keyStr) load(); }, []);
  // while waiting to start, keep the status fresh (has the sender left? did it end?)
  useEffect(() => { if (phase !== 'ready') return; const t = setInterval(load, 4000); return () => clearInterval(t); }, [phase]);
  useEffect(() => { // leaving mid-transfer loses it
    if (phase !== 'receiving') return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const total = info ? info.size : 0;
  const one = info?.files.length === 1 ? info.files[0] : null;
  const big = total > 400 * 1024 * 1024;

  const receive = async () => {
    setErr('');
    let sink = null;
    // One big file on a browser that can write straight to disk (Chrome, Edge on a computer): no need to hold it in memory.
    if (one && typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: one.name });
        const w = await handle.createWritable();
        sink = { write: (b) => w.write(b), close: () => w.close() };
        setToDisk(true);
      } catch (e) { if (e?.name === 'AbortError') return; sink = null; } // picker closed: do nothing; picker failed: fall back to memory
    }
    setPhase('receiving');
    ctl.current = new AbortController();
    try {
      const r = await receiveLive(id, keyStr, info, { sink, signal: ctl.current.signal, onProgress: setProg });
      if (!sink) { setFiles(r.files); r.files.forEach((f, i) => setTimeout(() => save(f.blob, f.name), i * 400)); }
      setPhase('done');
    } catch (e) {
      if (sink) { try { await sink.close(); } catch {} }
      setErr(e.code === 'aborted' ? 'You cancelled the transfer.' : e.message); setPhase('failed');
    }
  };

  const pct = Math.round((prog.got / Math.max(1, prog.total)) * 100);
  const senderGone = (ago) => ago != null && ago > 20000;
  const ended = info && (info.state === 'done' || info.state === 'cancelled');
  const taken = info && info.claimed && phase === 'ready';

  return (
    <div className="min-h-full flex flex-col">
      <div className="relative gutter max-w-6xl w-full mx-auto py-3 flex items-center gap-3 border-b border-line">
        <a href="/" aria-label="Ashdrop home"><Logo /></a>
        <a href="/" className="press ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line text-mute hover:text-fg hover:border-mute transition-colors">Open Ashdrop</a>
      </div>
      <main className="flex-1 gutter py-10 sm:py-16">
        <div id="live-page" className="pop w-full max-w-xl mx-auto rounded-3xl border border-line bg-panel p-6 sm:p-8 flex flex-col gap-5">
          <div>
            <div className="label text-ember flex items-center gap-1.5"><span className={`touch-dot ${phase === 'receiving' || phase === 'ready' ? 'touch-dot-live' : ''}`} aria-hidden="true" />Live transfer</div>
            <h1 className="font-display text-[26px] sm:text-[30px] leading-tight mt-1">
              {phase === 'done' ? 'Received' : phase === 'receiving' ? 'Receiving…' : phase === 'failed' ? 'This transfer cannot continue' : 'Someone is sending you files'}
            </h1>
            {phase !== 'failed' && <p className="text-mute text-[14px] mt-2">Sent in encrypted parts straight from the sender's device. Ashdrop passes each part on and deletes it, so the files are never stored on a server.</p>}
          </div>

          {info && (
            <ul id="live-files" className="rounded-xl border border-line divide-y divide-line">
              {info.files.map((f, i) => (
                <li key={i} className="flex items-center gap-3 px-3.5 py-2.5 text-[13.5px]">
                  <span className="truncate flex-1 min-w-0">{f.name}</span>
                  <span className="text-mute shrink-0 tabular-nums">{fmtBytes(f.size)}</span>
                  {phase === 'done' && files[i] && <button onClick={() => save(files[i].blob, f.name)} className="press shrink-0 rounded-lg px-2.5 py-1 text-[12.5px] font-semibold border border-line hover:border-mute">Save again</button>}
                </li>
              ))}
            </ul>
          )}

          {phase === 'loading' && !err && <div className="text-mute text-[13px]">Checking the transfer…</div>}

          {phase === 'ready' && info && !ended && !taken && (<>
            {senderGone(info.senderAgo)
              ? <div className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5" role="status">The sender's Ashdrop tab does not seem to be open right now. Ask them to keep it open, then receive.</div>
              : <div className="text-[13px] text-ok flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />The sender is online and ready.</div>}
            <button id="live-receive" onClick={receive} className="press rounded-xl py-3.5 font-display font-bold text-[17px] btn-burn">Receive {fmtBytes(total)}</button>
            <p className="text-[12px] text-mute">Keep this page open until it finishes. Only one device can receive it.{big && !window.showSaveFilePicker ? ' This is a large transfer: on a phone, make sure you have enough free memory and stay on this page.' : ''}</p>
          </>)}
          {phase === 'ready' && taken && !ended && <div className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5" role="alert">This live transfer was already opened on another device.</div>}
          {phase === 'ready' && ended && <div className="rounded-xl border border-line text-mute text-[13px] px-3.5 py-2.5" role="status">{info.state === 'done' ? 'This transfer has already been delivered.' : 'The sender cancelled this transfer, or it timed out.'}</div>}

          {phase === 'receiving' && (
            <div className="flex flex-col gap-2">
              <div className="h-2 rounded-full bg-line overflow-hidden" aria-hidden="true"><div className="h-full rounded-full bg-ember transition-all duration-300" style={{ width: `${pct}%` }} /></div>
              <div id="live-progress" className="text-[13px] text-mute" role="status">
                {prog.waiting && senderGone(prog.senderAgo) ? 'Waiting for the sender. Their Ashdrop tab may be closed or asleep.' : `${pct}% · ${fmtBytes(Math.min(total, prog.got * 8 * 1024 * 1024))} of ${fmtBytes(total)}`}
              </div>
              <button id="live-stop" onClick={() => ctl.current?.abort()} className="self-start text-[12.5px] text-mute hover:text-ember">Cancel</button>
            </div>
          )}

          {phase === 'done' && (
            <div id="live-done" className="rounded-xl border border-ok/40 bg-ok/10 text-[13.5px] px-3.5 py-3">
              <span className="font-semibold text-ok">All of it arrived.</span>{' '}
              <span className="text-mute">{toDisk ? 'It was saved where you chose.' : 'Your browser is saving it to Downloads. Nothing is left on the server.'}</span>
            </div>
          )}

          {err && <div role="alert" className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5">{err}</div>}
          {(phase === 'failed' || phase === 'done') && <a href="/" className="press rounded-xl py-3 text-center font-semibold btn-primary">Send something with Ashdrop</a>}
        </div>
      </main>
      <Footer className="gutter pb-8 pt-2" />
    </div>
  );
}
