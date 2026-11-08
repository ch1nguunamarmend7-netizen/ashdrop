// /lab/touch: try the gestures for "Tap to send" on your own phone before the real feature is built.
// Everything stays on this phone: it only reads the motion sensor and draws it. Nothing is sent.
//
// Three gestures are told apart from the acceleration (gravity removed):
//   Touch       the phone moves, then stops gently against something (a laptop edge). A small jolt after motion.
//   Tap         the phone is tapped down on a desk. A big, sharp jolt.
//   Double-tap  two light taps on the back of the phone while it is held still, 0.1 to 0.45 s apart.
import React, { useEffect, useRef, useState } from 'react';
import { Logo } from './App.jsx';
import { watchTouch } from './lib/touch.js';

const BASE = { touch: 2.2, tap: 7.5, back: 2.0 }; // m/s², divided by the sensitivity
const LABEL = { touch: 'Touch', tap: 'Tap on desk', back: 'Double-tap back' };
const HINT = {
  touch: 'Move the phone to the laptop and let it meet the edge gently.',
  tap: 'Tap the phone down lightly on the desk.',
  back: 'Hold the phone still and tap its back twice with a finger.',
};

export function TouchLab() {
  const [state, setState] = useState('idle'); // idle | running | denied | unsupported
  const [sens, setSens] = useState(1);
  const [counts, setCounts] = useState({ touch: 0, tap: 0, back: 0 });
  const [flash, setFlash] = useState(null);
  const [log, setLog] = useState([]);
  const [rate, setRate] = useState(0);
  const [copied, setCopied] = useState(false);
  const [would, setWould] = useState(0); // what the real Touch to send would have done
  const [testing, setTesting] = useState('touch'); // which gesture you are trying right now, so the log can be read back
  const testingRef = useRef('touch'); testingRef.current = testing;
  const canvas = useRef(null);
  const sensRef = useRef(1);
  sensRef.current = sens;
  const audio = useRef(null);

  const fire = (kind, info) => {
    setCounts((c) => ({ ...c, [kind]: c[kind] + 1 }));
    setFlash({ kind, n: Date.now() });
    setLog((l) => [{ kind, ...info, test: testingRef.current, sens: sensRef.current, at: new Date().toLocaleTimeString() }, ...l].slice(0, 80));
    try { navigator.vibrate?.(kind === 'back' ? [25, 60, 25] : 35); } catch {}
    try {
      const ctx = audio.current; if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = kind === 'tap' ? 520 : kind === 'touch' ? 880 : 1180;
      g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.2);
    } catch {}
  };

  const start = async () => {
    if (typeof DeviceMotionEvent === 'undefined') { setState('unsupported'); return; }
    try { audio.current = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    if (typeof DeviceMotionEvent.requestPermission === 'function') { // iPhone asks once
      try { if ((await DeviceMotionEvent.requestPermission()) !== 'granted') { setState('denied'); return; } }
      catch { setState('denied'); return; }
    }
    setState('running');
  };

  useEffect(() => {
    if (state !== 'running') return;
    const hist = []; // { t, m }
    let g = null, pending = null, lastSpike = -1e9, n = 0, t0 = performance.now(), got = false;
    const quietBefore = (t, from, to) => { const s = hist.filter((h) => h.t > t - from && h.t < t - to); return s.length ? s.reduce((a, h) => a + h.m, 0) / s.length : 0; };
    const onMotion = (e) => {
      got = true;
      const t = performance.now(); n++;
      let x, y, z;
      if (e.acceleration && e.acceleration.x != null) ({ x, y, z } = e.acceleration);
      else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) { // remove gravity with a slow average
        const a = e.accelerationIncludingGravity; g = g ? { x: g.x * 0.9 + a.x * 0.1, y: g.y * 0.9 + a.y * 0.1, z: g.z * 0.9 + a.z * 0.1 } : { ...a };
        x = a.x - g.x; y = a.y - g.y; z = a.z - g.z;
      } else return;
      const m = Math.hypot(x, y, z);
      const ax = Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z) ? 'x' : Math.abs(y) >= Math.abs(z) ? 'y' : 'z'; // the direction of the jolt
      hist.push({ t, m }); while (hist.length && hist[0].t < t - 3000) hist.shift();
      const k = sensRef.current;
      // a spike: above the lowest threshold, and at least 90 ms after the last one (one jolt rings for a moment)
      const low = Math.min(BASE.touch, BASE.back) / k;
      // a jolt rings for a moment (about 100 ms on an iPhone), so a new spike needs 150 ms of space
      if (pending && t - pending.t < 150 && m > pending.m) { pending.m = m; pending.ax = ax; }
      if (m > low && t - lastSpike > 150) {
        lastSpike = t;
        const before = quietBefore(t, 450, 80); // how much the phone was moving just before
        const spike = { t, m, before, ax };
        if (pending && t - pending.t >= 150 && t - pending.t <= 500 && pending.before < 0.9 && before < 2.5 && pending.m < BASE.tap / k && m < BASE.tap / k) {
          fire('back', { peak: +Math.max(pending.m, m).toFixed(1), gap: Math.round(t - pending.t), before: +pending.before.toFixed(2), ax: pending.ax + ax });
          pending = null;
        } else pending = spike;
      }
      // a single spike becomes Tap or Touch once no second one followed
      if (pending && t - pending.t > 510) {
        const p = pending; pending = null;
        // how still the phone was right after (resting against the laptop vs. carrying on moving)
        const aft = hist.filter((h) => h.t > p.t + 150 && h.t < p.t + 500);
        const after = aft.length ? aft.reduce((a, h) => a + h.m, 0) / aft.length : 0;
        const info = { peak: +p.m.toFixed(1), before: +p.before.toFixed(2), after: +after.toFixed(2), ax: p.ax };
        if (p.m >= BASE.tap / k) fire('tap', info);
        // A gentle touch: your test showed the phone barely moves before it (slow approach), so no motion is required first.
        else if (p.m >= BASE.touch / k) fire('touch', info);
        else setLog((l) => [{ kind: 'ignored', ...info, test: testingRef.current, sens: sensRef.current, at: new Date().toLocaleTimeString() }, ...l].slice(0, 80));
      }
      if (t - t0 > 1000) { setRate(Math.round((n * 1000) / (t - t0))); n = 0; t0 = t; }
    };
    window.addEventListener('devicemotion', onMotion);
    const stopReal = watchTouch(() => { setWould((n) => n + 1); setLog((l) => [{ kind: 'would send', peak: '', before: '', test: testingRef.current, sens: 1, at: new Date().toLocaleTimeString() }, ...l].slice(0, 80)); });
    const noData = setTimeout(() => { if (!got) setState('unsupported'); }, 2500);
    // live graph
    let raf;
    const draw = () => {
      const c = canvas.current;
      if (c) {
        const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
        if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
        const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
        const max = 12, now = performance.now(), Y = (v) => h - (Math.min(v, max) / max) * (h - 8) - 4;
        const k = sensRef.current;
        for (const [key, col] of [['touch', '#6ec882'], ['tap', '#ff6a2b'], ['back', '#7aa7ff']]) {
          x.strokeStyle = col; x.globalAlpha = 0.5; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(0, Y(BASE[key] / k)); x.lineTo(w, Y(BASE[key] / k)); x.stroke();
        }
        x.setLineDash([]); x.globalAlpha = 1; x.strokeStyle = '#ece8e2'; x.lineWidth = 2; x.beginPath();
        hist.forEach((p, i) => { const px = w - ((now - p.t) / 3000) * w; i ? x.lineTo(px, Y(p.m)) : x.moveTo(px, Y(p.m)); });
        x.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { stopReal(); window.removeEventListener('devicemotion', onMotion); cancelAnimationFrame(raf); clearTimeout(noData); };
  }, [state]);

  const report = () => [
    `Ashdrop touch test · ${navigator.userAgent}`,
    `samples/s: ${rate} · sensitivity: ${sens}`,
    `counts: touch ${counts.touch}, tap ${counts.tap}, double-tap ${counts.back} · real rule would send: ${would}`,
    ...log.map((l) => `${l.at} trying=${l.test} got=${l.kind} peak=${l.peak}${l.gap ? ` gap=${l.gap}ms` : ''} before=${l.before} after=${l.after} axis=${l.ax} sens=${l.sens}`),
  ].join('\n');
  const copy = async () => { try { await navigator.clipboard.writeText(report()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-line">
        <div className="gutter max-w-6xl mx-auto py-3 flex items-center gap-3"><a href="/" aria-label="Ashdrop home"><Logo /></a><span className="ml-auto text-[12px] text-mute">Lab · nothing is sent</span></div>
      </header>
      <main className="gutter max-w-xl mx-auto w-full py-8 flex flex-col gap-5">
        <div>
          <h1 className="font-display text-[28px] font-bold leading-tight">Touch test</h1>
          <p className="text-mute text-[14px] mt-2">Try the gestures for "Tap to send" on your phone. This page only reads the motion sensor and shows what it feels. Nothing leaves this phone.</p>
        </div>

        {state === 'idle' && <button id="lab-start" onClick={start} className="press rounded-xl py-3.5 font-display font-bold text-[17px] btn-burn">Start</button>}
        {state === 'denied' && <p className="rounded-xl border border-warn/50 text-warn text-[13.5px] p-3">Motion access was not allowed. On iPhone, close this tab, open it again and tap Allow.</p>}
        {state === 'unsupported' && <p className="rounded-xl border border-warn/50 text-warn text-[13.5px] p-3">No motion data from this device. Open this page on your phone (in Chrome or Safari).</p>}

        {state === 'running' && <>
          <div className="grid grid-cols-3 gap-2">
            {['touch', 'tap', 'back'].map((k) => (
              <div key={k + (flash?.kind === k ? flash.n : '')} className={`rounded-2xl border p-3 text-center ${flash?.kind === k ? 'border-ember bg-ember/15 pop' : 'border-line bg-panel'}`}>
                <div className="text-[12.5px] font-semibold">{LABEL[k]}</div>
                <div className="font-display text-[30px] font-bold">{counts[k]}</div>
              </div>
            ))}
          </div>
          <div id="lab-would" className="rounded-2xl border border-ember/50 bg-ember/10 px-4 py-3 flex items-center justify-between text-[13.5px]"><span><span className="font-semibold">Touch to send would have sent:</span> <span className="text-mute">the real, tuned rule</span></span><span className="font-display text-[22px] font-bold">{would}</span></div>
          <div className="rounded-2xl border border-line bg-panel p-3">
            <canvas ref={canvas} className="w-full h-40 block" aria-label="Live motion graph" />
            <div className="flex justify-between text-[11.5px] text-mute mt-2"><span>Live movement · last 3 s</span><span>{rate} samples/s</span></div>
          </div>
          <label className="flex items-center gap-3 text-[13px]">
            <span className="text-mute shrink-0">Sensitivity</span>
            <input type="range" min="0.5" max="2" step="0.1" value={sens} onChange={(e) => setSens(+e.target.value)} style={{ '--pct': `${((sens - 0.5) / 1.5) * 100}%` }} className="flex-1" />
            <span className="w-10 text-right">{sens.toFixed(1)}×</span>
          </label>
<div className="rounded-2xl border border-line bg-panel p-4 flex flex-col gap-3">
            <div className="text-[13px] font-semibold">What are you trying now?</div>
            <div className="grid grid-cols-2 gap-2">
              {[...['touch', 'tap', 'back'].map((k) => [k, LABEL[k]]), ['none', 'Nothing (false alarms)']].map(([k, l]) => (
                <button key={k} id={`lab-try-${k}`} onClick={() => setTesting(k)} className={`press rounded-lg px-3 py-2 text-[12.5px] font-semibold border ${testing === k ? 'border-ember text-fg bg-ember/10' : 'border-line text-mute'}`}>{l}</button>
              ))}
            </div>
            <p className="text-[13px] text-mute">{testing === 'none' ? 'Walk around, pick the phone up, put it down normally, put it in a pocket. Anything that counts now would have sent by accident.' : HINT[testing] + ' Do it 5 times, a few seconds apart.'}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between"><span className="label">What it felt</span><button onClick={copy} className="press rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line">{copied ? 'Copied' : 'Copy results'}</button></div>
            <ul className="text-[12px] font-mono text-mute flex flex-col gap-0.5 max-h-56 overflow-auto">
              {log.length ? log.map((l, i) => <li key={i} className={l.kind === 'ignored' ? 'opacity-60' : 'text-fg'}>{l.at} · trying {l.test === 'none' ? 'nothing' : LABEL[l.test]?.toLowerCase()} → {l.kind === 'ignored' ? 'ignored' : l.kind === 'would send' ? 'WOULD SEND' : LABEL[l.kind]} · peak {l.peak}{l.gap ? ` · ${l.gap} ms apart` : ''} · moving before {l.before}</li>) : <li>Nothing yet. Try a gesture.</li>}
            </ul>
          </div>
        </>}
      </main>
    </div>
  );
}
