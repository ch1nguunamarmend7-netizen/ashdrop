
import React, { useState, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import qrcode from 'qrcode-generator';
import { enc, hex, fmtBytes, sealPayload, derivePasswordKeys, pack, unpack, openPayload } from './lib/crypto.js';
import { createLink, getMeta, openLink, revokeLink, linkStatus, lookupCode } from './lib/api.js';
import { generateCode, parseCode, sealCode, openCode, CODE_WORDS } from './lib/code.js';
import { bundleFiles, unbundleFiles, makeZip, MAX_FILES, MAX_TOTAL, OWNER_MAX_TOTAL } from './lib/bundle.js';
import { getOwnerKey, saveOwnerKey, clearOwnerKey } from './lib/owner.js';
import { joinNearby, nearbyIdentity, deviceType } from './lib/nearby.js';
import * as account from './lib/account.js';
import * as vault from './lib/vault.js';
import { getDevice, hasDevice, renameDevice, defaultDeviceName, getPeers, removePeer, startPairing, joinPairing, cancelPairing, sendToPeer, listenInbox, ackInbox, hasPendingPairing, touchSignal } from './lib/devices.js';
import { watchTouch, askMotion, motionSupported } from './lib/touch.js';
import * as linkStore from './lib/linkStore.js';
import * as myLinks from './lib/myLinks.js';
import { Footer } from './Legal.jsx';

// Features that are designed but not built on the server yet. Each stays hidden until it is real.
//   pro:      paid plans, upgrade prompts and the subscription settings (needs Stripe)
//   accounts: sign in / sign out (needs an auth service)
//   recovery: the vault recovery key (needs accounts and server-side vault storage)
//   vaultFiles: storing files in the vault (needs server-side vault storage; today files only live in the tab)
//   cloudVault: the real, server-backed encrypted vault with accounts (invite-only while in beta)
export const FEATURES = { pro: false, accounts: false, recovery: false, vaultFiles: false, cloudVault: true };

// Saves a file through the browser's normal download flow.
const browserDownloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { status: 'saved' };
  },
};

const randId = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(6)); return Array.from(r, x => a[x % a.length]).join(''); };

const timeLeft = (ms) => {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h >= 1 ? `${h}h ${m % 60}m` : m >= 1 ? `${m}m` : `${Math.ceil(ms / 1000)}s`;
};
const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

/* ---------- static data ---------- */
const LANGS = ['Plain text','JavaScript','TypeScript','Python','Go','Rust','Bash','JSON','YAML','SQL','Markdown'];
const EXPIRY = [
  { id: 'burn', label: 'Burn after 1 view', sub: 'Deleted the moment it is opened' },
  { id: '1h', label: '1 hour', sub: 'Then purged from storage' },
  { id: '24h', label: '24 hours', sub: 'Free tier maximum' },
  { id: '7d', label: '7 days', sub: 'Owner only', owner: true },
];
const EXPIRY_TONE = { burn: 'var(--ember)', '1h': 'var(--violet)', '24h': 'var(--cyan)', '7d': 'var(--gold)' };
const SAMPLE = `# .env.production — rotate after sharing
DATABASE_URL=postgres://deploy:••••••@db.internal:5432/app
STRIPE_WEBHOOK_SECRET=whsec_example_not_real
SENTRY_DSN=https://example@o0.ingest.sentry.io/0

# Paste anything here. It is encrypted in this tab
# before a single byte is sent.`;

/* ---------- motion helpers ---------- */
let SPEED = 1; // set from Settings: 0 = off
let PERF = false; // Performance mode: no motion, no blur or glow, slower background refreshes
const reduceMotion = () => { if (SPEED === 0) return true; try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const dur = (ms) => (reduceMotion() ? 0 : ms * SPEED);
const tint = (c) => `color-mix(in srgb, ${c} var(--tint), var(--fg))`;
function useTween(value, ms = 600, initial = value) {
  const [v, setV] = useState(initial);
  const cur = useRef(initial);
  useEffect(() => {
    const a = cur.current, b = value;
    if (a === b) return;
    if (reduceMotion()) { cur.current = b; setV(b); return; }
    const start = performance.now(), total = ms * SPEED; let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / total), e = 1 - Math.pow(1 - p, 3);
      cur.current = a + (b - a) * e; setV(cur.current);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return v;
}
const SCRAMBLE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
function Scramble({ text, ms = 900 }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (reduceMotion()) { setOut(text); return; }
    const start = performance.now(), total = ms * SPEED; let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / total), fixed = Math.floor(p * text.length);
      setOut(text.slice(0, fixed) + Array.from(text.slice(fixed), () => SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]).join(''));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return out;
}

/* ---------- small UI parts ---------- */
/* The logo flame: three layers that flicker out of step, a breathing glow and a few rising sparks.
   Performance mode and "motion off" freeze it into a still flame. */
export const Logo = () => {
  const uid = React.useId().replace(/:/g, '');
  return (
    <div className="logo flex items-center gap-2.5 shrink-0">
      <span className="relative w-[26px] h-[26px] shrink-0" aria-hidden="true">
        <span className="logo-glow" />
        <svg width="26" height="26" viewBox="0 0 26 26" className="relative overflow-visible">
          <defs>
            <linearGradient id={`fo-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff4d1a" /><stop offset="60%" stopColor="#ff7a3d" /><stop offset="100%" stopColor="#ffa24a" />
            </linearGradient>
            <linearGradient id={`fm-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff9a3d" /><stop offset="100%" stopColor="#ffd27a" />
            </linearGradient>
          </defs>
          <path className="flame-outer" fill={`url(#fo-${uid})`}
            d="M13 2c3.5 4 6.5 7 6.5 12a6.5 6.5 0 0 1-13 0c0-2.4 1-4.3 2.4-6 .3 2 1.3 3.2 2.6 3.6C11 8 11.6 5 13 2z" />
          <path className="flame-mid" fill={`url(#fm-${uid})`}
            d="M13 8.2c2 2.5 3.8 4.5 3.8 7.2a3.8 3.8 0 0 1-7.6 0c0-1.5.7-2.6 1.5-3.5.2 1.1.8 1.8 1.5 2C12.2 12.2 12.4 10.2 13 8.2z" />
          <path className="flame-core" fill="#fff3c4" d="M13 12.6c1 1.3 1.9 2.4 1.9 3.6a1.9 1.9 0 0 1-3.8 0c0-1.2.9-2.3 1.9-3.6z" />
          <circle className="logo-spark s1" cx="11.2" cy="5" r=".75" fill="#ffd27a" />
          <circle className="logo-spark s2" cx="14.8" cy="4" r=".6" fill="#ffb347" />
          <circle className="logo-spark s3" cx="13" cy="3" r=".5" fill="#fff3c4" />
        </svg>
      </span>
      <span className="font-display text-[19px] tracking-tight max-[420px]:sr-only">Ashdrop</span>
    </div>
  );
};

function Toggle({ on, onChange, id, label }) {
  return (
    <button id={id} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors ${on ? 'fill-on' : 'bg-line'}`}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-fg transition-transform duration-300 ${on ? 'translate-x-5' : ''}`} style={{ transitionTimingFunction: 'var(--ease-spring)' }} />
    </button>
  );
}

const ModalCtx = React.createContext(null);
function Modal({ onClose, children, labelledBy }) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const close = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true; setClosing(true);
    setTimeout(onClose, dur(180));
  }, [onClose]);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [close]);
  return (
    <ModalCtx.Provider value={close}>
      <div className={`fixed inset-0 z-50 scrim ${closing ? 'closing' : ''} flex items-end sm:items-center justify-center gutter py-6 overflow-y-auto`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className="pop w-full max-w-lg bg-panel border border-line rounded-2xl p-5 sm:p-6 my-auto">
          {children}
        </div>
      </div>
    </ModalCtx.Provider>
  );
}

function CloseBtn({ className }) {
  const close = React.useContext(ModalCtx);
  return <button onClick={close} className={`${className} transition-transform hover:rotate-90 duration-300`} aria-label="Close">✕</button>;
}

/* QR code: always dark modules on white, whatever the theme, so phone cameras read it. */
function QR({ text, size = 200, className = '' }) {
  const qr = useMemo(() => {
    try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q; } catch { return null; }
  }, [text]);
  if (!qr) return <div className="text-[12.5px] text-warn">Could not draw a QR code for this link. Copy the link instead.</div>;
  const n = qr.getModuleCount(), q = 4, total = n + q * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  return (
    <svg viewBox={`0 0 ${total} ${total}`} width={size} height={size} className={`rounded-xl max-w-full ${className}`} role="img" aria-label="QR code for the secure link" shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#0d0f12" />
    </svg>
  );
}

const FLAME_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22c4 0 7-2.7 7-6.8 0-3.4-2.3-5.6-4-7.7-.6 1.9-1.6 3-2.8 3.5C12.6 7.6 11 4.5 8.5 2.5 8.6 6.8 5 9.4 5 14.5 5 19 8.1 22 12 22z"/></svg>;
const LOCK_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>;
const FILE_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>;
const LINK_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>;
const KEYBOARD_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>;
const WORD_COLORS = ['var(--ember)', 'var(--pink)', 'var(--violet)', 'var(--cyan)'];

/* The 4 words of a typeable code, each in its own color so they are easy to read out loud. */
function CodeWords({ code, size = 'lg' }) {
  return (
    <div className={`flex flex-wrap justify-center ${size === 'lg' ? 'gap-2' : 'gap-1.5'}`} aria-label={`Code: ${code.split('-').join(' ')}`}>
      {code.split('-').map((w, i) => (
        <span key={i} style={{ '--t1': WORD_COLORS[i % 4] }}
          className={`tone-chip border rounded-lg font-mono font-semibold ${size === 'lg' ? 'text-[17px] sm:text-[19px] px-3 py-1.5' : 'text-[12px] px-2 py-0.5'}`}>
          <span className="opacity-60 font-normal text-[0.7em] mr-1">{i + 1}</span>{w}
        </span>
      ))}
    </div>
  );
}

/* Shown after creating a link with a code. */
function CodeCard({ code, password }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(code.split('-').join(' ')); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {} };
  return (
    <div id="code-card" className="tone-top mt-3 rounded-xl bg-well border border-line p-4 flex flex-col items-center gap-3 text-center" style={{ '--t1': 'var(--gold)', '--t2': 'var(--ok)' }}>
      <div className="label flex items-center gap-1.5"><span className="text-gold">{KEYBOARD_ICON}</span>Or open it with this code</div>
      <CodeWords code={code} />
      <div className="text-[12.5px] text-mute max-w-sm">On the other device, go to <span className="font-mono text-fg">{location.host}/code</span> and type these 4 words. The first 4 letters of each word are enough.{password && ' The password is still needed.'}</div>
      <button onClick={copy} className="press rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold border border-line hover:border-mute transition-colors">{copied ? 'Copied' : 'Copy code'}</button>
    </div>
  );
}

const QR_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M17 21h4v-4M14 21v-3"/></svg>;

/* A big, bright QR code that fills the screen, for scanning across a table or a room.
   Always dark on white (whatever the theme) so cameras read it; keeps the screen awake while open. */
function QRFullscreen({ link, burn, onClose }) {
  const box = useRef(null);
  useEffect(() => {
    let lock = null;
    try { navigator.wakeLock?.request('screen').then(l => { lock = l; }).catch(() => {}); } catch {}
    try { box.current?.requestFullscreen?.().catch(() => {}); } catch {}
    // Capture Escape first so it closes only this screen, not the window underneath.
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('keydown', esc, true);
      try { lock?.release(); } catch {}
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
    };
  }, []);
  return createPortal(
    <div ref={box} role="dialog" aria-modal="true" aria-label="QR code for the secure link"
      className="fixed inset-0 z-[80] bg-white text-[#0d0f12] flex flex-col items-center justify-center gap-5 gutter fade-in"
      style={{ paddingTop: 'max(16px, env(safe-area-inset-top, 0px))', paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}>
      <button id="qr-full-close" onClick={onClose} aria-label="Close"
        className="absolute rounded-full w-11 h-11 grid place-items-center text-[20px] bg-[#0d0f12]/5 hover:bg-[#0d0f12]/10 transition-colors"
        style={{ top: 'calc(14px + env(safe-area-inset-top, 0px))', right: 'calc(14px + env(safe-area-inset-right, 0px))' }}>✕</button>
      <div className="font-display text-[22px] sm:text-[26px] font-bold text-center">Scan with your phone camera</div>
      <div style={{ width: 'min(82vw, 66vh)' }}><QR text={link} size="100%" className="!rounded-2xl" /></div>
      {LOCAL_ONLY && <div className="text-[13px] font-semibold text-center max-w-sm text-[#a96a0f]">This code points to {location.host}, which only works on this computer. Use the tunnel address to test on a phone.</div>}
      <div className="text-[14px] text-center max-w-sm text-[#0d0f12]/70">
        {burn ? 'The first scan uses up this link. Anyone who scans or photographs this screen can open it.' : 'Anyone who scans or photographs this screen can open the link until it expires.'}
      </div>
    </div>,
    document.body
  );
}

/* Links are built from the address this page was opened on. 127.0.0.1 / localhost mean "this
   computer", so a link or QR code made there cannot open on any other device. */
const LOCAL_ONLY = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
function LocalOnlyNote({ className = '' }) {
  if (!LOCAL_ONLY) return null;
  return (
    <div role="note" className={`rounded-xl border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-warn ${className}`}>
      <span className="font-semibold">This link only works on this computer.</span> It points to {location.host}, which your
      phone cannot reach. To test on your phone, open Ashdrop through the tunnel address (press <span className="font-mono">t</span> in
      the wrangler window) and make the link there. Once the site is deployed, this goes away.
    </div>
  );
}

/* ---------- open with a code (ashdrop.cc/code) ---------- */
export function CodePage() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [shakeKey, setShakeKey] = useState(0);
  const { words, code } = parseCode(input);
  const slots = Array.from({ length: CODE_WORDS }, (_, i) => words[i] || null);
  const tooMany = words.length > CODE_WORDS;

  const submit = async (e) => {
    e.preventDefault();
    if (!code || busy) return;
    if (!crypto?.subtle) { setMsg('This browser does not expose Web Crypto here. Open the page over HTTPS.'); return; }
    setBusy(true); setMsg('');
    try {
      const { lookup, unwrap } = await openCode(code);
      const r = await lookupCode(lookup);
      if (r.status === 'ok') {
        const key = await unwrap(r.wrapped, r.wrapIv);
        // Same hand-off as a link: the key goes into this tab's sessionStorage, never into the address bar.
        try { sessionStorage.setItem(`ashdrop.k.${r.id}`, key); } catch {}
        location.assign(`/p/${r.id}`);
        return;
      }
      setShakeKey(k => k + 1);
      setMsg(r.status === 'rate_limited' ? 'Too many tries from this network. Wait a minute, then try again.'
        : r.status === 'gone' ? `That code belonged to a link that is gone (${GONE_WHY[r.reason] || 'no longer available'}). Ask the sender for a new one.`
        : 'No live link has that code. Check the words. It may also have expired or already been opened.');
    } catch (err) { setMsg('Could not open it: ' + err.message); }
    setBusy(false);
  };

  return (
    <div className="min-h-full flex flex-col">
      <div className="relative gutter max-w-6xl w-full mx-auto py-3 flex items-center gap-3 border-b border-line">
        <a href="/" aria-label="Ashdrop home"><Logo /></a>
        <a href="/" className="press ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line text-mute hover:text-fg hover:border-mute transition-colors">Send your own secret</a>
      </div>
      <main className="flex-1 gutter py-10 sm:py-16">
        <form key={shakeKey} onSubmit={submit} className={`pop tone-top relative w-full max-w-xl mx-auto rounded-3xl border border-line bg-panel p-6 sm:p-8 flex flex-col gap-5 ${shakeKey ? 'shake' : ''}`}
          style={{ '--t1': 'var(--gold)', '--t2': 'var(--ok)' }}>
          <div className="flex flex-col items-center text-center gap-3">
            <span className="tone-icon w-14 h-14 rounded-2xl grid place-items-center" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>
            </span>
            <h1 className="font-display text-[28px] sm:text-[34px] leading-tight">Open with a code</h1>
            <p className="text-mute text-[13.5px] max-w-sm">In order, with spaces or dashes. The first 4 letters of each word are enough.</p>
          </div>
          <div>
            <label htmlFor="code-input" className="sr-only">Code</label>
            <input id="code-input" autoFocus={FINE_POINTER} value={input} onChange={(e) => { setInput(e.target.value); setMsg(''); }}
              placeholder="e.g. tiger orbit lamp river" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
              className="w-full bg-well border border-line rounded-xl px-4 py-3.5 font-mono text-[16px] outline-hidden focus:border-mute text-center" />
            <div className="grid grid-cols-4 gap-1.5 mt-3" aria-live="polite">
              {slots.map((w, i) => (
                <span key={i} style={{ '--t1': w?.word ? WORD_COLORS[i] : 'var(--warn)' }}
                  className={`h-9 rounded-lg border font-mono text-[12.5px] grid place-items-center truncate px-1 transition-colors duration-300 ${!w ? 'border-dashed border-line text-mute' : 'tone-chip'}`}>
                  {!w ? i + 1 : w.word ? w.word : `${w.typed}?`}
                </span>
              ))}
            </div>
            {tooMany && <div className="text-[12px] text-warn mt-2">That is more than 4 words.</div>}
            {words.some(w => !w.word) && !tooMany && <div className="text-[12px] text-warn mt-2">A word with a ? is not in the list. Check its spelling.</div>}
          </div>
          {msg && <div role="alert" className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5">{msg}</div>}
          <button id="code-open" disabled={!code || busy} className="press rounded-xl py-3.5 font-display font-bold text-[16px] btn-primary disabled:opacity-50 flex items-center justify-center gap-2">
            {busy ? <><span className="w-4 h-4 rounded-full border-2 border-[#111317] border-t-transparent animate-spin" />Finding it…</> : 'Open'}
          </button>
          <p className="text-[12px] text-mute text-center">Your browser turns the words into a lookup value and a key. The words themselves never leave this device, and nothing is opened until you confirm on the next screen.</p>
        </form>
      </main>
      <Footer className="gutter pb-8 pt-2" />
    </div>
  );
}
const GONE_WHY = { burned: 'already opened', revoked: 'cancelled by the sender', expired: 'expired', locked: 'locked after wrong passwords', removed: 'removed' };

/* ---------- your devices ---------- */
const DEVICE_ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="13" height="10" rx="1.5"/><path d="M5 18h7"/><rect x="17" y="8" width="5" height="12" rx="1.2"/></svg>;

/* Shown on the device that starts pairing: 4 words and a QR code for the other device. */
function PairModal({ onClose, onPaired }) {
  const [state, setState] = useState({ phase: 'starting' });
  const [mode, setMode] = useState('show'); // show: this device shows the words · enter: type the other device's words
  const ctlRef = useRef(null);
  const joined = (peer) => { // paired the other way round: stop offering our own words
    ctlRef.current?.abort();
    if (state.words) cancelPairing(state.words);
    setState({ phase: 'done', peer }); onPaired?.(peer);
  };
  useEffect(() => {
    const ctl = new AbortController(); ctlRef.current = ctl;
    (async () => {
      try {
        const { words, wait } = await startPairing({ signal: ctl.signal });
        if (ctl.signal.aborted) { cancelPairing(words); return; }
        setState({ phase: 'waiting', words });
        const peer = await wait();
        setState({ phase: 'done', peer });
        onPaired?.(peer);
      } catch (e) {
        if (e.message !== 'cancelled') setState({ phase: 'error', msg: e.message === 'expired' ? 'Nobody joined within 10 minutes. Start again when the other device is ready.' : e.message });
      }
    })();
    return () => ctl.abort();
  }, []);
  const url = state.words ? `${location.origin}/pair#${state.words}` : '';
  return (
    <Modal onClose={onClose} labelledBy="pair-title">
      <div className="flex items-start justify-between gap-4">
        <h2 id="pair-title" className="font-display text-2xl">Pair a device</h2>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      {state.phase !== 'done' && (
        <div className="mt-3"><Seg id="pair-mode" label="How to pair" value={mode} onChange={setMode}
          options={[{ v: 'show', label: 'Show a code' }, { v: 'enter', label: 'Enter a code' }]} /></div>
      )}
      {mode === 'enter' && state.phase !== 'done' && (
        <div id="pair-enter" className="mt-4 flex flex-col gap-3">
          <p className="text-mute text-[13.5px]">On your other device, open Ashdrop, tap <span className="text-fg font-semibold">Pair a device</span>, and type the 4 words it shows here.</p>
          <PairJoinForm onJoined={joined} />
        </div>
      )}
      {mode === 'show' && state.phase === 'starting' && <p className="text-mute text-[13.5px] mt-3">Preparing…</p>}
      {mode === 'show' && state.phase === 'waiting' && (
        <div id="pair-waiting" className="mt-3 flex flex-col gap-4">
          <p className="text-mute text-[13.5px]">On the other device, scan this code with the camera, or open <span className="font-mono text-fg">{location.host}/pair</span> and type the words.</p>
          <div className="flex justify-center"><QR text={url} size={190} /></div>
          <CodeWords code={state.words} />
          <div className="flex items-center justify-center gap-2 text-[12.5px] text-mute">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-mute border-t-transparent animate-spin" aria-hidden="true" />Waiting for the other device. The words work for 10 minutes.
          </div>
          <LocalOnlyNote />
        </div>
      )}
      {state.phase === 'done' && (
        <div id="pair-done" className="mt-4 flex flex-col gap-3">
          <p className="text-[14px]">Paired with <span className="font-semibold">{state.peer.name}</span>.</p>
          <p className="text-mute text-[13px]">After you create a link on either device, send it to the other one with a single tap. It opens there right away if Ashdrop is open, or waits in its inbox.</p>
          <button onClick={onClose} className="press mt-1 rounded-lg py-2.5 font-semibold btn-primary">Done</button>
        </div>
      )}
      {mode === 'show' && state.phase === 'error' && <div role="alert" className="mt-4 rounded-lg border border-warn/40 bg-warn/10 text-warn text-[13px] px-3 py-2.5">{state.msg}</div>}
    </Modal>
  );
}

/* After a link is created: one tap sends it to a paired device. */
function SendToDevices({ result, onPair }) {
  const [peers] = useState(getPeers);
  const [status, setStatus] = useState({});
  const send = async (p) => {
    setStatus(s => ({ ...s, [p.inboxId]: 'sending' }));
    try {
      await sendToPeer(p, { id: result.id, keyStr: result.keyStr, label: result.label, kind: result.kind, expiry: result.expiry, expiresAt: result.expiresAt, password: !!result.password });
      setStatus(s => ({ ...s, [p.inboxId]: 'sent' }));
    } catch (e) { setStatus(s => ({ ...s, [p.inboxId]: e.message })); }
  };
  return (
    <div id="send-devices" className="mt-3 rounded-xl border border-line p-3.5">
      <div className="text-[13px] font-semibold flex items-center gap-2"><span className="text-mute">{DEVICE_ICON}</span>Send to your devices</div>
      {peers.length === 0 ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12.5px] text-mute">Pair your phone or computer once, then send links to it with one tap.</span>
          <button id="pair-from-result" onClick={onPair} className="press rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line hover:border-mute transition-colors">Pair a device</button>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {peers.map(p => {
            const st = status[p.inboxId];
            return (
              <button key={p.inboxId} id={`send-${p.inboxId}`} onClick={() => send(p)} disabled={st === 'sending' || st === 'sent'}
                className={`press inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium border transition-colors ${st === 'sent' ? 'border-ok/50 text-ok' : 'border-line hover:border-mute'}`}>
                {st === 'sending' ? <span className="w-3.5 h-3.5 rounded-full border-2 border-mute border-t-transparent animate-spin" aria-hidden="true" /> : st === 'sent' ? <span aria-hidden="true">✓</span> : null}
                {st === 'sent' ? `Sent to ${p.name}` : `Send to ${p.name}`}
              </button>
            );
          })}
        </div>
      )}
      {peers.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button id="send-all" onClick={() => peers.forEach(p => !status[p.inboxId] && send(p))} disabled={peers.every(p => status[p.inboxId])}
            className="press rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line hover:border-mute disabled:opacity-50">Send to all {peers.length}</button>
          {result.expiry === 'burn' && <span className="text-[11.5px] text-mute">This link opens once, so only the first device to open it will see it. To give each device its own copy, use "All devices" on the Share screen before creating the link.</span>}
        </div>
      )}
      {Object.values(status).filter(v => v && !['sending', 'sent'].includes(v)).map((m, i) => <div key={i} role="alert" className="mt-2 text-[12.5px] text-warn">{m}</div>)}
    </div>
  );
}

/* Touch to send, phone side: arm it, then touch the phone to the computer that is showing "Touch here". */
const TOUCH_MS = 60000;
function TouchSend({ peersVersion, onSend, disabled }) {
  const [peers, setPeers] = useState(getPeers);
  useEffect(() => setPeers(getPeers()), [peersVersion]);
  const [armed, setArmed] = useState(null); // { until }
  const [present, setPresent] = useState([]); // devices showing "Touch here", newest first
  const [msg, setMsg] = useState('');
  const presentRef = useRef([]); presentRef.current = present;
  const sendRef = useRef(onSend); sendRef.current = onSend;
  const stopAll = (except) => peers.filter(p => p.inboxId !== except).forEach(p => touchSignal(p, 'off', Date.now() + 30000));
  const disarm = (except) => { setArmed(null); setPresent([]); stopAll(except); };
  useEffect(() => {
    if (!armed) return;
    const onHere = (e) => { const s = e.detail; setPresent(ps => [s, ...ps.filter(p => p.from !== s.from)]); setMsg(''); };
    window.addEventListener('ashdrop-touch-here', onHere);
    const stop = watchTouch(() => {
      const target = presentRef.current[0];
      const peer = target && peers.find(p => p.inboxId === target.from);
      try { navigator.vibrate?.(40); } catch {}
      if (!peer) { setMsg('Felt the touch, but no computer has Ashdrop open yet. Open ashdrop.cc on it.'); return; }
      setArmed(null); setPresent([]); stopAll(peer.inboxId);
      sendRef.current(peer);
    });
    const end = setTimeout(() => { disarm(); setMsg(''); }, Math.max(0, armed.until - Date.now()));
    return () => { window.removeEventListener('ashdrop-touch-here', onHere); stop(); clearTimeout(end); };
  }, [armed]);
  const armedRef = useRef(null); armedRef.current = armed;
  useEffect(() => () => { if (armedRef.current) stopAll(); }, []); // leaving the page while armed
  if (FINE_POINTER || !motionSupported() || !peers.length) return null;
  const arm = async () => {
    setMsg('');
    if (!(await askMotion())) { setMsg('Motion access is needed to feel the touch. Reload the page and tap Allow.'); return; }
    const until = Date.now() + TOUCH_MS;
    peers.forEach(p => touchSignal(p, 'ready', until));
    setPresent([]); setArmed({ until });
  };
  if (!armed) return (
    <div className="flex flex-col gap-1.5">
      <button id="touch-arm" onClick={arm} disabled={disabled} className="press rounded-2xl border border-line bg-panel px-4 py-3 flex items-center gap-3 text-left hover:border-mute disabled:opacity-50">
        <span className="touch-dot shrink-0" aria-hidden="true" />
        <span className="flex-1"><span className="block text-[14px] font-semibold">Touch to send</span><span className="block text-[12.5px] text-mute">Then touch your phone's edge to your computer.</span></span>
      </button>
      {msg && <div role="alert" className="text-[12.5px] text-warn">{msg}</div>}
    </div>
  );
  return (
    <div id="touch-armed" ref={(el) => { if (el && !el.dataset.seen) { el.dataset.seen = '1'; el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } }} className="rounded-2xl border border-ember/60 bg-ember/10 px-4 py-4 flex flex-col gap-2 pop" role="status">
      <div className="flex items-center gap-3">
        <span className="touch-dot touch-dot-live shrink-0" aria-hidden="true" />
        <span className="flex-1 text-[15px] font-semibold">Touch your phone to your computer</span>
        <button id="touch-cancel" onClick={() => { disarm(); setMsg(''); }} className="text-[12.5px] text-mute hover:text-fg">Cancel</button>
      </div>
      <p className="text-[12.5px] text-mute">{present.length ? <>Ready on <span className="text-fg font-semibold">{present[0].fromName}</span>. Touch it gently with the top or side edge of your phone.</> : 'Waiting for a paired computer with Ashdrop open…'}</p>
      {msg && <div role="alert" className="text-[12.5px] text-warn">{msg}</div>}
    </div>
  );
}

/* Touch to send, computer side: a glowing target at the top of the screen while a paired phone is ready. */
function TouchTarget({ name, onClose }) {
  return (
    <div id="touch-target" className="fixed top-0 left-1/2 -translate-x-1/2 z-[70] pointer-events-none flex flex-col items-center" role="status">
      <div className="touch-glow" aria-hidden="true" />
      <div className="pointer-events-auto mt-[76px] rounded-full border border-ember bg-panel/95 px-4 py-2 flex items-center gap-2.5 shadow-2xl pop">
        <span className="touch-dot touch-dot-live" aria-hidden="true" />
        <span className="text-[13.5px] font-semibold">Touch {name} to this computer</span>
        <button onClick={onClose} aria-label="Hide" className="text-mute hover:text-fg text-[15px] leading-none ml-1">×</button>
      </div>
    </div>
  );
}

/* On the Share screen: send straight to a paired device, or pair one. */
function DeviceRow({ peersVersion, onPair, onSend, sendingTo, disabled }) {
  const [peers, setPeers] = useState(getPeers);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState([]);
  useEffect(() => { setPeers(getPeers()); setPicked([]); setPicking(false); }, [peersVersion]);
  if (!peers.length) return (
    <div id="device-row" className="rounded-2xl border border-dashed border-line px-4 py-3 flex flex-wrap items-center gap-3">
      <span className="text-mute shrink-0">{DEVICE_ICON}</span>
      <span className="text-[13px] text-mute flex-1 min-w-[180px]">Pair your phone and this computer once, then send to it with one tap.</span>
      <button id="pair-home" onClick={onPair} className="press rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line hover:border-mute">Pair a device</button>
    </div>
  );
  const spin = <span className="w-3.5 h-3.5 rounded-full border-2 border-mute border-t-transparent animate-spin" aria-hidden="true" />;
  const toggle = (id) => setPicked(ps => (ps.includes(id) ? ps.filter(x => x !== id) : [...ps, id]));
  const chosen = peers.filter(p => picked.includes(p.inboxId));
  return (
    <div id="device-row" className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] text-mute mr-1">{picking ? 'Choose devices' : 'Or send straight to'}</span>
      {peers.map(p => {
        const on = picked.includes(p.inboxId);
        return (
          <button key={p.inboxId} id={`home-send-${p.inboxId}`} onClick={() => (picking ? toggle(p.inboxId) : onSend(p))} disabled={disabled} aria-pressed={picking ? on : undefined}
            className={`press inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium border disabled:opacity-60 ${picking && on ? 'border-ember bg-[var(--ember-soft)]' : 'border-line hover:border-mute'}`}>
            {sendingTo === p.inboxId ? spin : picking ? <span className={`w-4 h-4 rounded border grid place-items-center text-[11px] ${on ? 'bg-ember border-ember text-ink' : 'border-mute'}`} aria-hidden="true">{on ? '✓' : ''}</span> : <span className="text-mute">{DEVICE_ICON}</span>}
            {p.name}
          </button>
        );
      })}
      {peers.length > 1 && !picking && (<>
        <button id="home-send-all" onClick={() => onSend(peers)} disabled={disabled} className="press inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold border border-line hover:border-mute disabled:opacity-60">
          {sendingTo && peers.some(p => p.inboxId === sendingTo) && disabled ? spin : null}All {peers.length} devices
        </button>
        <button id="home-pick" onClick={() => { setPicking(true); setPicked([]); }} className="rounded-lg px-2.5 py-2 text-[12.5px] text-mute hover:text-fg">Choose…</button>
      </>)}
      {picking && (<>
        <button id="home-send-picked" disabled={!chosen.length || disabled} onClick={() => { onSend(chosen); setPicking(false); setPicked([]); }}
          className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary disabled:opacity-50">Send to {chosen.length || ''} {chosen.length === 1 ? 'device' : 'devices'}</button>
        <button onClick={() => { setPicking(false); setPicked([]); }} className="rounded-lg px-2.5 py-2 text-[12.5px] text-mute hover:text-fg">Cancel</button>
      </>)}
      {!picking && <button id="pair-home" onClick={onPair} className="rounded-lg px-2.5 py-2 text-[12.5px] text-mute hover:text-fg" title="Pair another device">+ Pair</button>}
      {peers.length > 1 && <p className="basis-full text-[11.5px] text-mute">Sending to several devices gives each one its own copy, so a burn link burns separately on each.</p>}
    </div>
  );
}

/* Items other devices sent here. */
function InboxPanel({ items, onOpen, onDismiss }) {
  if (!items.length) return null;
  return (
    <section id="inbox" className="rounded-2xl border border-line bg-panel mb-5" aria-label="Sent to this device">
      <div className="px-4 py-3 border-b border-line text-[13.5px] font-semibold">Sent to this device</div>
      <ul>
        {items.map(it => (
          <li key={it.msgId} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line last:border-0">
            <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0 border border-line bg-well text-mute" aria-hidden="true">{it.kind === 'file' ? FILE_ICON : LINK_ICON}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium truncate">{it.label || 'A secret'}</div>
              <div className="text-[12px] text-mute">From {it.fromName}, {ago(it.sentAt || Date.now())}{it.expiry === 'burn' ? '. Burns when opened' : ''}{it.password ? '. Needs the password' : ''}</div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button onClick={() => onOpen(it)} className="press rounded-lg px-3 py-1.5 text-[12.5px] font-semibold btn-primary">Open</button>
              <button onClick={() => onDismiss(it)} className="press rounded-lg px-2.5 py-1.5 text-[12.5px] text-mute hover:text-fg">Remove</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Pops up when something arrives while Ashdrop is open. */
function ArrivalCard({ item, more, onOpen, onLater }) {
  return (
    <div className="fixed z-[65] right-4 left-4 sm:left-auto sm:w-[380px] pop" style={{ bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }} role="status" id="arrival">
      <div className="rounded-xl border border-line bg-panel p-4 shadow-2xl">
        <div className="text-[12.5px] text-mute">From {item.fromName}{more ? ` (+${more} more)` : ''}</div>
        <div className="text-[14.5px] font-semibold mt-0.5 truncate">{item.label || 'A secret'}</div>
        <div className="text-[12px] text-mute mt-0.5">{item.expiry === 'burn' ? 'Burns when opened.' : 'Opens until it expires.'}{item.password ? ' Needs the password.' : ''}</div>
        <div className="flex gap-2 mt-3">
          <button id="arrival-open" onClick={onOpen} className="press flex-1 rounded-lg py-2 text-[13px] font-semibold btn-primary">Open</button>
          <button onClick={onLater} className="press rounded-lg px-3 py-2 text-[13px] font-medium border border-line hover:border-mute">Later</button>
        </div>
      </div>
    </div>
  );
}

/* Settings → Your devices */
function DevicesSettings({ onPair, peersVersion, onChange }) {
  const [peers, setPeers] = useState(getPeers);
  const [name, setName] = useState(() => (hasDevice() ? null : defaultDeviceName()));
  useEffect(() => { setPeers(getPeers()); }, [peersVersion]);
  useEffect(() => { if (name === null) getDevice().then(d => setName(d.name)); }, [name]);
  const saveName = async () => { const n = (name || '').trim() || defaultDeviceName(); await getDevice(); renameDevice(n); setName(n); };
  return (
    <>
      <Row title="This device" sub="The name your other devices see when you send them something.">
        <div className="flex gap-2 sm:justify-end">
          <label htmlFor="device-name" className="sr-only">Device name</label>
          <input id="device-name" value={name || ''} onChange={(e) => setName(e.target.value)} onBlur={saveName} maxLength={40}
            className="w-full sm:w-52 bg-well border border-line rounded-lg px-3 py-2 text-[13px] outline-hidden focus:border-mute" />
        </div>
      </Row>
      <Row stack title="Paired devices" sub={peers.length ? 'Links you create can be sent to these with one tap.' : 'None yet. Pair your phone or another computer to send links to it with one tap.'}>
        {peers.length > 0 && (
          <ul id="peer-list" className="flex flex-col gap-1.5">
            {peers.map(p => (
              <li key={p.inboxId} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <span className="text-mute">{DEVICE_ICON}</span>
                <span className="flex-1 text-[13px] font-medium truncate">{p.name}</span>
                <button onClick={() => { removePeer(p.inboxId); setPeers(getPeers()); onChange?.(); }} className="text-[12.5px] text-mute hover:text-ember">Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 mt-1">
          <button id="pair-open" onClick={onPair} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary">Pair a device</button>
          <a href="/pair" className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute transition-colors">I have words from another device</a>
        </div>
      </Row>
    </>
  );
}

/* ashdrop.cc/pair: the device that joins. */
/* Type the 4 pairing words shown on the other device. Used on /pair and in the Pair a device window. */
function PairJoinForm({ initialWords = '', onJoined, autoFocus = true }) {
  const [input, setInput] = useState(initialWords.replace(/-/g, ' '));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const { words, code } = parseCode(input);
  const slots = Array.from({ length: CODE_WORDS }, (_, i) => words[i] || null);
  const submit = async (e) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true); setMsg('');
    try { onJoined(await joinPairing(code)); } catch (err) { setMsg(err.message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="pair-input" className="sr-only">Pairing words</label>
        <input id="pair-input" autoFocus={autoFocus && !initialWords && FINE_POINTER} value={input} onChange={(e) => { setInput(e.target.value); setMsg(''); }}
          placeholder="four words" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="w-full bg-well border border-line rounded-xl px-4 py-3.5 font-mono text-[16px] outline-hidden focus:border-mute text-center" />
        <div className="grid grid-cols-4 gap-1.5 mt-3">
          {slots.map((w, i) => (
            <span key={i} className={`h-9 rounded-lg border font-mono text-[12.5px] grid place-items-center truncate px-1 ${!w ? 'border-dashed border-line text-mute' : w.word ? 'border-line bg-raised' : 'border-warn/50 text-warn'}`}>
              {!w ? i + 1 : w.word || `${w.typed}?`}
            </span>
          ))}
        </div>
      </div>
      {msg && <div role="alert" className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5">{msg}</div>}
      <button id="pair-join" disabled={!code || busy} className="press rounded-xl py-3.5 font-display text-[16px] btn-primary disabled:opacity-50 flex items-center justify-center gap-2">
        {busy ? <><span className="w-4 h-4 rounded-full border-2 border-ink border-t-transparent animate-spin" />Pairing…</> : 'Pair'}
      </button>
      <p className="text-[12px] text-mute text-center">The words never leave this device. They encrypt a name card that the two devices swap, so Ashdrop cannot read it or pair itself in between.</p>
    </form>
  );
}

export function PairPage({ initialWords = '' }) {
  const [peer, setPeer] = useState(null);
  return (
    <div className="min-h-full flex flex-col">
      <div className="relative gutter max-w-6xl w-full mx-auto py-3 flex items-center gap-3 border-b border-line">
        <a href="/" aria-label="Ashdrop home"><Logo /></a>
        <a href="/" className="press ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line text-mute hover:text-fg hover:border-mute transition-colors">Open Ashdrop</a>
      </div>
      <main className="flex-1 gutter py-10 sm:py-16">
        <div className="pop w-full max-w-xl mx-auto rounded-3xl border border-line bg-panel p-6 sm:p-8 flex flex-col gap-5">
          {peer ? (
            <div id="pair-joined" className="flex flex-col gap-3">
              <h1 className="font-display text-[28px] leading-tight">Paired with {peer.name}</h1>
              <p className="text-mute text-[14px]">After you create a link on either device, send it to the other one with a single tap from the result screen.</p>
              <a href="/" className="press mt-2 rounded-xl py-3 text-center font-semibold btn-primary">Open Ashdrop</a>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <h1 className="font-display text-[28px] sm:text-[32px] leading-tight">Pair this device</h1>
                <p className="text-mute text-[14px] mt-2">{initialWords ? 'Check that these are the words shown on your other device, then pair.' : 'Type the 4 words shown on your other device, under Pair a device.'}</p>
              </div>
              <PairJoinForm initialWords={initialWords} onJoined={setPeer} />
            </div>
          )}
        </div>
      </main>
      <Footer className="gutter pb-8 pt-2" />
    </div>
  );
}

/* ---------- Nearby: device to device on the same network ---------- */
const PHONE_ICON = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>;
const COMPUTER_ICON = <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>;
const isPhone = (d) => /iPhone|Android|iPad/.test(d || '');
const nearbyVisiblePref = () => { try { return localStorage.getItem('ashdrop.nearbyVisible') !== 'off'; } catch { return true; } };

function NearbyView() {
  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState([]);
  const [visible, setVisible] = useState(nearbyVisiblePref);
  const [me, setMe] = useState(nearbyIdentity);
  const [renaming, setRenaming] = useState(false);
  const [jobs, setJobs] = useState({});       // peerId -> { state, progress, code, msg, cancel }
  const [incoming, setIncoming] = useState([]); // queue of requests
  const [textFor, setTextFor] = useState(null);
  const [pickFor, setPickFor] = useState(null);
  const conn = useRef(null);
  const fileInput = useRef(null);

  useEffect(() => {
    conn.current = joinNearby({
      visible, onStatus: setStatus, onPeers: setPeers,
      onIncoming: (req) => setIncoming(q => [...q, req]),
    });
    return () => conn.current?.close();
  }, []);

  const toggleVisible = (v) => { setVisible(v); conn.current?.setVisible(v); try { localStorage.setItem('ashdrop.nearbyVisible', v ? 'on' : 'off'); } catch {} };
  const job = (id, patch) => setJobs(j => ({ ...j, [id]: { ...j[id], ...patch } }));
  const sendTo = (peer, payload) => {
    if (!payload.files?.length && !payload.text) return;
    const cancel = conn.current.send(peer, payload, {
      onState: (state, extra) => job(peer.id, { state, ...(state === 'waiting' ? { code: extra?.code } : {}), ...(state === 'failed' ? { msg: extra } : {}), ...(state === 'sent' ? { progress: 1 } : {}) }),
      onProgress: (p) => job(peer.id, { progress: p }),
    });
    job(peer.id, { state: 'connecting', progress: 0, msg: '', code: '', what: payload.files?.length ? `${payload.files.length} file${payload.files.length > 1 ? 's' : ''}` : 'text', cancel });
  };
  const busy = (st) => ['connecting', 'waiting', 'sending'].includes(st);

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[28px] sm:text-[36px] leading-[1.1]">Nearby</h1>
        <p className="text-mute text-[14px] mt-2 max-w-xl">Send files and text straight to devices on the same Wi-Fi. They go device to device, encrypted, and are never uploaded, so there is no size limit.</p>
      </div>

      <section className="rounded-2xl border border-line bg-panel p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-11 h-11 rounded-xl grid place-items-center border border-line bg-raised shrink-0">{isPhone(deviceType()) ? PHONE_ICON : COMPUTER_ICON}</span>
          <div className="min-w-0">
            {renaming ? (
              <form onSubmit={(e) => { e.preventDefault(); setMe({ name: conn.current.rename(e.target.elements.nm.value) }); setRenaming(false); }} className="flex gap-2">
                <input name="nm" defaultValue={me.name} autoFocus maxLength={32} aria-label="Your name on Nearby" className="bg-well border border-line rounded-lg px-2.5 py-1.5 text-[14px] outline-hidden focus:border-mute w-44" />
                <button className="press rounded-lg px-3 text-[13px] font-semibold btn-primary">Save</button>
              </form>
            ) : (
              <div className="text-[15px] font-semibold truncate">You appear as <span id="nearby-me">{me.name}</span> <button onClick={() => setRenaming(true)} className="ml-1 text-[12.5px] font-normal text-mute underline underline-offset-2 hover:text-fg">Rename</button></div>
            )}
            <div className="text-[12.5px] text-mute mt-0.5">{status === 'online' ? (visible ? 'Visible to devices on this network while this screen is open.' : 'Hidden. You can still send to visible devices.') : status === 'connecting' ? 'Connecting…' : 'Offline. Reconnecting…'}</div>
          </div>
        </div>
        <label className="flex items-center gap-3 shrink-0 text-[13px]">
          <span>Visible</span>
          <Toggle id="nearby-visible" label="Visible to nearby devices" on={visible} onChange={toggleVisible} />
        </label>
      </section>

      {peers.length === 0 ? (
        <section id="nearby-empty" className="rounded-2xl border border-dashed border-line p-6 sm:p-8 flex flex-col sm:flex-row items-center gap-6">
          <div className="flex-1 text-center sm:text-left">
            <div className="text-[15px] font-semibold">Looking for devices on this network…</div>
            <p className="text-[13px] text-mute mt-1.5">Open <span className="font-mono text-fg">{location.host}/nearby</span> on your other device. Both need to be on the same Wi-Fi and have this screen open.</p>
          </div>
          <div className="shrink-0 rounded-xl bg-white p-2"><QR text={`${location.origin}/nearby`} size={120} /></div>
        </section>
      ) : (
        <section aria-label="Devices nearby">
          <div className="text-[13px] text-mute mb-2.5">Tap a device to send it files, or drop files on it.</div>
          <ul id="nearby-peers" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {peers.map(p => {
              const j = jobs[p.id] || {};
              return (
                <li key={p.id}>
                  <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy(j.state)) sendTo(p, { files: [...e.dataTransfer.files] }); }}
                    className="rounded-2xl border border-line bg-panel p-4 flex flex-col items-center text-center gap-2 h-full">
                    <button data-peer={p.name} onClick={() => { if (!busy(j.state)) { setPickFor(p); fileInput.current.click(); } }} disabled={busy(j.state)}
                      className="press flex flex-col items-center gap-2 w-full disabled:cursor-default">
                      <span className="w-14 h-14 rounded-full grid place-items-center border border-line bg-raised">{isPhone(p.device) ? PHONE_ICON : COMPUTER_ICON}</span>
                      <span className="text-[14px] font-semibold leading-tight">{p.name}</span>
                      <span className="text-[12px] text-mute -mt-1">{p.device}</span>
                    </button>
                    <div className="min-h-[34px] w-full flex flex-col items-center justify-center text-[12px]" aria-live="polite">
                      {j.state === 'connecting' && <span className="text-mute">Connecting…</span>}
                      {j.state === 'waiting' && <span className="text-mute">Waiting for them to accept<br />Check code <span className="font-mono text-fg">{j.code}</span></span>}
                      {j.state === 'sending' && <div className="w-full"><div className="h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-fg transition-[width]" style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div><div className="text-mute mt-1 tabular">{Math.round((j.progress || 0) * 100)}%</div></div>}
                      {j.state === 'sent' && <span className="text-ok">Sent {j.what} ✓</span>}
                      {j.state === 'declined' && <span className="text-warn">They declined</span>}
                      {j.state === 'cancelled' && <span className="text-mute">Cancelled</span>}
                      {j.state === 'failed' && <span className="text-warn">{j.msg}</span>}
                      {!busy(j.state) && <button onClick={() => setTextFor(p)} className="text-mute underline underline-offset-2 hover:text-fg mt-0.5">Send text</button>}
                      {busy(j.state) && <button onClick={() => j.cancel?.()} className="text-mute hover:text-ember mt-0.5">Cancel</button>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <input ref={fileInput} id="nearby-file" type="file" multiple className="hidden" onChange={(e) => { const fs = [...e.target.files]; e.target.value = ''; if (pickFor && fs.length) sendTo(pickFor, { files: fs }); }} />

      <p className="text-[12px] text-mute">Only devices on the same network can see you, and only while this screen is open. Nothing is received until you tap Accept. Both screens show the same 4-digit check code; if they match, the connection is private end to end.</p>

      {textFor && <SendTextModal peer={textFor} onClose={() => setTextFor(null)} onSend={(text) => { sendTo(textFor, { text }); setTextFor(null); }} />}
      {incoming[0] && <IncomingModal key={incoming[0].from.id + incoming[0].code} req={incoming[0]} onClose={() => setIncoming(q => q.slice(1))} />}
    </div>
  );
}

function SendTextModal({ peer, onClose, onSend }) {
  const [text, setText] = useState('');
  return (
    <Modal onClose={onClose} labelledBy="st-title">
      <h2 id="st-title" className="font-display text-xl">Send text to {peer.name}</h2>
      <label htmlFor="nearby-text" className="sr-only">Text</label>
      <textarea id="nearby-text" autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={100000}
        className="mt-3 w-full bg-well border border-line rounded-lg p-3 font-mono text-[13px] outline-hidden focus:border-mute" placeholder="A password, a link, a note…" />
      <div className="flex gap-2 mt-3">
        <button onClick={onClose} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold border border-line">Cancel</button>
        <button id="nearby-text-send" disabled={!text.trim()} onClick={() => onSend(text)} className="press flex-1 rounded-lg py-2.5 text-[13px] font-semibold btn-primary disabled:opacity-50">Send</button>
      </div>
    </Modal>
  );
}

function IncomingModal({ req, onClose }) {
  const [phase, setPhase] = useState('ask'); // ask → receiving → done | error
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const accept = () => {
    setPhase('receiving');
    req.accept({ onProgress: setProgress, onDone: (r) => { setResult(r); setPhase('done'); }, onError: (m) => { setMsg(m); setPhase('error'); } });
  };
  const decline = () => { req.decline(); onClose(); };
  const total = req.totalBytes;
  const save = (name, blob) => browserDownloads.save({ filename: name, data: blob });
  return (
    <Modal onClose={phase === 'ask' ? decline : onClose} labelledBy="in-title">
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl grid place-items-center border border-line bg-raised shrink-0">{isPhone(req.from.device) ? PHONE_ICON : COMPUTER_ICON}</span>
        <div className="min-w-0">
          <h2 id="in-title" className="font-display text-xl leading-tight">{req.from.name}</h2>
          <div className="text-[12.5px] text-mute">{req.from.device ? `${req.from.device} on your network` : 'On your network'}</div>
        </div>
      </div>

      {phase === 'ask' && (
        <div id="incoming-ask">
          <p className="text-[14px] mt-4">Wants to send you {req.files.length ? `${req.files.length} file${req.files.length > 1 ? 's' : ''} (${fmtBytes(total)})` : ''}{req.files.length && req.text ? ' and ' : ''}{req.text ? 'a text message' : ''}.</p>
          {req.files.length > 0 && (
            <ul className="mt-3 max-h-48 overflow-y-auto flex flex-col gap-1 text-[12.5px]">
              {req.files.map((f, i) => <li key={i} className="flex justify-between gap-3 rounded-lg bg-well border border-line px-3 py-1.5"><span className="font-mono truncate">{f.name}</span><span className="text-mute tabular shrink-0">{fmtBytes(f.size)}</span></li>)}
            </ul>
          )}
          <div className="mt-3 text-[12.5px] text-mute">Check code <span id="incoming-code" className="font-mono text-fg text-[14px]">{req.code}</span>. It should match the code on their screen.</div>
          <div className="flex gap-2 mt-4">
            <button id="incoming-decline" onClick={decline} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold border border-line hover:border-mute">Decline</button>
            <button id="incoming-accept" onClick={accept} className="press flex-1 rounded-lg py-2.5 text-[13px] font-semibold btn-primary">Accept</button>
          </div>
        </div>
      )}
      {phase === 'receiving' && (
        <div className="mt-5">
          <div className="h-2 rounded-full bg-line overflow-hidden"><div className="h-full bg-fg transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="text-[12.5px] text-mute mt-2 tabular">Receiving… {Math.round(progress * 100)}%</div>
        </div>
      )}
      {phase === 'done' && result && (
        <div id="incoming-done" className="mt-4 flex flex-col gap-3">
          {result.text !== null && result.text !== undefined && (
            <div>
              <pre id="incoming-text" className="rounded-lg bg-well border border-line p-3 font-mono text-[12.5px] whitespace-pre-wrap break-words max-h-60 overflow-auto">{result.text}</pre>
              <button onClick={async () => { try { await navigator.clipboard.writeText(result.text); setCopied(true); } catch {} }} className="press mt-2 w-full rounded-lg py-2.5 text-[13px] font-semibold btn-primary">{copied ? 'Copied' : 'Copy text'}</button>
            </div>
          )}
          {result.files.length > 0 && (
            <>
              <ul className="flex flex-col gap-1.5 max-h-60 overflow-y-auto">
                {result.files.map((f, i) => (
                  <li key={i} className="flex items-center gap-3 rounded-lg bg-well border border-line px-3 py-2">
                    <span className="font-mono text-[12.5px] truncate flex-1">{f.name}</span>
                    <span className="text-mute text-[12px] tabular shrink-0">{fmtBytes(f.size)}</span>
                    <button onClick={() => save(f.name, f.blob)} className="press shrink-0 rounded-md px-2.5 py-1 text-[12px] font-semibold border border-line hover:border-mute">Save</button>
                  </li>
                ))}
              </ul>
              {result.files.length > 1 && total < 300 * 1024 * 1024 && (
                <button id="incoming-save-all" onClick={async () => save('nearby-files.zip', makeZip(await Promise.all(result.files.map(async f => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })))))}
                  className="press rounded-lg py-2.5 text-[13px] font-semibold btn-primary">Save all (.zip)</button>
              )}
              {result.files.length === 1 && <button onClick={() => save(result.files[0].name, result.files[0].blob)} className="press rounded-lg py-2.5 text-[13px] font-semibold btn-primary">Save file</button>}
            </>
          )}
          <button onClick={onClose} className="text-[13px] text-mute hover:text-fg">Close</button>
        </div>
      )}
      {phase === 'error' && <div role="alert" className="mt-4 rounded-lg border border-warn/40 bg-warn/10 text-warn text-[13px] px-3 py-2.5">{msg}</div>}
    </Modal>
  );
}

/* ---------- accounts and the cloud vault ---------- */
const fieldCls = 'w-full bg-well border border-line rounded-lg px-3 py-2.5 text-[14px] outline-hidden focus:border-mute';

/* Sign in, create an account (invite only for now), or reset with the recovery key. */
function ProviderButtons({ label = 'Continue', disabled }) {
  const [p, setP] = useState({});
  const [busy, setBusy] = useState('');
  useEffect(() => { account.oauthProviders().then(setP); }, []);
  const list = [['google', 'Google', GoogleMark], ['apple', 'Apple', AppleMark]].filter(([id]) => p[id]);
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-2 mb-4">
      {list.map(([id, name, Mark]) => (
        <button key={id} id={`acct-${id}`} type="button" disabled={disabled || !!busy} onClick={() => { setBusy(id); account.startOAuth(id).catch(() => setBusy('')); }}
          className="press rounded-lg py-2.5 text-[13.5px] font-semibold border border-line hover:border-mute flex items-center justify-center gap-2.5 disabled:opacity-60">
          <Mark />{busy === id ? 'Opening…' : `${label} with ${name}`}
        </button>
      ))}
      <div className="flex items-center gap-3 text-[11.5px] text-mute mt-2"><span className="h-px flex-1 bg-line" />or with email<span className="h-px flex-1 bg-line" /></div>
    </div>
  );
}
const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
);
const AppleMark = () => (
  <svg width="15" height="16" viewBox="0 0 17 20" aria-hidden="true" fill="currentColor"><path d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM11.6 3c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg>
);

/* After Google/Apple, for someone new: invite + vault PIN, then the recovery key. */
function OAuthSetup({ res, ownerKey, onReady, onCancel }) {
  const [invite, setInvite] = useState('');
  const [pin, setPin] = useState(''), [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [recoveryKey, setRecoveryKey] = useState(null);
  const name = res.provider === 'apple' ? 'Apple' : 'Google';
  if (recoveryKey) return <RecoveryKeyCard recoveryKey={recoveryKey} email={res.email} pinMode onDone={onReady} />;
  const submit = async (e) => {
    e.preventDefault();
    if (!account.pinOk(pin)) return setMsg('Use a PIN of at least 6 digits or characters.');
    if (pin !== pin2) return setMsg('The two PINs are not the same.');
    setBusy(true); setMsg('');
    try { setRecoveryKey((await account.oauthSignUp({ ...res, pin, invite, ownerKey })).recoveryKey); } catch (err) { setMsg(err.message); }
    setBusy(false);
  };
  return (
    <form id="oauth-setup" onSubmit={submit} className="pop w-full max-w-md mx-auto rounded-2xl border border-line bg-panel p-6 sm:p-7 flex flex-col gap-3">
      <h2 className="font-display text-xl">Set up your vault</h2>
      <p className="text-[13px] text-mute">{name} confirmed <span className="text-fg">{res.email}</span>. {name} only proves who you are. To open the vault itself you also need a key that never leaves your devices, so choose a vault PIN. On phones and laptops you can add a passkey later and skip the PIN.</p>
      {!ownerKey && <label className="text-[12.5px] text-mute">Invite code<input id="oauth-invite" required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} className={fieldCls + ' mt-1 font-mono uppercase text-fg'} /></label>}
      <label className="text-[12.5px] text-mute">Vault PIN<input id="oauth-pin" type="password" required autoComplete="new-password" inputMode="text" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="At least 6 digits or characters" className={fieldCls + ' mt-1 text-fg'} /></label>
      <label className="text-[12.5px] text-mute">Repeat it<input id="oauth-pin2" type="password" required autoComplete="new-password" value={pin2} onChange={(e) => setPin2(e.target.value)} className={fieldCls + ' mt-1 text-fg'} /></label>
      <p className="text-[12px] text-mute">Longer is safer. After 10 wrong tries the PIN stops working and you need your passkey or recovery key.</p>
      {msg && <div role="alert" className="rounded-lg border border-warn/40 bg-warn/10 text-warn text-[13px] px-3 py-2">{msg}</div>}
      <button id="oauth-create" disabled={busy} className="press rounded-lg py-3 font-semibold btn-primary disabled:opacity-60">{busy ? 'Creating…' : 'Create my vault'}</button>
      <button type="button" onClick={onCancel} className="text-[12.5px] text-mute hover:text-fg">Cancel</button>
      {!ownerKey && <p className="text-[12px] text-mute">The vault is invite-only while we test it. <a href="/contact" className="underline underline-offset-2 hover:text-fg">Ask for an invite</a>.</p>}
    </form>
  );
}

function AccountGate({ onReady, ownerKey, initialMsg = '' }) {
  const [mode, setMode] = useState('signin'); // signin | signup | recover
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [invite, setInvite] = useState('');
  const [rk, setRk] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(initialMsg);
  const [recoveryKey, setRecoveryKey] = useState(null);
  const run = async (fn) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e.message); } setBusy(false); };
  const submit = (e) => {
    e.preventDefault();
    if (mode === 'signin') return run(async () => { await account.signIn({ email, password: pw }); onReady(); });
    if (pw.length < 10) return setMsg('Use a password of at least 10 characters. A short sentence works well.');
    if (pw !== pw2) return setMsg('The two passwords are not the same.');
    if (mode === 'signup') return run(async () => { const r = await account.signUp({ email, password: pw, invite, ownerKey }); setRecoveryKey(r.recoveryKey); });
    return run(async () => { await account.recover({ email, recoveryKey: rk, newPassword: pw }); onReady(); });
  };
  if (recoveryKey) return <RecoveryKeyCard recoveryKey={recoveryKey} email={email} onDone={onReady} />;
  const tabs = [['signin', 'Sign in'], ['signup', 'Create account']];
  return (
    <div className="pop w-full max-w-md mx-auto rounded-2xl border border-line bg-panel p-6 sm:p-7">
      {mode !== 'recover' && (
        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-well border border-line mb-5" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} id={`acct-tab-${id}`} role="tab" aria-selected={mode === id} onClick={() => { setMode(id); setMsg(''); }}
              className={`rounded-lg py-2 text-[13px] font-semibold transition-colors ${mode === id ? 'fill-on on-fill' : 'text-mute hover:text-fg'}`}>{label}</button>
          ))}
        </div>
      )}
      {mode === 'recover' && <h2 className="font-display text-xl mb-1">Reset your password</h2>}
      {mode === 'recover' && <p className="text-[13px] text-mute mb-4">Your recovery key unlocks the vault and lets you choose a new password. Ashdrop cannot do this for you. If you use Google, sign in with it first, then pick "Use your recovery key".</p>}
      {mode !== 'recover' && <ProviderButtons label={mode === 'signup' ? 'Sign up' : 'Continue'} disabled={busy} />}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="text-[12.5px] text-mute">Email<input id="acct-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={fieldCls + ' mt-1 text-fg'} /></label>
        {mode === 'recover' && <label className="text-[12.5px] text-mute">Recovery key<input id="acct-rk" required value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} className={fieldCls + ' mt-1 font-mono text-fg'} /></label>}
        <label className="text-[12.5px] text-mute">{mode === 'recover' ? 'New password' : 'Password'}<input id="acct-pw" type="password" required autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} className={fieldCls + ' mt-1 text-fg'} /></label>
        {mode !== 'signin' && <label className="text-[12.5px] text-mute">Repeat it<input id="acct-pw2" type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={fieldCls + ' mt-1 text-fg'} /></label>}
        {mode === 'signup' && !ownerKey && <label className="text-[12.5px] text-mute">Invite code<input id="acct-invite" required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} className={fieldCls + ' mt-1 font-mono uppercase text-fg'} /></label>}
        {mode === 'signup' && <p className="text-[12px] text-mute">Your password never leaves this device, so nobody, including Ashdrop, can reset it. You will get a recovery key in the next step.</p>}
        {msg && <div role="alert" className="rounded-lg border border-warn/40 bg-warn/10 text-warn text-[13px] px-3 py-2">{msg}</div>}
        <button id="acct-submit" disabled={busy} className="press rounded-lg py-3 font-semibold btn-primary disabled:opacity-60 flex items-center justify-center gap-2">
          {busy && <span className="w-4 h-4 rounded-full border-2 border-ink border-t-transparent animate-spin" />}
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Set new password'}
        </button>
      </form>
      <div className="flex flex-wrap justify-between gap-2 mt-4 text-[12.5px]">
        {mode === 'signin' && account.passkeysSupported() && (
          <button id="acct-passkey" onClick={() => run(async () => { await account.signInWithPasskey(); onReady(); })} className="text-fg underline underline-offset-2 hover:text-ember">Sign in with a passkey</button>
        )}
        {mode === 'signin' && <button onClick={() => { setMode('recover'); setMsg(''); }} className="text-mute hover:text-fg ml-auto">Forgot password?</button>}
        {mode === 'recover' && <button onClick={() => { setMode('signin'); setMsg(''); }} className="text-mute hover:text-fg">Back to sign in</button>}
      </div>
      {mode === 'signup' && !ownerKey && <p className="text-[12px] text-mute mt-4">The vault is invite-only while we test it. <a href="/contact" className="underline underline-offset-2 hover:text-fg">Ask for an invite</a>.</p>}
    </div>
  );
}

function RecoveryKeyCard({ recoveryKey, email, onDone, pinMode }) {
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);
  const save = () => browserDownloads.save({ filename: 'ashdrop-recovery-key.txt', data: new Blob([`Ashdrop recovery key\n\nAccount: ${email}\nRecovery key: ${recoveryKey}\n\nIf you forget your password, this key is the only way back into your vault.\nKeep it somewhere safe and offline. Anyone with this key and your email can open your vault.\n`]) });
  return (
    <div id="recovery-card" className="pop w-full max-w-md mx-auto rounded-2xl border border-line bg-panel p-6 sm:p-7 flex flex-col gap-4">
      <h2 className="font-display text-xl">Save your recovery key</h2>
      <p className="text-[13.5px] text-mute">If you forget your {pinMode ? 'PIN and lose your passkeys' : 'password'}, this key is the only way back into your vault. We cannot reset it for you, and we will not show it again.</p>
      <div id="recovery-key" className="rounded-xl bg-well border border-line p-4 font-mono text-[14px] text-center select-all">{recoveryKey.split('-').map((g, i) => <React.Fragment key={i}>{i > 0 && <>-<wbr /></>}<span className="whitespace-nowrap">{g}</span></React.Fragment>)}</div>
      <div className="flex gap-2">
        <button onClick={save} className="press flex-1 rounded-lg py-2.5 text-[13px] font-semibold border border-line hover:border-mute">Download as a file</button>
        <button onClick={async () => { try { await navigator.clipboard.writeText(recoveryKey); setCopied(true); } catch {} }} className="press flex-1 rounded-lg py-2.5 text-[13px] font-semibold border border-line hover:border-mute">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <label className="flex items-start gap-2.5 text-[13px]"><input id="recovery-saved" type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="mt-0.5 accent-[var(--ember)]" />I saved it somewhere safe, like a password manager or on paper.</label>
      <button id="recovery-done" disabled={!ok} onClick={onDone} className="press rounded-lg py-3 font-semibold btn-primary disabled:opacity-50">Open my vault</button>
    </div>
  );
}

function UnlockGate({ email, onReady, onSignOut }) {
  const [info, setInfo] = useState(null);
  const [secret, setSecret] = useState('');
  const [rk, setRk] = useState(''), [fresh, setFresh] = useState('');
  const [mode, setMode] = useState('normal'); // normal | recover
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { account.me().then(setInfo).catch(() => setInfo({ hasPassword: true })); }, []);
  const run = async (fn) => { setBusy(true); setMsg(''); try { await fn(); onReady(); } catch (e) { setMsg(e.message); account.me().then(setInfo).catch(() => {}); } setBusy(false); };
  const usePw = !!info?.hasPassword, usePin = !usePw && !!info?.pin;
  const passkeys = account.passkeysSupported() && (info?.passkeys?.length ?? 1) > 0;
  const card = 'pop w-full max-w-md mx-auto rounded-2xl border border-line bg-panel p-6 sm:p-7 flex flex-col gap-3';
  if (mode === 'recover') return (
    <form onSubmit={(e) => { e.preventDefault(); if (usePw ? fresh.length < 10 : !account.pinOk(fresh)) return setMsg(usePw ? 'Use a password of at least 10 characters.' : 'Use a PIN of at least 6 digits or characters.'); run(() => account.recover({ email, recoveryKey: rk, ...(usePw ? { newPassword: fresh } : { newPin: fresh }) })); }} className={card}>
      <h2 className="font-display text-xl">Use your recovery key</h2>
      <p className="text-[13px] text-mute">It opens the vault and lets you choose a new {usePw ? 'password' : 'vault PIN'}. It also signs you out everywhere else.</p>
      <input id="unlock-rk" required value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} aria-label="Recovery key" className={fieldCls + ' font-mono'} />
      <input id="unlock-new" type="password" required autoComplete="new-password" value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder={usePw ? 'New password' : 'New vault PIN'} aria-label={usePw ? 'New password' : 'New vault PIN'} className={fieldCls} />
      {msg && <div role="alert" className="text-[13px] text-warn">{msg}</div>}
      <button id="unlock-recover" disabled={busy} className="press rounded-lg py-3 font-semibold btn-primary disabled:opacity-60">{busy ? 'Working…' : 'Open my vault'}</button>
      <button type="button" onClick={() => { setMode('normal'); setMsg(''); }} className="text-[12.5px] text-mute hover:text-fg">Back</button>
    </form>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(() => (usePw ? account.unlock(secret) : account.unlockWithPin(secret))); }} className={card}>
      <h2 className="font-display text-xl">Unlock your vault</h2>
      <p className="text-[13px] text-mute">Signed in as <span className="text-fg">{email}</span>. Your vault locks when you close the tab.</p>
      {!info ? <div className="text-[13px] text-mute py-2">Checking…</div> : (usePw || usePin) ? (<>
        <input id="unlock-pw" type="password" autoFocus={FINE_POINTER} autoComplete={usePw ? 'current-password' : 'off'} placeholder={usePw ? 'Password' : 'Vault PIN'} aria-label={usePw ? 'Password' : 'Vault PIN'} value={secret} onChange={(e) => setSecret(e.target.value)} className={fieldCls} />
        <button id="unlock-submit" disabled={busy || !secret} className="press rounded-lg py-3 font-semibold btn-primary disabled:opacity-60">{busy ? 'Unlocking…' : 'Unlock'}</button>
      </>) : <p id="unlock-nopin" className="text-[13px] text-warn">PIN unlock is off after too many wrong tries. Use a passkey or your recovery key, then choose a new PIN.</p>}
      {msg && <div role="alert" className="text-[13px] text-warn">{msg}</div>}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]">
        {passkeys && <button id="unlock-passkey" type="button" onClick={() => run(() => account.signInWithPasskey())} className="text-fg underline underline-offset-2 hover:text-ember">Use a passkey</button>}
        <button id="unlock-use-rk" type="button" onClick={() => { setMode('recover'); setMsg(''); }} className="text-mute hover:text-fg">Use your recovery key</button>
        <button type="button" onClick={onSignOut} className="text-mute hover:text-fg ml-auto">Sign out</button>
      </div>
    </form>
  );
}

/* The vault itself, once unlocked. */
function CloudVault({ onShare, toast, onAccountChange }) {
  const [state, setState] = useState({ loading: true, files: [], used: 0, quota: 0 });
  const [prefs, setPrefs] = useState({ folders: [] });
  const [folder, setFolder] = useState('all');
  const [q, setQ] = useState('');
  const [uploads, setUploads] = useState([]); // { name, progress }
  const [rowBusy, setRowBusy] = useState({});
  const [confirmDel, setConfirmDel] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [drag, setDrag] = useState(false);
  const [msg, setMsg] = useState('');
  const input = useRef(null);
  const refresh = async () => { try { setState({ loading: false, ...(await vault.listFiles()) }); } catch (e) { setMsg(e.message); setState(s => ({ ...s, loading: false })); } };
  useEffect(() => { refresh(); vault.loadPrefs().then(p => setPrefs({ folders: [], ...p })).catch(() => {}); }, []);
  const folders = [...new Set([...(prefs.folders || []), ...state.files.map(f => f.folder).filter(Boolean)])].sort();
  const shown = state.files.filter(f => (folder === 'all' || f.folder === folder) && f.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.created - a.created);
  const free = Math.max(0, state.quota - state.used);

  const upload = async (list) => {
    const arr = [...(list || [])];
    if (!arr.length) return;
    const need = arr.reduce((n, f) => n + f.size + 28 * Math.max(1, Math.ceil(f.size / vault.CHUNK)), 0);
    if (need > free) { setMsg(`Not enough space: that needs ${fmtBytes(need)} and you have ${fmtBytes(free)} left.`); return; }
    setMsg('');
    for (const f of arr) {
      setUploads(u => [...u, { name: f.name, progress: 0 }]);
      try {
        const entry = await vault.uploadFile(f, { folder: folder === 'all' ? null : folder, onProgress: (p) => setUploads(u => u.map(x => (x.name === f.name ? { ...x, progress: p } : x))) });
        setState(s => ({ ...s, files: [entry, ...s.files], used: s.used + entry.size }));
      } catch (e) { setMsg(`${f.name}: ${e.message}`); }
      setUploads(u => u.filter(x => x.name !== f.name));
    }
  };
  const busyRow = (id, v) => setRowBusy(b => ({ ...b, [id]: v }));
  const download = async (f) => {
    busyRow(f.id, 'Decrypting…');
    try { await browserDownloads.save({ filename: f.name, data: await vault.downloadFile(f, { onProgress: (p) => busyRow(f.id, `${Math.round(p * 100)}%`) }) }); }
    catch (e) { setMsg(e.message); }
    busyRow(f.id, null);
  };
  const share = async (f) => {
    if (f.plainSize > 25 * 1024 * 1024 && !getOwnerKey()) { setMsg(`${f.name} is bigger than 25 MB, the limit for a link. Use Nearby to send it to a device.`); return; }
    busyRow(f.id, 'Preparing…');
    try { const blob = await vault.downloadFile(f); onShare(new File([blob], f.name, { type: f.mime || '' })); }
    catch (e) { setMsg(e.message); busyRow(f.id, null); }
  };
  const remove = async (f) => {
    setConfirmDel(null); busyRow(f.id, 'Deleting…');
    try { const r = await vault.deleteFile(f); setState(s => ({ ...s, files: s.files.filter(x => x.id !== f.id), used: r.used })); toast(`${f.name} deleted.`); }
    catch (e) { setMsg(e.message); busyRow(f.id, null); }
  };
  const saveRename = async (f, name, toFolder) => {
    setRenaming(null);
    try { const nf = await vault.updateFile(f, { name: name.trim() || f.name, folder: toFolder || null }); setState(s => ({ ...s, files: s.files.map(x => (x.id === f.id ? nf : x)) })); }
    catch (e) { setMsg(e.message); }
  };
  const [addingFolder, setAddingFolder] = useState(false);
  const newFolder = async (raw) => {
    setAddingFolder(false);
    const name = String(raw || '').trim().slice(0, 40);
    if (!name || folders.includes(name)) return;
    const p = { ...prefs, folders: [...(prefs.folders || []), name] };
    setPrefs(p); setFolder(name);
    vault.savePrefs(p).catch(() => {});
  };
  const pct = state.quota ? Math.min(100, (state.used / state.quota) * 100) : 0;

  return (
    <div className="flex flex-col gap-4" id="cloud-vault">
      <div id="vault-account" className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-mute min-w-0 truncate">Signed in as <span className="text-fg font-medium">{account.session()?.email}</span></span>
        <span className="ml-auto flex gap-2">
          <button id="vault-lock" onClick={() => { account.lockVault(); toast('Vault locked on this tab.'); onAccountChange?.(); }} className="press rounded-lg px-3 py-1.5 font-semibold border border-line hover:border-mute">Lock</button>
          <button id="vault-signout" onClick={async () => { await account.signOut(); toast('Signed out. Your vault key was cleared from this browser.'); onAccountChange?.(); }} className="press rounded-lg px-3 py-1.5 font-semibold border border-line hover:border-mute">Sign out</button>
        </span>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-4 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[200px]">
          <div className="flex justify-between text-[12.5px] mb-1.5"><span>{fmtBytes(state.used)} used</span><span className="text-mute">{fmtBytes(state.quota)} total</span></div>
          <div className="h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: pct > 90 ? 'var(--warn)' : 'var(--fg)' }} /></div>
        </div>
        <button id="vault-upload" onClick={() => input.current.click()} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold btn-primary">Add files</button>
        <input ref={input} id="vault-file" type="file" multiple className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
        className={`rounded-2xl border ${drag ? 'border-ember bg-[var(--ember-soft)]' : 'border-line bg-panel'} transition-colors`}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
          {['all', ...folders].map(fd => (
            <button key={fd} onClick={() => setFolder(fd)} className={`rounded-full px-3 py-1 text-[12.5px] font-medium border transition-colors ${folder === fd ? 'bg-fg text-ink border-fg' : 'border-line text-mute hover:text-fg'}`}>{fd === 'all' ? 'All files' : fd}</button>
          ))}
          {addingFolder
            ? <form onSubmit={(e) => { e.preventDefault(); newFolder(e.target.elements.fn.value); }}><input name="fn" autoFocus onBlur={(e) => newFolder(e.target.value)} placeholder="Folder name" aria-label="New folder name" maxLength={40} className="w-36 bg-well border border-line rounded-full px-3 py-1 text-[12.5px] outline-hidden focus:border-mute" /></form>
            : <button id="vault-new-folder" onClick={() => setAddingFolder(true)} className="rounded-full px-3 py-1 text-[12.5px] text-mute hover:text-fg border border-dashed border-line">New folder</button>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search files" className="ml-auto w-full sm:w-44 bg-well border border-line rounded-lg px-3 py-1.5 text-[13px] outline-hidden focus:border-mute" />
        </div>
        {uploads.map(u => (
          <div key={u.name} className="px-4 py-3 border-b border-line text-[13px]">
            <div className="flex justify-between gap-3"><span className="truncate">Encrypting and uploading {u.name}</span><span className="text-mute tabular">{Math.round(u.progress * 100)}%</span></div>
            <div className="h-1 rounded-full bg-line mt-2 overflow-hidden"><div className="h-full bg-fg" style={{ width: `${u.progress * 100}%` }} /></div>
          </div>
        ))}
        {state.loading ? <div className="px-4 py-10 text-center text-mute text-[13px]">Decrypting your file list…</div>
          : shown.length === 0 ? <div className="px-4 py-12 text-center text-mute text-[13px]">{state.files.length ? 'Nothing matches.' : 'Your vault is empty. Add files, or drop them here. They are encrypted before they leave this device.'}</div>
          : (
            <ul id="vault-list">
              {shown.map(f => {
                const ts = TYPE_STYLE[typeOf(f.name, f.mime)];
                return (
                  <li key={f.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-4 py-3 border-b border-line last:border-0">
                    <span className="w-9 h-9 rounded-lg grid place-items-center font-mono text-[10px] font-bold shrink-0" style={{ background: ts.c + '22', color: tint(ts.c), border: `1px solid ${ts.c}55` }} aria-hidden="true">{ts.t}</span>
                    {renaming === f.id ? (
                      <form className="flex-1 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); saveRename(f, e.target.elements.nm.value, e.target.elements.fd.value); }}>
                        <input name="nm" defaultValue={f.name} autoFocus aria-label="File name" className="flex-1 min-w-[140px] bg-well border border-line rounded-lg px-2.5 py-1.5 text-[13px] outline-hidden focus:border-mute" />
                        <select name="fd" defaultValue={f.folder || ''} aria-label="Folder" className="bg-well border border-line rounded-lg px-2 py-1.5 text-[13px]"><option value="">No folder</option>{folders.map(x => <option key={x} value={x}>{x}</option>)}</select>
                        <button className="press rounded-lg px-3 text-[12.5px] font-semibold btn-primary">Save</button>
                        <button type="button" onClick={() => setRenaming(null)} className="text-[12.5px] text-mute">Cancel</button>
                      </form>
                    ) : (
                      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
                        <div className="text-[13.5px] font-medium truncate">{f.name}</div>
                        <div className="text-[12px] text-mute">{fmtBytes(f.plainSize ?? f.size)} · {new Date(f.created).toLocaleDateString()}{f.folder ? ` · ${f.folder}` : ''}</div>
                      </div>
                    )}
                    {renaming !== f.id && (
                      <div className="flex items-center gap-1 shrink-0 ml-auto">
                        {rowBusy[f.id] ? <span className="text-[12px] text-mute tabular px-2">{rowBusy[f.id]}</span>
                          : confirmDel === f.id ? (<>
                              <button onClick={() => remove(f)} className="rounded-md px-2.5 py-1 text-[12px] font-semibold btn-burn">Delete</button>
                              <button onClick={() => setConfirmDel(null)} className="rounded-md px-2 py-1 text-[12px] text-mute">Keep</button>
                            </>) : (<>
                              <button onClick={() => download(f)} className="rounded-md px-2.5 py-1 text-[12px] font-medium border border-line hover:border-mute">Download</button>
                              <button onClick={() => share(f)} className="rounded-md px-2.5 py-1 text-[12px] font-medium border border-line hover:border-mute" title="Send a copy as a burn link">Share</button>
                              <button onClick={() => setRenaming(f.id)} className="rounded-md px-2 py-1 text-[12px] text-mute hover:text-fg">Rename</button>
                              <button onClick={() => setConfirmDel(f.id)} className="rounded-md px-2 py-1 text-[12px] text-mute hover:text-ember">Delete</button>
                            </>)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      {msg && <div role="alert" className="rounded-xl border border-warn/40 bg-warn/10 text-warn text-[13px] px-3.5 py-2.5">{msg}</div>}
      <p className="text-[12px] text-mute">Files, names and folders are encrypted in this browser before upload. Ashdrop stores only encrypted pieces and their sizes. Share sends a copy as a burn link; the original stays here.</p>
    </div>
  );
}

/* The Files side of the Vault tab: sign in, unlock, or the vault. */
let oauthReturn = null; // the hash is read once per page load, even if this mounts twice
function VaultFiles({ onShare, toast }) {
  const [, rerender] = useState(0);
  const [ret, setRet] = useState(() => (/[#&](oauth|oauth_error)=/.test(location.hash) ? { pending: true } : null));
  useEffect(() => {
    if (!ret?.pending) return;
    oauthReturn ||= account.finishOAuth(location.hash);
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    oauthReturn.then((r) => {
      if (r?.status === 'linked') toast(`${r.provider === 'apple' ? 'Apple' : 'Google'} is connected. You can sign in with it now.`);
      setRet(r && (r.error || r.status === 'new') ? r : null);
    });
  }, []);
  const s = account.session();
  const ready = () => { setRet(null); rerender(n => n + 1); };
  const ownerKey = getOwnerKey();
  if (ret?.pending) return <div className="text-center text-mute text-[13px] py-16">Signing you in…</div>;
  if (ret?.status === 'new') return <OAuthSetup res={ret} ownerKey={ownerKey || undefined} onReady={() => { ready(); toast('Your vault is ready. Tip: add a passkey in Settings → Account to unlock without the PIN.'); }} onCancel={() => setRet(null)} />;
  if (!s) return <AccountGate key={ret?.error || ''} initialMsg={ret?.error || ''} onReady={ready} ownerKey={ownerKey || undefined} />;
  if (!account.vaultKeyRaw()) return <UnlockGate email={s.email} onReady={ready} onSignOut={async () => { await account.signOut(); ready(); }} />;
  return <CloudVault onShare={onShare} toast={toast} onAccountChange={ready} />;
}

/* Settings → Account */
function AccountSettings({ toast }) {
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState(null); // 'password' | 'pin' | 'delete'
  const [providers, setProviders] = useState({});
  useEffect(() => { account.oauthProviders().then(setProviders); }, []);
  const [a, setA] = useState(''), [b, setB] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const s = account.session();
  const load = () => s && account.me().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { load(); }, []);
  if (!s) return <Row title="Not signed in" sub="Accounts are for the encrypted vault. Sharing links works without one."><div className="flex sm:justify-end text-[13px] text-mute">Open Vault → Files to sign in</div></Row>;
  const run = async (fn) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e.message); } setBusy(false); };
  const unlocked = !!account.vaultKeyRaw();
  return (
    <>
      <Row title={s.email} sub={info ? `${fmtBytes(info.used)} of ${fmtBytes(info.quota)} used` : 'Signed in'}>
        <div className="flex gap-2 sm:justify-end">
          {unlocked && <button onClick={() => { account.lockVault(); toast('Vault locked on this tab.'); load(); }} className="press rounded-lg px-3 py-2 text-[13px] font-semibold border border-line hover:border-mute">Lock vault</button>}
          <button id="acct-signout" onClick={async () => { await account.signOut(); location.reload(); }} className="press rounded-lg px-3 py-2 text-[13px] font-semibold border border-line hover:border-mute">Sign out</button>
        </div>
      </Row>
      <Row stack title="Passkeys" sub={account.passkeysSupported() ? `Unlock your vault with Face ID, a fingerprint or your device screen lock instead of your ${info?.hasPassword === false ? 'vault PIN' : 'password'}.` : 'This browser does not support passkeys.'}>
        {info?.passkeys?.length > 0 && (
          <ul id="passkey-list" className="flex flex-col gap-1.5">
            {info.passkeys.map(p => (
              <li key={p.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                <span className="flex-1 truncate">{p.name}</span><span className="text-mute text-[12px]">{new Date(p.created).toLocaleDateString()}</span>
                <button onClick={() => run(async () => { await account.removePasskey(p.id); load(); })} className="text-[12.5px] text-mute hover:text-ember">Remove</button>
              </li>
            ))}
          </ul>
        )}
        {account.passkeysSupported() && <div><button id="passkey-add" disabled={!unlocked || busy} onClick={() => run(async () => { await account.addPasskey(deviceType()); toast('Passkey added. You can unlock with it now.'); load(); })} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary disabled:opacity-50">{unlocked ? 'Add a passkey on this device' : 'Unlock your vault to add a passkey'}</button></div>}
      </Row>
      {(providers.google || providers.apple || info?.identities?.length > 0) && (
        <Row stack title="Sign in with" sub="Google or Apple only proves who you are. Your vault still needs your password, PIN or a passkey to open, so they never see your files.">
          <ul id="identity-list" className="flex flex-col gap-1.5">
            {[['google', 'Google', GoogleMark], ['apple', 'Apple', AppleMark]].filter(([id]) => providers[id] || info?.identities?.some(x => x.provider === id)).map(([id, name, Mark]) => {
              const linked = info?.identities?.find(x => x.provider === id);
              return (
                <li key={id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                  <Mark /><span className="flex-1 truncate">{name}{linked && <span className="text-mute"> · {linked.email}</span>}</span>
                  {linked ? <span className="text-[12px] text-mute">Connected</span>
                    : <button id={`connect-${id}`} onClick={() => run(() => account.startOAuth(id, 'link'))} className="text-[12.5px] font-semibold text-fg underline underline-offset-2 hover:text-ember">Connect</button>}
                </li>
              );
            })}
          </ul>
        </Row>
      )}
      <Row stack title="Vault PIN" sub={info?.pin ? 'Opens the vault on devices without a passkey. Stops working after 10 wrong tries.' : info && !info.hasPassword ? 'PIN unlock is off. Set a new PIN to turn it back on.' : 'Optional. A PIN can open the vault on devices without a passkey, as well as your password.'}>
        {phase === 'pin' ? (
          <form onSubmit={(e) => { e.preventDefault(); if (!account.pinOk(a)) return setMsg('Use a PIN of at least 6 digits or characters.'); if (a !== b) return setMsg('The two PINs are not the same.'); run(async () => { await account.setPin(a); setPhase(null); setA(''); setB(''); toast('Vault PIN saved.'); load(); }); }} className="flex flex-col sm:flex-row gap-2">
            <input id="pin-new" type="password" placeholder="New PIN" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} className={fieldCls} />
            <input id="pin-new2" type="password" placeholder="Repeat it" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} className={fieldCls} />
            <button id="pin-save" disabled={busy} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold btn-primary shrink-0">Save</button>
          </form>
        ) : <div><button id="pin-change" disabled={!unlocked} onClick={() => { setA(''); setB(''); setPhase('pin'); }} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute disabled:opacity-50">{!unlocked ? 'Unlock your vault first' : info?.pin ? 'Change PIN' : 'Set a PIN'}</button></div>}
      </Row>
      {info?.hasPassword !== false && <Row stack title="Password" sub="Changing it signs you out on your other devices.">
        {phase === 'password' ? (
          <form onSubmit={(e) => { e.preventDefault(); if (b.length < 10) return setMsg('Use at least 10 characters.'); run(async () => { await account.changePassword({ oldPassword: a, newPassword: b }); setPhase(null); setA(''); setB(''); toast('Password changed.'); }); }} className="flex flex-col sm:flex-row gap-2">
            <input type="password" placeholder="Current password" autoComplete="current-password" value={a} onChange={(e) => setA(e.target.value)} className={fieldCls} />
            <input type="password" placeholder="New password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} className={fieldCls} />
            <button disabled={busy} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold btn-primary shrink-0">Change</button>
          </form>
        ) : <div><button disabled={!unlocked} onClick={() => { setA(''); setB(''); setPhase('password'); }} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute disabled:opacity-50">{unlocked ? 'Change password' : 'Unlock your vault first'}</button></div>}
      </Row>}
      <Row stack title="Delete account" sub="Deletes every file in your vault and the account itself, right away. This cannot be undone.">
        {phase === 'delete' ? (
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { await account.deleteAccount(a); location.reload(); }); }} className="flex flex-col sm:flex-row gap-2">
            <input id="delete-secret" type="password" placeholder={info?.hasPassword === false ? 'Your vault PIN' : 'Your password'} value={a} onChange={(e) => setA(e.target.value)} className={fieldCls} />
            <button disabled={busy || !a} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold btn-burn shrink-0">Delete everything</button>
          </form>
        ) : info && !info.hasPassword && !info.pin ? <div className="text-[13px] text-mute">Set a vault PIN first, then you can delete the account with it.</div>
          : <div><button id="delete-account" onClick={() => { setA(''); setPhase('delete'); }} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember">Delete account</button></div>}
      </Row>
      {msg && <div role="alert" className="text-[13px] text-warn pb-3">{msg}</div>}
    </>
  );
}

/* Owner access → make invite codes for the vault beta. */
/* Site owner only: daily totals from the server. Real people, not bots: a bot does not make or open a link. */
function OwnerStats() {
  const [days, setDays] = useState(null);
  const [err, setErr] = useState('');
  const [range, setRange] = useState(14);
  useEffect(() => {
    fetch('/api/stats', { headers: { 'x-ashdrop-owner-key': getOwnerKey() || '' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Could not load usage.'))))
      .then(d => setDays(d.days || [])).catch(e => setErr(e.message));
  }, []);
  // fill in the quiet days, newest first
  const rows = [];
  for (let i = 0; i < range; i++) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    rows.push(days?.find(d => d.day === day) || { day });
  }
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const cols = [['created', 'Links made'], ['opened', 'Opened'], ['paired', 'Pairings'], ['signup', 'Accounts'], ['created_owner', 'Yours']];
  return (
    <Row stack title="Usage" sub="Real use, counted on the server: a bot does not make or open links. Only a number per day is kept, nothing about who. Your own links (with the owner key) are counted apart under Yours. Days are in UTC.">
      {err ? <div className="text-[12.5px] text-warn">{err}</div> : !days ? <div className="text-[12.5px] text-mute">Loading…</div> : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">{[7, 14, 30].map(n => <button key={n} onClick={() => setRange(n)} className={`press rounded-lg px-2.5 py-1 text-[12px] font-semibold border ${range === n ? 'border-fg text-fg' : 'border-line text-mute'}`}>{n} days</button>)}</div>
          <div className="overflow-x-auto">
            <table id="owner-stats" className="w-full text-[12.5px] tabular-nums">
              <thead><tr className="text-mute text-left"><th className="font-medium py-1.5 pr-3">Day</th>{cols.map(([k, l]) => <th key={k} className="font-medium py-1.5 px-2 text-right whitespace-nowrap">{l}</th>)}</tr></thead>
              <tbody>
                <tr className="border-t border-line font-semibold"><td className="py-1.5 pr-3">Total</td>{cols.map(([k]) => <td key={k} className="py-1.5 px-2 text-right">{sum(k)}</td>)}</tr>
                {rows.map(r => (
                  <tr key={r.day} className="border-t border-line">
                    <td className="py-1.5 pr-3 text-mute whitespace-nowrap">{new Date(r.day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                    {cols.map(([k]) => <td key={k} className={`py-1.5 px-2 text-right ${r[k] ? '' : 'text-mute/50'}`}>{r[k] || 0}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Row>
  );
}

function InviteMaker() {
  const [gb, setGb] = useState(5);
  const [codes, setCodes] = useState([]);
  const [msg, setMsg] = useState('');
  const make = async () => { setMsg(''); try { const r = await account.makeInvites(getOwnerKey(), 1, gb); setCodes(c => [...r.codes, ...c]); } catch (e) { setMsg(e.message); } };
  return (
    <Row stack title="Vault invites" sub="Each code creates one account. Codes expire after 30 days.">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[13px] flex items-center gap-2">Storage <select id="invite-gb" value={gb} onChange={(e) => setGb(Number(e.target.value))} className="bg-well border border-line rounded-lg px-2 py-1.5">{[1, 5, 10, 50, 100].map(n => <option key={n} value={n}>{n} GB</option>)}</select></label>
        <button id="invite-make" onClick={make} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary">Make an invite code</button>
      </div>
      {codes.length > 0 && <ul id="invite-codes" className="flex flex-col gap-1">{codes.map(c => <li key={c} className="font-mono text-[14px] select-all">{c}</li>)}</ul>}
      {msg && <div role="alert" className="text-[13px] text-warn">{msg}</div>}
    </Row>
  );
}

/* ---------- output modal ---------- */
function OutputModal({ result, onClose, onOpenRecipient, onPair }) {
  const [copied, setCopied] = useState(false);
  const linkRef = useRef(null);
  const link = `${location.origin}/p/${result.id}#${result.keyStr}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { const r = document.createRange(); r.selectNodeContents(linkRef.current); const s = getSelection(); s.removeAllRanges(); s.addRange(r); setCopied('select'); }
    setTimeout(() => setCopied(false), 2200);
  };
  // Copy it right away, so the next step is just pasting it. Browsers may refuse; then the button is there.
  const [auto, setAuto] = useState(false);
  useEffect(() => { if (!result.qrOnly) navigator.clipboard?.writeText(link).then(() => setAuto(true), () => {}); }, []);
  const canShare = !result.qrOnly && typeof navigator.share === 'function';
  const share = () => navigator.share({ title: 'Ashdrop', text: result.password ? 'Encrypted with Ashdrop. I will send you the password separately.' : 'Encrypted with Ashdrop.', url: link }).catch(() => {});
  const exp = EXPIRY.find(e => e.id === result.expiry);
  const [showQr, setShowQr] = useState(!!result.qrOnly);
  const [fullQr, setFullQr] = useState(false);
  return (
    <Modal onClose={onClose} labelledBy="out-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="label text-ok flex items-center gap-1.5"><span className="check-pop inline-block">✓</span>Sealed in your browser · {result.ms.toFixed(0)} ms</div>
          <h2 id="out-title" className="font-display text-2xl font-bold mt-1">{result.qrOnly ? 'Your secure QR code' : 'Your secure link'}</h2>
          {auto && <p id="auto-copied" className="text-[13px] text-mute mt-1">Already copied. Paste it into any chat or email.</p>}
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>

      <div className="mt-4 rounded-xl bg-well border border-line p-3 flex flex-col gap-3">
        {result.qrOnly ? (
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-cyan">{QR_ICON}</span>
            <span><span className="font-semibold">QR only.</span> <span className="text-mute">This link is never shown as text, so it cannot end up in a chat history or on a clipboard.</span></span>
          </div>
        ) : (
        <div ref={linkRef} className="font-mono text-[12.5px] break-all leading-relaxed min-w-0">
          <span className="text-mute">{location.protocol}//</span><span>{location.host}/p/{result.id}</span><span className="text-cyan">#<Scramble text={result.keyStr} /></span>
        </div>
        )}
        {!result.qrOnly && <div className="flex gap-2">
          <button id="copy-link" onClick={copy} className={`press flex-1 rounded-lg py-2.5 font-semibold transition-colors ${copied ? 'bg-ok text-ink' : 'btn-primary'}`}>
            {copied === true ? 'Copied to clipboard' : copied === 'select' ? 'Selected · press Ctrl/⌘ + C' : auto ? 'Copied · copy again' : 'Copy link'}
          </button>
          {canShare && <button id="share-link" onClick={share} className="press shrink-0 rounded-lg px-4 font-semibold border border-line hover:border-mute">Share</button>}
          <button id="show-qr" onClick={() => setShowQr(v => !v)} aria-expanded={showQr} title="Show QR code"
            className={`press shrink-0 rounded-lg px-3 border transition-colors ${showQr ? 'border-cyan text-cyan' : 'border-line text-mute hover:text-fg hover:border-mute'}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M17 21h4v-4M14 21v-3"/></svg>
            <span className="sr-only">QR code</span>
          </button>
        </div>}
        {showQr && (
          <div className="pop flex flex-col items-center gap-2 pt-1">
            <QR text={link} size={result.qrOnly ? 240 : 200} />
            <div className="text-[12px] text-mute text-center">Scan with your phone camera to open the link there. The key is in the code, so treat it like the link itself.</div>
            <button id="qr-full" onClick={() => setFullQr(true)}
              className="press mt-1 inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-cyan hover:text-cyan transition-colors">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
              Show full screen
            </button>
          </div>
        )}
        {fullQr && <QRFullscreen link={link} burn={result.expiry === 'burn'} onClose={() => setFullQr(false)} />}
      </div>
      {result.code && <CodeCard code={result.code} password={result.password} />}
      <SendToDevices result={result} onPair={onPair} />
      <LocalOnlyNote className="mt-3" />
      <p className="text-[12.5px] text-mute mt-2">The <span className="text-cyan font-mono">#fragment</span> is the decryption key. Browsers never send it to a server, so Ashdrop cannot read this {result.kind}.</p>

      <div className={`mt-4 rounded-xl p-3.5 flex gap-3 ${result.expiry === 'burn' ? 'bg-[var(--ember-soft)] border border-ember/50' : 'bg-well border border-line'}`}>
        <span className={`mt-0.5 shrink-0 ${result.expiry === 'burn' ? 'text-ember' : 'text-mute'}`}>{FLAME_ICON}</span>
        <div className="text-[13px]">
          <div className="font-semibold">{result.expiry === 'burn' ? 'Burns after the first view' : `Expires in ${exp.label}`}</div>
          <div className="text-mute">{result.expiry === 'burn'
            ? 'Do not open it yourself to test it. Link previews in chat apps can also trigger the burn.'
            : 'After that, the ciphertext is purged and the link returns 404.'}
            {result.password && ' The recipient also needs the password you set. Send it through a different channel.'}</div>
        </div>
      </div>

      {result.password && (
        <div className="mt-3 rounded-xl p-3.5 flex gap-3 bg-well border border-line">
          <span className="mt-0.5 shrink-0 text-mute">{LOCK_ICON}</span>
          <div className="text-[13px]">
            <div className="font-semibold">Locks out after {result.maxAttempts} wrong password{result.maxAttempts > 1 ? 's' : ''}</div>
            <div className="text-mute">The server releases no ciphertext until the password checks out. {result.maxAttempts === 1 ? 'One miss' : `Miss ${result.maxAttempts} times`} and it is deleted for good, so a leaked link alone is not enough.</div>
          </div>
        </div>
      )}

      <button id="test-recipient" onClick={onOpenRecipient} className="mt-4 w-full rounded-lg py-2.5 text-[13px] font-semibold border border-line hover:border-cyan hover:text-cyan transition-colors">
        {result.expiry === 'burn' ? 'Open it yourself (this uses up its one view)' : 'Open it yourself'}
      </button>

      <details className="mt-4 group">
        <summary className="label cursor-pointer select-none hover:text-fg">What the server receives</summary>
        <pre className="mt-2 rounded-xl bg-well border border-line p-3 font-mono text-[11px] leading-relaxed overflow-x-auto text-mute">{`POST /api/p  →  id: ${result.id}
{
  "ciphertext": "${hex(result.ct, 18)} …",
  "bytes": ${result.ct.byteLength},
  "iv": "${hex(result.iv, 12)}",${result.salt ? `\n  "salt": "${hex(result.salt, 16)}",` : ''}
  "expiry": "${result.expiry}",${result.password ? `\n  "auth_token": "${hex(result.authToken, 12)} …",\n  "max_attempts": ${result.maxAttempts},` : ''}
  "key": `}<span className="text-ember">never sent</span>{`
}`}</pre>
        <ul className="mt-3 flex flex-col gap-1.5">
          {result.log.map(([a, b], i) => (
            <li key={i} className="flex justify-between gap-3 text-[12px]"><span className="text-mute">{a}</span><span className="font-mono tabular text-fg/80 text-right">{b}</span></li>
          ))}
        </ul>
      </details>
    </Modal>
  );
}


/* ---------- recipient page (what ashdrop.cc/p/:id looks like) ---------- */
function AshBurst() {
  const bits = useMemo(() => Array.from({ length: 18 }, (_, i) => ({ l: 8 + Math.random() * 84, d: Math.random() * 0.5, s: 4 + Math.random() * 6, x: (Math.random() - .5) * 60 })), []);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {bits.map((b, i) => <span key={i} className="ash" style={{ left: b.l + '%', width: b.s, height: b.s, animationDelay: `calc(${b.d}s * var(--spd))`, '--dx': b.x + 'px' }} />)}
    </div>
  );
}

export function RecipientPage({ id, keyStr, onExit, standalone }) {
  const [meta, setMeta] = useState(null);
  const [state, setState] = useState(keyStr ? 'loading' : 'nokey');
  const [left, setLeft] = useState(null);
  useEffect(() => {
    if (!keyStr) return;
    let alive = true;
    getMeta(id).then(m => {
      if (!alive) return;
      setMeta(m); setLeft(m.attemptsLeft);
      setState(m.gone ? (m.reason === 'locked' ? 'lockedout' : 'gone') : 'intro');
    }).catch(() => alive && setState('neterror'));
    return () => { alive = false; };
  }, [id, keyStr]);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [out, setOut] = useState(null);
  const [burnedOnServer, setBurnedOnServer] = useState(false);
  const [serverLog, setServerLog] = useState([]);
  const [shakeKey, setShakeKey] = useState(0);
  const [burning, setBurning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dl, setDl] = useState(null);
  const [dlPct, setDlPct] = useState(null); // download progress for big files
  const log = (line) => setServerLog(l => [...l, line]);

  useEffect(() => { let alive = true; setDl(browserDownloads); return () => { alive = false; }; }, []);
  useEffect(() => () => out?.url && URL.revokeObjectURL(out.url), [out]);

  const unlock = async () => {
    setBusy(true); setMsg('');
    try {
      let token = new Uint8Array(0), pwKey = null;
      if (meta.needsPassword) { const d = await derivePasswordKeys(pw, meta.salt); token = d.token; pwKey = d.pwKey; }
      const res = await openLink(id, meta.needsPassword ? token : null, (p) => setDlPct(p < 1 ? p : null));
      if (res.status === 'denied') {
        log(`POST /open → 401 · token hash mismatch · ${res.attemptsLeft} left`);
        setLeft(res.attemptsLeft); setPw(''); setShakeKey(k => k + 1);
        setMsg(`Wrong password. ${res.attemptsLeft} attempt${res.attemptsLeft > 1 ? 's' : ''} left before this link is destroyed.`);
        return;
      }
      if (res.status === 'locked') {
        log('POST /open → 410 · limit reached · ciphertext deleted'); setLeft(0); setBurning(true);
        setTimeout(() => { setBurning(false); setState('lockedout'); }, dur(800));
        return;
      }
      if (res.status === 'gone') { log('POST /open → 404'); setState('gone'); return; }
      log(`POST /open → 200 · ${res.ct.byteLength} B ciphertext released${res.burned ? ' · record deleted (burn)' : ''}`);
      const opened = await openPayload({ ct: res.ct, iv: res.iv, iv2: res.iv2, keyStr, pwKey });
      const { header, content } = unpack(opened);
      const plain = content.slice().buffer;
      const { kind, name: fileName, mime, lang } = header;
      if (kind === 'files') {
        setOut({ kind, items: unbundleFiles(header, content) });
      } else if (kind === 'file') {
        const isImg = typeOf(fileName, mime) === 'image';
        setOut({ kind, fileName, mime, size: plain.byteLength, plain, url: isImg ? URL.createObjectURL(new Blob([plain], { type: mime || 'image/png' })) : null });
      } else setOut({ kind, lang: lang || 'Plain text', text: new TextDecoder().decode(plain) });
      setBurnedOnServer(res.burned); setState('open');
    } catch (e) { setMsg('Decryption failed. The link may be incomplete: ' + e.message); }
    finally { setBusy(false); }
  };

  const reveal = () => { if (meta.needsPassword) setState('password'); else unlock(); };
  const burnNow = () => { setBurning(true); setTimeout(() => { setBurning(false); setOut(null); setState('burned'); }, dur(900)); };
  const copyText = async () => { try { await navigator.clipboard.writeText(out.text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied('fail'); } };
  const save = async (filename = out.fileName, data = out.plain) => {
    if (!dl) { setMsg('Saving files is not available in this browser.'); return; }
    try { await dl.save({ filename, data: data instanceof Blob ? data : new Blob([data]) }); }
    catch (e) { if (e?.code === 'rejected_extension') setMsg('Your browser blocked this download. Try again, or allow downloads for this site.'); else if (e?.code !== 'declined') setMsg('Saving is not available in this view.'); }
  };

  if (state === 'loading' || state === 'nokey' || state === 'neterror') {
    return (
      <div className="fixed inset-0 z-[55] bg-ink grid place-items-center gutter fade-in">
        {state === 'loading'
          ? <div className="flex items-center gap-3 text-mute text-[14px]"><span className="w-5 h-5 rounded-full border-2 border-ember border-t-transparent animate-spin" />Checking the link…</div>
          : <div className="max-w-md text-center flex flex-col items-center gap-3">
              <span className="text-mute [&_svg]:w-10 [&_svg]:h-10">{LINK_ICON}</span>
              <h1 className="font-display text-[26px] font-bold">{state === 'nokey' ? 'This link is incomplete' : 'Could not reach Ashdrop'}</h1>
              <p className="text-mute text-[13.5px]">{state === 'nokey' ? 'The part after the # is missing. That part is the key, so the message cannot be opened without it. Ask the sender to copy the whole link again.' : 'Check your connection and reload the page. Nothing has been opened yet.'}</p>
              <button onClick={onExit} className="press mt-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember transition-colors">Go to Ashdrop</button>
            </div>}
      </div>
    );
  }
  const m = meta || {};
  const pips = m.maxAttempts ? Array.from({ length: m.maxAttempts }, (_, i) => i < left) : [];
  const what = out?.kind === 'file' ? 'file' : out?.kind === 'files' ? 'files' : 'secret';
  const fate = m.expiry === 'burn' ? 'burns after you open it' : `expires in ${timeLeft((m.expiresAt || 0) - Date.now())}`;
  const card = 'relative w-full max-w-xl mx-auto rounded-3xl border border-line bg-panel p-6 sm:p-8';

  return (
    <div className="fixed inset-0 z-[55] bg-ink overflow-y-auto fade-in" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true"
        style={{ display: 'none' }} />
      <div className="relative gutter max-w-6xl mx-auto py-3 flex items-center gap-3 border-b border-line">
        <Logo />
        <span className="hidden sm:flex items-center gap-2 font-mono text-[11.5px] text-mute min-w-0 truncate">
          <span className="w-2 h-2 rounded-full bg-ok shrink-0" aria-hidden="true" />{location.host}/p/{id}<span className="text-cyan">#••••••</span>
        </span>
        <button id="exit-recipient" onClick={onExit} className="press ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line text-mute hover:text-fg hover:border-mute transition-colors">{standalone ? 'Send your own secret' : '← Back to Ashdrop'}</button>
      </div>

      <main className="relative gutter py-10 sm:py-16 flex flex-col gap-6">
        {state === 'intro' && (
          <div className={`${card} pop text-center flex flex-col items-center gap-4`}>
            <span className="w-16 h-16 rounded-2xl grid place-items-center" style={{ background: 'var(--ember)' }} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
            </span>
            <h1 className="font-display text-[28px] sm:text-[34px] leading-tight">Someone sent you a {what}</h1>
            <p className="text-mute text-[14px] -mt-2">It {fate}.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <span className="text-[11.5px] rounded-full border border-line px-2.5 py-1 text-mute">End-to-end encrypted</span>
              {m.needsPassword && <span className="text-[11.5px] rounded-full border border-line px-2.5 py-1 text-mute">Password · {m.maxAttempts} tries</span>}
              <span className="text-[11.5px] rounded-full border border-ember/40 px-2.5 py-1 text-ember">{m.expiry === 'burn' ? 'One view only' : `Expires in ${timeLeft(m.expiresAt - Date.now())}`}</span>
            </div>
            <button id="reveal" onClick={reveal} disabled={busy} className="press mt-2 rounded-xl px-7 py-3.5 btn-burn font-display text-[17px]">
              {busy ? (dlPct !== null ? `Downloading ${Math.round(dlPct * 100)}%` : 'Decrypting…') : m.needsPassword ? 'Continue' : `Reveal ${what}`}
            </button>
            <p className="text-[12px] text-mute max-w-sm">Nothing is fetched until you click, so chat-app link previews cannot burn it. Decryption happens only in this browser.</p>
          </div>
        )}

        {state === 'password' && (
          <div className={`${card} step-fwd ${burning ? 'burn-away' : ''}`}>
            <h1 className="font-display text-[26px] sm:text-[30px] font-bold mt-1">Enter the password</h1>
            <p className="text-mute text-[13px] mt-1">The sender should have given it to you separately.</p>
            <div className="flex items-center gap-2 mt-5" aria-label={`${left} of ${m.maxAttempts} attempts left`}>
              {pips.map((on, i) => <span key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-500 ${on ? 'bg-ember' : 'bg-line scale-y-50'}`} />)}
              <span className="font-mono text-[11.5px] text-mute tabular ml-1 shrink-0">{left}/{m.maxAttempts} left</span>
            </div>
            <form key={shakeKey} className={`mt-4 flex gap-2 ${shakeKey ? 'shake' : ''}`} onSubmit={(e) => { e.preventDefault(); if (pw) unlock(); }}>
              <label htmlFor="rec-pw" className="sr-only">Password</label>
              <input id="rec-pw" type="password" autoFocus={FINE_POINTER} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
                className="flex-1 min-w-0 bg-well border border-line rounded-xl px-4 py-3 font-mono text-[14px] outline-hidden focus:border-cyan" autoComplete="off" />
              <button disabled={busy || !pw} className="press rounded-xl px-5 font-semibold btn-primary disabled:opacity-50">{busy ? (dlPct !== null ? `${Math.round(dlPct * 100)}%` : 'Checking…') : 'Unlock'}</button>
            </form>
            {msg && <div role="alert" className="mt-3 text-[12.5px] text-warn">{msg}</div>}
            <p className="text-[12px] text-mute mt-4">Your browser turns the password into a check token. The password and the key in the link never leave this device.</p>
          </div>
        )}

        {state === 'open' && out && (
          <div className={`${card} pop ${burning ? 'burn-away' : ''}`}>
            {burning && <AshBurst />}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: out.kind === 'paste' ? colorOf(out.lang) : 'var(--cyan)' }} aria-hidden="true" />
                <span className="font-mono text-[12.5px] text-mute truncate">{out.kind === 'paste' ? `message${extOf(out.lang)}` : out.kind === 'files' ? `${out.items.length} files · ${fmtBytes(out.items.reduce((n, f) => n + f.size, 0))}` : out.fileName}</span>
              </div>
              <span className="label text-ok flex items-center gap-1.5"><span className="check-pop inline-block">✓</span>Decrypted here</span>
            </div>
            {out.kind === 'paste' ? (
              <>
                <pre className="mt-4 rounded-2xl bg-well border border-line p-4 font-mono text-[12.5px] leading-[1.7] overflow-auto max-h-[50vh] whitespace-pre"
                  style={{ borderLeft: `3px solid ${colorOf(out.lang)}` }}>{out.text}</pre>
                <button onClick={copyText} className={`press mt-3 w-full rounded-xl py-3 font-semibold transition-colors ${copied === true ? 'bg-ok text-ink' : 'btn-primary'}`}>{copied === true ? 'Copied' : copied === 'fail' ? 'Select the text to copy it' : 'Copy text'}</button>
              </>
            ) : out.kind === 'files' ? (
              <>
                <ul id="rec-files" className="stagger mt-4 flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto">
                  {out.items.map((f, i) => {
                    const ts = TYPE_STYLE[typeOf(f.name, f.mime)];
                    return (
                      <li key={i} style={{ '--i': Math.min(i, 8) }} className="flex items-center gap-3 rounded-xl bg-well border border-line px-3 py-2.5">
                        <span className="w-10 h-10 rounded-lg grid place-items-center font-mono text-[10px] font-bold shrink-0" style={{ background: ts.c + '22', color: tint(ts.c), border: `1px solid ${ts.c}55` }} aria-hidden="true">{ts.t}</span>
                        <span className="min-w-0 flex-1"><span className="block font-mono text-[12.5px] truncate">{f.name}</span><span className="block text-mute text-[11.5px] tabular">{fmtBytes(f.size)}</span></span>
                        <button onClick={() => save(f.name, f.data)} aria-label={`Download ${f.name}`} className="press shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold border border-line hover:border-cyan hover:text-cyan transition-colors">Download</button>
                      </li>
                    );
                  })}
                </ul>
                <button id="download-all" onClick={() => save('ashdrop-files.zip', makeZip(out.items))} className="press mt-3 w-full rounded-xl py-3 font-semibold btn-primary transition">Download all ({out.items.length} files, .zip)</button>
              </>
            ) : (
              <>
                {out.url
                  ? <img src={out.url} alt={out.fileName} className="mt-4 rounded-2xl border border-line max-h-[50vh] mx-auto" />
                  : <div className="mt-4 rounded-2xl bg-well border border-line p-5 flex items-center gap-4">
                      {(() => { const ts = TYPE_STYLE[typeOf(out.fileName, out.mime)]; return <span className="w-12 h-12 rounded-xl grid place-items-center font-mono text-[11px] font-bold shrink-0" style={{ background: ts.c + '22', color: tint(ts.c), border: `1px solid ${ts.c}55` }}>{ts.t}</span>; })()}
                      <div className="min-w-0"><div className="font-mono text-[13px] break-all">{out.fileName}</div><div className="text-mute text-[12px] mt-0.5">{fmtBytes(out.size)} · decrypted intact</div></div>
                    </div>}
                <button onClick={() => save()} className="press mt-3 w-full rounded-xl py-3 font-semibold btn-primary transition">Download file</button>
              </>
            )}
            {msg && <div role="alert" className="mt-3 text-[12.5px] text-warn">{msg}</div>}
            {burnedOnServer ? (
              <div className="mt-4 rounded-xl border border-ember/50 bg-[var(--ember-soft)] p-4 flex flex-wrap items-center gap-3">
                <span className="text-ember shrink-0">{FLAME_ICON}</span>
                <div className="text-[13px] flex-1 min-w-[180px]"><div className="font-semibold">Already deleted from the server</div><div className="text-mute">It exists only in this tab now. Leave or burn it and it is gone for good.</div></div>
                <button id="burn-now" onClick={burnNow} className="press rounded-lg px-4 py-2 text-[13px] font-semibold btn-burn">Burn it now</button>
              </div>
            ) : (
              <div className="mt-4 text-[12.5px] text-mute text-center">This link stays readable for {timeLeft(m.expiresAt - Date.now())}, then it is purged.</div>
            )}
          </div>
        )}

        {(state === 'burned' || state === 'lockedout' || state === 'gone') && (
          <div className={`${card} pop text-center flex flex-col items-center gap-3`}>
            <span className={`[&_svg]:w-10 [&_svg]:h-10 ${state === 'burned' ? 'text-ember' : 'text-mute'}`}>{state === 'burned' ? FLAME_ICON : state === 'lockedout' ? LOCK_ICON : LINK_ICON}</span>
            <h1 className="font-display text-[26px] sm:text-[30px] font-bold">
              {state === 'burned' ? 'Burned. Nothing left.' : state === 'lockedout' ? 'This link has been destroyed' : 'Nothing here anymore'}
            </h1>
            <p className="text-mute text-[13.5px] max-w-sm">
              {state === 'burned' ? 'The message is gone from this tab and from the server. Nobody can open this link again, including you.'
                : state === 'lockedout' ? 'Too many wrong passwords. The encrypted data was deleted and cannot be recovered. Ask the sender for a new link.'
                : 'This link already burned, expired or was revoked by the sender. The encrypted data no longer exists.'}
            </p>
            <button onClick={onExit} className="press mt-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember transition-colors">Send your own secret</button>
          </div>
        )}

        {serverLog.length > 0 && (
          <details className="w-full max-w-xl mx-auto">
            <summary className="label cursor-pointer select-none hover:text-fg">What the server answered</summary>
            <ul className="mt-2 font-mono text-[11px] text-mute flex flex-col gap-1">{serverLog.map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>
          </details>
        )}
      </main>
      <Footer className="relative gutter pb-8" />
    </div>
  );
}

/* ---------- pro modal ---------- */
function ProModal({ onClose, initialGb = 10, reason, onSubscribe }) {
  const [gb, setGb] = useState(Math.min(100, Math.max(10, Math.ceil(initialGb / 5) * 5)));
  const [plan, setPlan] = useState('monthly');
  const monthly = 1.5 + gb * 0.09;
  const pass = monthly * 1.3;
  const price = plan === 'monthly' ? monthly : pass;
  const pct = ((gb - 10) / 90) * 100;
  const priceT = useTween(price, 260);
  return (
    <Modal onClose={onClose} labelledBy="pro-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="pro-title" className="font-display text-2xl font-bold mt-1">{reason ? 'Make room in your vault' : 'Pay for the bytes you keep'}</h2>
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      {reason && <div className="mt-3 rounded-lg bg-[var(--ember-soft)] border border-ember/40 px-3 py-2 text-[12.5px]">{reason}</div>}

      <div className="mt-5 grid grid-cols-2 gap-1 p-1 rounded-xl bg-well border border-line" role="radiogroup" aria-label="Billing">
        {[['monthly','Monthly plan','Renews, cancel anytime'],['pass','1-Month Single Pass','No renewal, no card kept']].map(([id, t, s]) => (
          <button key={id} role="radio" aria-checked={plan === id} onClick={() => setPlan(id)}
            className={`rounded-lg px-3 py-2 text-left transition-all duration-300 ${plan === id ? 'bg-panel ring-1 ring-ember/50 scale-[1.01]' : 'hover:bg-panel/50'}`}>
            <div className={`text-[13px] font-semibold ${plan === id ? 'text-fg' : 'text-mute'}`}>{t}</div>
            <div className="text-[11.5px] text-mute">{s}</div>
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-end justify-between gap-4">
        <div>
          <div className="label">Vault size</div>
          <div className="font-display text-5xl font-bold tabular leading-none mt-1">{gb}<span className="text-2xl text-mute ml-1">GB</span></div>
        </div>
        <div className="text-right">
          <div className="font-display text-4xl font-bold tabular leading-none">${priceT.toFixed(2)}</div>
          <div className="text-[12px] text-mute mt-1">{plan === 'monthly' ? 'per month' : 'one time · 30 days'}</div>
        </div>
      </div>
      <label htmlFor="gb" className="sr-only">Vault size in gigabytes</label>
      <input id="gb" type="range" min="10" max="100" step="5" value={gb} onChange={(e) => setGb(+e.target.value)} style={{ '--pct': pct + '%' }} className="w-full mt-5" />
      <div className="flex justify-between text-[11px] text-mute font-mono mt-1.5 tabular"><span>10 GB</span><span>55 GB</span><span>100 GB</span></div>

      <div className="mt-5 rounded-xl bg-well border border-line p-3.5 grid grid-cols-2 gap-y-2 gap-x-4 text-[12.5px]">
        <span className="text-mute">Your space</span><span className="font-mono tabular text-right">5 GB free → {gb} GB <span className="text-ok">({gb / 5}×)</span></span>
        <span className="text-mute">Hard byte limit</span><span className="font-mono tabular text-right">{(gb * 1e9).toLocaleString('en-US')} B</span>
        <span className="text-mute">Rate</span><span className="font-mono tabular text-right">$1.50 + $0.09/GB</span>
        <span className="text-mute">Per GB effective</span><span className="font-mono tabular text-right">${(price / gb).toFixed(3)}</span>
        <span className="text-mute">Overage</span><span className="font-mono tabular text-right">uploads blocked, never billed</span>
      </div>

      <button onClick={() => onSubscribe && onSubscribe({ gb, billing: plan, price })} className="press w-full mt-5 rounded-xl py-3 font-semibold bg-ember text-ink ember-glow hover:brightness-110 transition">
        {plan === 'monthly' ? `Start Pro · $${price.toFixed(2)}/mo` : `Buy 30-day pass · $${price.toFixed(2)}`}
      </button>
      <p className="text-[12px] text-mute mt-3 leading-relaxed">
        <span className="text-fg font-medium">1-click cancel.</span> One button in Settings ends billing immediately. No retention survey, no email required. Your vault stays readable for 30 days so you can export it.
      </p>
    </Modal>
  );
}

/* ---------- vault tab ---------- */
const FREE_CAP = 5e9; // 5 GB, decimal, metered to the byte
const fmtDec = (n) => n < 1e3 ? `${n} B` : n < 1e6 ? `${(n/1e3).toFixed(1)} KB` : n < 1e9 ? `${(n/1e6).toFixed(1)} MB` : `${(n/1e9).toFixed(2)} GB`;
const TYPE_STYLE = {
  image: { c: '#c46bff', t: 'IMG' }, pdf: { c: '#ff8fa3', t: 'PDF' }, archive: { c: '#f5c451', t: 'ZIP' },
  doc: { c: '#5aa9ff', t: 'DOC' }, text: { c: '#7ee2a8', t: 'TXT' }, video: { c: '#ff9a62', t: 'VID' }, other: { c: '#8a93a3', t: 'BIN' },
};
const typeOf = (name, mime = '') => {
  const e = name.split('.').pop().toLowerCase();
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','heic','svg'].includes(e)) return 'image';
  if (mime.startsWith('video/') || ['mp4','mov','mkv','webm'].includes(e)) return 'video';
  if (e === 'pdf') return 'pdf';
  if (['zip','tar','gz','7z','rar'].includes(e)) return 'archive';
  if (['doc','docx','xls','xlsx','ppt','pptx','pages','key','odt'].includes(e)) return 'doc';
  if (mime.startsWith('text/') || ['txt','md','json','csv','yml','yaml','env','js','ts','py','sh','sql','log'].includes(e)) return 'text';
  return 'other';
};

const FOLDER_PALETTE = [
  ['Ember', '#ff7a3d'], ['Gold', '#f5b83d'], ['Green', '#57d18c'], ['Cyan', '#5cd6e0'],
  ['Blue', '#5aa9ff'], ['Violet', '#b56bff'], ['Pink', '#ff5fa2'], ['Slate', '#8a93a3'],
];
const folderColor = (colors, name) => colors[name] || FOLDER_PALETTE[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % FOLDER_PALETTE.length][1];

const SHARE_LIMIT = 25 * 1024 * 1024; // free per-share cap, same as the dropzone
async function vaultItemToFile(item) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: item.iv }, item.key, item.ct);
  return new File([plain], item.name, { type: item.mime || 'application/octet-stream' });
}

function PreviewModal({ item, onClose, onDownload }) {
  const [state, setState] = useState({ phase: 'decrypting' });
  useEffect(() => {
    let url;
    (async () => {
      try {
        const t0 = performance.now();
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: item.iv }, item.key, item.ct);
        const ms = performance.now() - t0;
        const kind = typeOf(item.name, item.mime);
        if (kind === 'image') { url = URL.createObjectURL(new Blob([plain], { type: item.mime || 'image/png' })); setState({ phase: 'image', url, ms, bytes: plain.byteLength }); }
        else if (kind === 'text') setState({ phase: 'text', text: new TextDecoder().decode(plain.slice(0, 20000)), ms, bytes: plain.byteLength, cut: plain.byteLength > 20000 });
        else setState({ phase: 'info', ms, bytes: plain.byteLength });
      } catch (e) { setState({ phase: 'error', msg: e.message }); }
    })();
    return () => url && URL.revokeObjectURL(url);
  }, [item]);
  return (
    <Modal onClose={onClose} labelledBy="pv-title">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="label text-ok">{state.ms != null ? `Decrypted in this tab · ${state.ms.toFixed(0)} ms` : 'Decrypting…'}</div>
          <h2 id="pv-title" className="font-display text-xl font-bold mt-1 break-all">{item.name}</h2>
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      <div className="mt-4">
        {state.phase === 'image' && <img src={state.url} alt={item.name} className="rounded-xl border border-line max-h-80 mx-auto" />}
        {state.phase === 'text' && <pre className="rounded-xl bg-well border border-line p-3 font-mono text-[12px] leading-relaxed overflow-auto max-h-72 whitespace-pre">{state.text}{state.cut && '\n…'}</pre>}
        {state.phase === 'info' && <div className="rounded-xl bg-well border border-line p-4 text-[13px]"><div className="font-semibold">{fmtDec(state.bytes)} decrypted intact</div><div className="text-mute mt-1">No preview for this file type. Download it to open it on your device.</div></div>}
        {state.phase === 'error' && <div className="text-warn text-[13px]">Could not decrypt: {state.msg}</div>}
      </div>
      {state.phase !== 'decrypting' && state.phase !== 'error' && (
        <button onClick={onDownload} className="mt-4 w-full rounded-lg py-2.5 font-semibold btn-primary transition-colors flex items-center justify-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>
          Download decrypted file
        </button>
      )}
    </Modal>
  );
}


/* Everything about folders in one place: add, rename, recolor, reorder, delete. Nothing changes until Save. */
function FolderEditor({ folders, colors, counts, onSave, onClose }) {
  const [rows, setRows] = useState(() => folders.map((name, i) => ({ key: 'f' + i, orig: name, name, color: folderColor(colors, name) })));
  const [openColor, setOpenColor] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [deleted, setDeleted] = useState([]);
  const [err, setErr] = useState('');
  const listEnd = useRef(null);
  const update = (key, patch) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const moveRow = (i, d) => setRows(rs => { const j = i + d; if (j < 0 || j >= rs.length) return rs; const c = [...rs]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const add = () => {
    const used = new Set(rows.map(r => r.color));
    const color = (FOLDER_PALETTE.find(([, c]) => !used.has(c)) || FOLDER_PALETTE[rows.length % FOLDER_PALETTE.length])[1];
    const key = 'n' + Date.now();
    setRows(rs => [...rs, { key, orig: null, name: '', color }]);
    setTimeout(() => { document.getElementById(`folder-name-${key}`)?.focus(); listEnd.current?.scrollIntoView({ block: 'nearest' }); }, 30);
  };
  const remove = (r) => { if (r.orig) setDeleted(d => [...d, r.orig]); setRows(rs => rs.filter(x => x.key !== r.key)); setConfirmDel(null); };
  const save = () => {
    const clean = rows.map(r => ({ ...r, name: r.name.trim().slice(0, 24) }));
    if (clean.some(r => !r.name)) return setErr('Every folder needs a name. Name it or delete the empty one.');
    const lower = clean.map(r => r.name.toLowerCase());
    const dup = clean.find((r, i) => lower.indexOf(r.name.toLowerCase()) !== i);
    if (dup) return setErr(`There are two folders called "${dup.name}". Give one a different name.`);
    const renames = {};
    clean.forEach(r => { if (r.orig && r.orig !== r.name) renames[r.orig] = r.name; });
    onSave({ list: clean.map(r => r.name), colors: Object.fromEntries(clean.map(r => [r.name, r.color])), renames, deleted });
  };
  const iconBtn = 'w-8 h-8 rounded-lg grid place-items-center text-mute hover:text-fg hover:bg-well transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-mute';
  return (
    <Modal onClose={onClose} labelledBy="folders-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="label">Vault</div>
          <h2 id="folders-title" className="font-display text-2xl font-bold mt-1">Edit folders</h2>
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      <p className="text-[13px] text-mute mt-1">Rename, recolor, reorder or delete. Deleting a folder keeps its files; they move to All files.</p>

      <div className="mt-4 flex flex-col gap-2 max-h-[52vh] overflow-y-auto -mx-1 px-1">
        {rows.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-mute">No folders yet. Add one to start sorting your files.</div>
        )}
        {rows.map((r, i) => (
          <div key={r.key} className="pop rounded-xl border border-line bg-well p-2.5 flex flex-col gap-2" style={{ borderLeft: `3px solid ${r.color}` }}>
            <div className="flex items-center gap-2">
              <button id={`folder-color-btn-${i}`} onClick={() => setOpenColor(openColor === r.key ? null : r.key)} aria-expanded={openColor === r.key}
                aria-label={`Change color of ${r.name || 'new folder'}`} title="Change color"
                className="press w-8 h-8 rounded-lg grid place-items-center shrink-0 border border-line hover:border-mute transition-colors">
                <span className="w-4 h-4 rounded-full" style={{ background: r.color }} />
              </button>
              <label htmlFor={`folder-name-${r.key}`} className="sr-only">Folder name</label>
              <input id={`folder-name-${r.key}`} value={r.name} maxLength={24} placeholder="Folder name"
                onChange={(e) => { update(r.key, { name: e.target.value }); setErr(''); }}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
                className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-3 py-1.5 text-[13.5px] outline-hidden focus:border-cyan transition-colors" />
              {r.orig && <span className="text-[11.5px] text-mute tabular shrink-0 hidden sm:inline">{counts[r.orig] || 0} file{counts[r.orig] === 1 ? '' : 's'}</span>}
              <button onClick={() => moveRow(i, -1)} disabled={i === 0} className={iconBtn} aria-label="Move up" title="Move up">↑</button>
              <button onClick={() => moveRow(i, 1)} disabled={i === rows.length - 1} className={iconBtn} aria-label="Move down" title="Move down">↓</button>
              <button id={`folder-delete-${i}`} onClick={() => (r.orig && counts[r.orig] ? setConfirmDel(r.key) : remove(r))} className={`${iconBtn} hover:!text-ember`} aria-label={`Delete ${r.name || 'folder'}`} title="Delete">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              </button>
            </div>
            {openColor === r.key && (
              <div className="pop flex flex-wrap gap-1.5 pl-10" role="radiogroup" aria-label="Folder color">
                {FOLDER_PALETTE.map(([nm, c]) => (
                  <button key={c} id={`folder-swatch-${i}-${nm.toLowerCase()}`} role="radio" aria-checked={r.color === c} aria-label={nm} title={nm}
                    onClick={() => { update(r.key, { color: c }); setOpenColor(null); }}
                    className={`press w-7 h-7 rounded-full grid place-items-center transition-transform duration-300 ${r.color === c ? 'scale-110' : 'hover:scale-110'}`}
                    style={{ background: c, boxShadow: r.color === c ? `0 0 0 2px var(--well), 0 0 0 4px ${c}` : 'none' }}>
                    {r.color === c && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0d0f12" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>}
                  </button>
                ))}
              </div>
            )}
            {confirmDel === r.key && (
              <div className="pop flex flex-wrap items-center gap-2 pl-10 text-[12.5px]">
                <span className="text-mute">Delete "{r.orig}"? Its {counts[r.orig]} file{counts[r.orig] === 1 ? '' : 's'} move to All files.</span>
                <button id={`folder-delete-confirm-${i}`} onClick={() => remove(r)} className="rounded-md px-2.5 py-1 font-semibold bg-ember text-ink">Delete folder</button>
                <button onClick={() => setConfirmDel(null)} className="rounded-md px-2 py-1 text-mute hover:text-fg">Keep</button>
              </div>
            )}
          </div>
        ))}
        <div ref={listEnd} />
      </div>

      <button id="folder-add" onClick={add} className="press mt-3 w-full rounded-xl py-2.5 text-[13px] font-semibold border border-dashed border-line text-mute hover:text-ember hover:border-ember transition-colors">+ Add folder</button>
      {err && <div role="alert" className="mt-3 text-[12.5px] text-warn">{err}</div>}
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="press rounded-xl px-4 py-3 text-[14px] font-semibold border border-line text-mute hover:text-fg hover:border-mute transition-colors">Cancel</button>
        <button id="folders-save" onClick={save} className="press flex-1 rounded-xl py-3 font-semibold bg-ember text-ink hover:brightness-110 transition">Save changes</button>
      </div>
    </Modal>
  );
}

function Vault({ files, setFiles, onPro, onShare, cap = FREE_CAP, plan, folders, setFolders, folderColors, setFolderColors, recoverySaved, onRecovery }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('new');
  const [folder, setFolder] = useState('all');
  const [menuId, setMenuId] = useState(null);
  const [editing, setEditing] = useState(false);
  // If the open folder was renamed or deleted, fall back to All files.
  useEffect(() => { if (folder !== 'all' && !folders.includes(folder)) setFolder('all'); }, [folders, folder]);
  const saveFolders = ({ list, colors, renames, deleted }) => {
    setFiles(prev => prev.map(f => {
      if (!f.folder) return f;
      if (deleted.includes(f.folder)) return { ...f, folder: null };
      return renames[f.folder] ? { ...f, folder: renames[f.folder] } : f;
    }));
    if (folder !== 'all' && renames[folder]) setFolder(renames[folder]);
    setFolders(list); setFolderColors(colors); setEditing(false);
  };
  useEffect(() => {
    if (!menuId) return;
    const close = (e) => { if (!e.target.closest('[data-menu]')) setMenuId(null); };
    const esc = (e) => e.key === 'Escape' && setMenuId(null);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menuId]);
  const move = (id, fd) => { setFiles(prev => prev.map(x => (x.id === id ? { ...x, folder: fd } : x))); setMenuId(null); };
  const shown = useMemo(() => {
    let list = files.filter(f => (folder === 'all' || f.folder === folder) && f.name.toLowerCase().includes(q.trim().toLowerCase()));
    const by = { new: (a, b) => (b.ts || 0) - (a.ts || 0), name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => b.size - a.size }[sort];
    return [...list].sort(by);
  }, [files, folder, q, sort]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null); // { text, gb }
  const [confirmId, setConfirmId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [toast, setToast] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [dl, setDl] = useState(null);
  const input = useRef(null);

  useEffect(() => {
    let alive = true;
    setDl(browserDownloads);
    return () => { alive = false; };
  }, []);

  const flash = (text, tone = 'ok') => { setToast({ text, tone }); setTimeout(() => setToast(t => (t && t.text === text ? null : t)), 4000); };

  // Pull a file out: decrypt in this tab, then hand the plaintext to the viewer's save prompt.
  const download = async (f) => {
    if (f.example) return;
    if (!dl) { flash('Saving files is not available in this view.', 'warn'); return; }
    setSavingId(f.id);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: f.iv }, f.key, f.ct);
      await dl.save({ filename: f.name, data: new Blob([plain]) });
      flash(`${f.name} decrypted and saved to your device.`);
    } catch (e) {
      const code = e && e.code;
      if (code === 'declined') {}
      else if (code === 'rejected_extension') flash(`Your browser blocked this download. Try again, or allow downloads for this site.`, 'warn');
      else if (code === 'too_large') flash(`${f.name} is too large to save from this preview.`, 'warn');
      else if (code === 'rate_limited') flash('A save prompt is already open. Finish that one first.', 'warn');
      else if (code) flash('Saving files is not available in this view.', 'warn');
      else flash(`Could not decrypt ${f.name}: ${e.message}`, 'warn');
    } finally { setSavingId(null); }
  };

  const used = files.reduce((a, f) => a + f.size, 0);
  const usedT = useTween(used, 900, 0);
  const [removing, setRemoving] = useState(null);
  const free = Math.max(0, cap - used);
  const pct = Math.min(100, (used / cap) * 100);
  const level = pct >= 100 ? 'full' : pct >= 80 ? 'near' : 'ok';
  const barColor = level === 'full' ? 'var(--ember)' : level === 'near' ? 'var(--warn)' : 'var(--fg)';
  const neededGb = (extra) => Math.min(100, Math.max(plan && plan.tier === 'pro' ? plan.gb + 5 : 10, Math.ceil((used + extra) / 1e9 / 5) * 5));
  const isPro = plan && plan.tier === 'pro';

  const addFiles = async (list) => {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    setNotice(null);
    const total = arr.reduce((a, f) => a + f.size + 16, 0);
    if (total > free) {
      const name = arr.length === 1 ? arr[0].name : `These ${arr.length} files`;
      setNotice({ text: `${name} ${arr.length === 1 ? 'is' : 'are'} ${fmtDec(total)}, and you have ${fmtDec(free)} left.`, gb: neededGb(total) });
      return;
    }
    for (const f of arr) {
      setBusy(f.name);
      try {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await f.arrayBuffer());
        const item = { id: randId(), name: f.name, mime: f.type, size: ct.byteLength, date: 'Today', ts: Date.now(), folder: folder === 'all' ? null : folder, key, iv, ct, fresh: true };
        setFiles(prev => [item, ...prev]);
      } catch (e) { setNotice({ text: `Could not encrypt ${f.name}: ${e.message}` }); }
    }
    setBusy(null);
  };

  const remove = (id) => {
    setRemoving(id); setConfirmId(null); setNotice(null);
    setTimeout(() => { setFiles(prev => prev.filter(f => f.id !== id)); setRemoving(null); }, dur(280));
  };

  return (
    <div className="flex flex-col gap-5">
      {FEATURES.recovery && !recoverySaved && (
        <div className="pop rounded-2xl border border-cyan/40 px-4 sm:px-5 py-4 flex flex-wrap items-center gap-3"
          style={{ background: 'var(--panel)' }}>
          <span className="w-10 h-10 rounded-xl grid place-items-center shrink-0 bg-well border border-cyan/40 text-cyan" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l3 3M14 9l2 2"/></svg>
          </span>
          <div className="flex-1 min-w-[200px] text-[13px]">
            <div className="font-semibold">Save your recovery key</div>
            <div className="text-mute">If you forget your password, it is the only way back into your vault. Ashdrop cannot reset it for you.</div>
          </div>
          <button id="open-recovery" onClick={onRecovery} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary transition shrink-0">Get my key</button>
        </div>
      )}
      {/* usage */}
      <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="label">{FEATURES.pro ? (isPro ? `Pro · ${plan.gb} GB` : 'Free plan') : 'Storage'}</span>
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-cyan border border-cyan/40 rounded-full px-2 py-px">Private</span>
            </div>
            <div className="font-display text-[34px] font-bold tabular mt-1 leading-none">{fmtDec(Math.round(usedT))} <span className="text-mute text-lg font-medium">of {cap / 1e9} GB</span></div>
          </div>
          {FEATURES.pro && <button onClick={() => onPro(isPro ? Math.min(100, plan.gb + 10) : 10)} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold bg-[var(--ember-soft)] text-ember border border-ember/40 hover:bg-ember hover:text-ink transition-colors">Get more space</button>}
        </div>
        <div className="mt-5 h-3 rounded-full bg-well overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label="Vault usage">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(Math.min(100, (usedT / cap) * 100), 1)}%`, background: barColor, transitionTimingFunction: 'var(--ease-out)' }} />
        </div>
        <div className="flex justify-between text-[11.5px] font-mono text-mute mt-1.5 tabular gap-3 flex-wrap">
          <span>{used.toLocaleString('en-US')} B used</span><span>{free.toLocaleString('en-US')} B free</span>
        </div>

        {level !== 'ok' && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 flex flex-wrap items-center gap-3">
            <div className="text-[13px] flex-1 min-w-[200px]">
              <span className="font-semibold text-warn">{level === 'full' ? 'Your vault is full.' : `You've used ${pct.toFixed(0)}% of your space.`}</span>
              <span className="text-mute">{!FEATURES.pro ? ' Delete files you no longer need to make room.' : isPro ? ' Move to a bigger plan, or delete files you no longer need.' : ' Add 10 GB for $2.40/mo, or delete files you no longer need.'}</span>
            </div>
            {FEATURES.pro && <button onClick={() => onPro(isPro ? Math.min(100, plan.gb + 10) : 10)} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold bg-ember text-ink hover:brightness-110 transition shrink-0">{isPro ? 'Get more space' : 'Add 10 GB'}</button>}
          </div>
        )}
      </div>

      {/* upload */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        onClick={() => !busy && input.current.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current.click()}
        role="button" tabIndex={0} aria-label="Add files to your vault"
        className={`rounded-2xl border-2 border-dashed px-5 py-6 flex items-center gap-4 cursor-pointer transition-all duration-300 ${drag ? 'border-ember bg-[var(--ember-soft)] scale-[1.01]' : 'border-line hover:border-mute'}`}>
        <span className="w-12 h-12 rounded-xl grid place-items-center shrink-0" style={{ background: 'var(--ember)' }} aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round"><path d="M12 16V4M6 10l6-6 6 6M5 20h14"/></svg>
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-[15px]">{busy ? `Encrypting ${busy}…` : 'Add files to your vault'}</div>
          <div className="text-mute text-[12.5px]">Drop files here or click to browse. Each file is encrypted before it is stored.</div>
        </div>
        <input ref={input} id="vault-file" type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {notice && (
        <div className="rounded-xl border border-ember/50 bg-[var(--ember-soft)] px-4 py-3 flex flex-wrap items-center gap-3 pop" role="alert">
          <div className="text-[13px] flex-1 min-w-[200px]">{notice.text}{FEATURES.pro && notice.gb && <span className="text-mute"> Pro with {notice.gb} GB fits it.</span>}</div>
          {FEATURES.pro && notice.gb && <button onClick={() => onPro(notice.gb, notice.text)} className="rounded-lg px-3.5 py-2 text-[13px] font-semibold bg-ember text-ink hover:brightness-110 transition shrink-0">Upgrade to {notice.gb} GB</button>}
          <button onClick={() => setNotice(null)} className="text-mute hover:text-fg text-[13px]" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* files */}
      <div className="rounded-2xl border border-line">
        <div className="flex flex-col gap-3 px-4 py-3 bg-panel border-b border-line rounded-t-2xl">
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-mute" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <label htmlFor="vault-search" className="sr-only">Search files</label>
              <input id="vault-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your vault"
                className="w-full bg-well border border-line rounded-lg pl-9 pr-8 py-2 text-[13px] outline-hidden focus:border-cyan transition-colors" />
              {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-mute hover:text-fg px-1" aria-label="Clear search">✕</button>}
            </div>
            <label htmlFor="vault-sort" className="sr-only">Sort files</label>
            <select id="vault-sort" value={sort} onChange={(e) => setSort(e.target.value)} className="shrink-0 bg-well border border-line rounded-lg px-2.5 text-[13px] text-fg outline-hidden focus:border-cyan">
              <option value="new">Newest</option><option value="name">Name</option><option value="size">Largest</option>
            </select>
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5" role="tablist" aria-label="Folders">
            {[['all', 'All files', files.length], ...folders.map(fd => [fd, fd, files.filter(x => x.folder === fd).length])].map(([id, label, n]) => {
              const on = folder === id, fc = id === 'all' ? null : folderColor(folderColors, id);
              return (
                <button key={id} role="tab" aria-selected={on} onClick={() => setFolder(id)}
                  style={fc ? (on ? { background: mix(fc, 24), borderColor: fc, color: 'var(--fg)' } : { borderColor: mix(fc, 40, 'var(--line)') }) : undefined}
                  className={`press shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium border transition-colors duration-300 ${on ? (fc ? '' : 'bg-fg text-ink border-fg') : 'border-line text-mute hover:text-fg hover:border-mute'}`}>
                  {fc && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: fc }} aria-hidden="true" />}
                  {label} <span className={`tabular ${on ? 'opacity-70' : 'opacity-60'}`}>{n}</span>
                </button>
              );
            })}
            <button id="edit-folders" onClick={() => setEditing(true)}
              className="press shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium border border-dashed border-line text-mute hover:text-ember hover:border-ember transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              {folders.length ? 'Edit folders' : 'Add folders'}
            </button>
          </div>
        </div>
        {files.length === 0 ? (
          <div className="px-4 py-10 text-center text-mute text-[13px]">Your vault is empty. Add a file above to encrypt and store it.</div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-10 text-center text-mute text-[13px]">{q ? `No files match "${q}".` : 'This folder is empty. Upload while it is selected, or move files here from their ⋯ menu.'}</div>
        ) : (
          <ul className="stagger" key={folder + sort}>
            {shown.map((f, fi) => {
              const ts = TYPE_STYLE[typeOf(f.name, f.mime)];
              return (
                <li key={f.id} style={{ '--i': Math.min(fi, 8), zIndex: menuId === f.id ? 20 : undefined }} className={`relative flex items-center gap-3 px-4 py-3 border-b border-line last:border-0 last:rounded-b-2xl hover:bg-panel/60 transition-colors ${removing === f.id ? 'row-out' : ''}`}>
                  <span className="w-9 h-9 rounded-lg grid place-items-center font-mono text-[9.5px] font-bold shrink-0" style={{ background: ts.c + '22', color: tint(ts.c), border: `1px solid ${ts.c}55` }} aria-hidden="true">{ts.t}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12.5px] truncate">{f.name}</div>
                    <div className="text-[11.5px] text-mute flex items-center gap-2">
                      <span className="tabular">{fmtDec(f.size)}</span><span aria-hidden="true">·</span><span>{f.date}</span>
                      {f.folder && folder === 'all' && (() => { const fc = folderColor(folderColors, f.folder); return (
                        <span className="hidden sm:inline-flex items-center gap-1 text-[10.5px] rounded-sm px-1.5 border" style={{ background: mix(fc, 16, 'var(--well)'), borderColor: mix(fc, 45, 'var(--line)'), color: 'var(--fg)' }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: fc }} aria-hidden="true" />{f.folder}
                        </span>); })()}
                      {f.example && <span className="text-[10px] uppercase tracking-wider border border-line rounded-sm px-1.5">Example</span>}
                      {f.fresh && <span className="text-[10px] uppercase tracking-wider text-ok">Encrypted</span>}
                    </div>
                  </div>
                  {confirmId === f.id ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[12px] text-mute hidden sm:inline">Delete forever?</span>
                      <button onClick={() => remove(f.id)} className="rounded-md px-2.5 py-1 text-[12px] font-semibold bg-ember text-ink">Delete</button>
                      <button onClick={() => setConfirmId(null)} className="rounded-md px-2.5 py-1 text-[12px] text-mute hover:text-fg">Keep</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => !f.example && setPreview(f)} disabled={f.example} title={f.example ? 'Example file, nothing to open' : 'Decrypt and open'}
                        className="rounded-md px-2.5 py-1 text-[12px] font-medium border border-line hover:border-cyan hover:text-cyan transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg">Open</button>
                      <button onClick={() => download(f)} disabled={f.example || savingId === f.id}
                        title={f.example ? 'Example file, nothing to download' : 'Decrypt and save to your device'} aria-label={`Download ${f.name}`}
                        className="rounded-md px-2 py-1 border border-line hover:border-ok hover:text-ok transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg">
                        {savingId === f.id
                          ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-ok border-t-transparent animate-spin" />
                          : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>}
                      </button>
                      <button onClick={() => {
                          if (f.example) return;
                          if (f.size - 16 > SHARE_LIMIT) { setNotice({ text: `${f.name} is ${fmtDec(f.size)}. Share links carry files up to 25 MB.`, gb: 10 }); return; }
                          onShare(f);
                        }} disabled={f.example} title={f.example ? 'Example file, nothing to share' : 'Send as a secure link'}
                        className="rounded-md px-2.5 py-1 text-[12px] font-semibold bg-[var(--ember-soft)] text-ember border border-ember/40 hover:bg-ember hover:text-ink transition-colors disabled:opacity-40 disabled:hover:bg-[var(--ember-soft)] disabled:hover:text-ember">Share</button>
                      <div className="relative" data-menu>
                        <button onClick={() => setMenuId(menuId === f.id ? null : f.id)} aria-haspopup="menu" aria-expanded={menuId === f.id} aria-label={`More actions for ${f.name}`}
                          className={`rounded-md px-2 py-1 text-[14px] leading-none border transition-colors ${menuId === f.id ? 'border-mute text-fg' : 'border-transparent text-mute hover:text-fg'}`}>⋯</button>
                        {menuId === f.id && (
                          <div role="menu" className="pop absolute right-0 top-full mt-1 z-30 w-52 rounded-xl border border-line bg-panel shadow-2xl p-1">
                            <div className="label px-2.5 pt-1.5 pb-1">Move to</div>
                            {[null, ...folders].map(fd => (
                              <button key={fd || '_none'} role="menuitem" onClick={() => move(f.id, fd)}
                                className="w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-well flex items-center justify-between gap-2">
                                <span className={`inline-flex items-center gap-2 ${fd ? '' : 'text-mute'}`}>
                                  <span className="w-2 h-2 rounded-full" style={{ background: fd ? folderColor(folderColors, fd) : 'transparent', border: fd ? 'none' : '1px dashed var(--mute)' }} aria-hidden="true" />
                                  {fd || 'No folder'}
                                </span>{(f.folder || null) === fd && <span className="text-ember">✓</span>}
                              </button>
                            ))}
                            <div className="h-px bg-line my-1" />
                            <button role="menuitem" onClick={() => { setConfirmId(f.id); setMenuId(null); }} className="w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] text-ember hover:bg-[var(--ember-soft)]">Delete…</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[12px] text-mute text-center">Download decrypts a file in this tab and saves it to your device. Share sends a copy as a burn link; the original stays in your vault.</p>
      {editing && <FolderEditor folders={folders} colors={folderColors} counts={Object.fromEntries(folders.map(fd => [fd, files.filter(f => f.folder === fd).length]))}
        onSave={saveFolders} onClose={() => setEditing(false)} />}
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} onDownload={() => download(preview)} />}
      {toast && (
        <div className="fixed z-50 inset-x-0 flex justify-center gutter pointer-events-none" style={{ bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))' }}>
          <div key={toast.text} className="pop rounded-xl border px-4 py-2.5 text-[13px] shadow-2xl"
            style={{ background: 'var(--panel)', borderColor: toast.tone === 'ok' ? 'rgb(var(--c-ok) / .5)' : 'rgb(var(--c-warn) / .5)', color: toast.tone === 'ok' ? 'var(--ok)' : 'var(--warn)' }}
            role="status">{toast.text}</div>
        </div>
      )}
    </div>
  );
}

/* ---------- recovery key ---------- */
const RK_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeRecoveryKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => RK_ALPHA[b % 32]).join('').match(/.{4}/g).join('-');

function RecoveryModal({ keyStr, saved, onConfirm, onClose }) {
  const [ack, setAck] = useState(saved);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const [dl, setDl] = useState(null);
  useEffect(() => { let alive = true; setDl(browserDownloads); return () => { alive = false; }; }, []);
  const groups = keyStr.split('-');
  const copy = async () => { try { await navigator.clipboard.writeText(keyStr); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setNote('Copy was blocked here. Select the key and copy it by hand.'); } };
  const saveTxt = async () => {
    if (!dl) { setNote('Saving files is not available in this view. Copy it or write it down instead.'); return; }
    const body = `Ashdrop recovery key\n\n${keyStr}\n\nAccount: demo@ashdrop.cc\nCreated: ${new Date().toDateString()}\n\nKeep this somewhere safe and offline. Anyone with this key and your email can open your vault.\nDo not store it inside your Ashdrop vault.\n`;
    try { await dl.save({ filename: 'ashdrop-recovery-key.txt', data: body }); setNote('Saved. Move it somewhere safe, like a password manager or a printed copy.'); }
    catch (e) { if (e?.code !== 'declined') setNote('Saving is not available in this view.'); }
  };
  return (
    <Modal onClose={onClose} labelledBy="rk-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="rk-title" className="font-display text-2xl font-bold mt-1">Your only way back in</h2>
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      <p className="text-[13px] text-mute mt-2">Ashdrop never sees your password, so we cannot reset it. If you forget it, this key unlocks your vault.</p>
      <div className="mt-4 rounded-2xl bg-well border border-line p-4 grid grid-cols-2 sm:grid-cols-4 gap-2 select-all" aria-label="Recovery key">
        {groups.map((g, i) => (
          <span key={i} className="stagger-cell font-mono text-[16px] font-semibold tracking-[0.12em] text-center rounded-lg bg-panel border border-line py-2" style={{ animation: `stagger-in calc(.4s * var(--spd)) var(--ease-out) both`, animationDelay: `calc(${i * 50}ms * var(--spd))` }}>{g}</span>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={copy} className={`press rounded-lg py-2.5 text-[13px] font-semibold border transition-colors ${copied ? 'border-ok text-ok' : 'border-line hover:border-mute'}`}>{copied ? 'Copied' : 'Copy key'}</button>
        <button onClick={saveTxt} className="press rounded-lg py-2.5 text-[13px] font-semibold border border-line hover:border-mute transition-colors">Save as .txt</button>
      </div>
      {note && <div className="mt-2 text-[12px] text-mute">{note}</div>}
      <ul className="mt-4 text-[12.5px] text-mute flex flex-col gap-1 list-disc pl-4">
        <li>Store it outside Ashdrop: a password manager, or printed and put away.</li>
        <li>Anyone with this key and your email can open your vault.</li>
        <li>Making a new key in Settings cancels this one.</li>
      </ul>
      <label htmlFor="rk-ack" className="mt-4 flex items-center gap-3 rounded-xl border border-line px-3 py-3 cursor-pointer hover:border-mute transition-colors">
        <input id="rk-ack" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="w-4 h-4 accent-[var(--ember)]" />
        <span className="text-[13px]">I have stored my recovery key somewhere safe</span>
      </label>
      <button id="rk-done" disabled={!ack} onClick={() => { onConfirm(); }} className="press mt-3 w-full rounded-xl py-3 font-semibold bg-ember text-ink hover:brightness-110 transition disabled:opacity-40 disabled:hover:brightness-100">Done</button>
    </Modal>
  );
}

/* ---------- how it works ---------- */
function HowNode({ icon, title, caption, extra, dashed }) {
  return (
    <div className={`sm:w-[27%] shrink-0 rounded-2xl bg-well border ${dashed ? 'border-dashed border-mute/50' : 'border-line'} p-4 text-center flex flex-col items-center gap-2`}>
      <span className="w-11 h-11 rounded-xl grid place-items-center bg-panel border border-line" aria-hidden="true">{icon}</span>
      <div className="font-semibold text-[14px]">{title}</div>
      <div className="text-[12px] text-mute">{caption}</div>
      {extra}
    </div>
  );
}
function Wire() {
  return (
    <div className="wire self-center w-0.5 h-12 my-2 sm:my-0 sm:h-0.5 sm:w-auto sm:flex-1 sm:mx-3" aria-hidden="true">
      <span className="hidden sm:block absolute -top-6 left-1/2 -translate-x-1/2 font-mono text-[10px] text-mute whitespace-nowrap">ciphertext</span>
      <span className="pk" /><span className="pk late" />
    </div>
  );
}
function HowContent({ onShare, onVault }) {
  const scrambled = useMemo(() => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join(' '), []);
  const faq = [
    ['What if I forget a link password?', 'Then that link cannot be opened. We never see the password, so we cannot reset it. Ask the sender for a new link.'],
    ['Can Ashdrop be forced to hand over what I send?', 'We can only hand over what we have: scrambled bytes, a size and a few timestamps, with no keys. The key lives in the link itself and never reaches our servers.'],
    ['What actually happens when a link burns?', 'On the first successful open, the server deletes the encrypted data in the same step that releases it. A second visit finds nothing. Unread links are also purged when they expire.'],
    ['Why do you not scan uploads?', 'Because we cannot see inside them. Instead we keep links small and short-lived, so Ashdrop is a bad tool for spreading anything.'],
  ];
  const rows = [
    ['Burn-after-reading links', '✓', '✓'],
    ['Password + lockout', '✓', '✓'],
    ['File size per link', '25 MB', '2 GB'],
    ['Link lifetime', 'Up to 24 hours', 'Up to 30 days'],
    ['Encrypted vault', '5 GB', '10–100 GB'],
    ['Account needed', 'Only for the vault', 'Yes'],
    ['Price', 'Free', 'From $2.40/mo'],
  ];
  return (
    <div className="stagger max-w-4xl mx-auto flex flex-col gap-14">
      <section style={{ '--i': 0 }} className="text-center flex flex-col items-center gap-4 pt-2">
        <h1 className="font-display text-[34px] sm:text-[54px] font-bold leading-[1.04] max-w-2xl">We can't read what you send. <GradText>Here's why.</GradText></h1>
        <p className="text-mute text-[15px] max-w-xl">Everything is locked in your browser before it leaves your device. The key to unlock it rides inside the link, in a part browsers never send to any server.</p>
      </section>

      <section style={{ '--i': 1 }} className="rounded-3xl border border-line bg-panel p-5 sm:p-8">
        <div className="label mb-4">Anatomy of a link</div>
        <div className="font-mono text-[15px] sm:text-[22px] break-all leading-relaxed">
          <span className="text-mute">https://</span><span className="border-b-2 border-fg/40">ashdrop.cc/p/x7k2m9</span><span className="text-cyan border-b-2 border-cyan">#<Scramble text="Qm9yZWQtYnV0LXNhZmU" ms={1400} /></span>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-6">
          <div className="rounded-2xl bg-well border border-line p-4">
            <div className="flex items-center gap-2 font-semibold text-[14px]"><span className="w-2.5 h-2.5 rounded-full bg-fg" aria-hidden="true" />Before the #</div>
            <div className="text-[13px] text-mute mt-1">Sent to our server. It only says which locked box to fetch.</div>
          </div>
          <div className="rounded-2xl bg-well border border-cyan/40 p-4">
            <div className="flex items-center gap-2 font-semibold text-[14px] text-cyan"><span className="w-2.5 h-2.5 rounded-full bg-cyan" aria-hidden="true" />After the #</div>
            <div className="text-[13px] text-mute mt-1">Never sent anywhere. Browsers keep this part on the device. It is the key.</div>
          </div>
        </div>
      </section>

      <section style={{ '--i': 2 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">Where your data goes</h2>
        <p className="text-mute text-[14px] mt-1">The server only ever handles locked bytes. The key takes a different road.</p>
        <div className="mt-6 rounded-3xl border border-line bg-panel p-5 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center">
            <HowNode title="Your browser" caption="Encrypts with AES-256-GCM and makes the key"
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ember)" strokeWidth="2"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>} />
            <Wire />
            <HowNode dashed title="Ashdrop server" caption="Stores scrambled bytes. Has no key."
              extra={<span className="font-mono text-[11px] text-mute bg-panel border border-line rounded-sm px-2 py-0.5">{scrambled} …</span>}
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--mute)" strokeWidth="2"><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/></svg>} />
            <Wire />
            <HowNode title="Their browser" caption="Fetches the bytes, unlocks them with the key from the link"
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>} />
          </div>
          <div className="keytrack relative mt-8 h-12 rounded-full border-2 border-dashed border-cyan/40" aria-hidden="true">
            <span className="pk inline-flex items-center gap-1.5 rounded-full bg-well border border-cyan/60 px-2.5 h-7 text-[12px] text-cyan font-mono whitespace-nowrap">#key</span>
          </div>
          <p className="text-[12.5px] text-mute text-center mt-3">The key travels inside the link you send them, by chat, email or QR code. It never touches our servers.</p>
        </div>
      </section>

      <section style={{ '--i': 3 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">Three steps</h2>
        <ol className="mt-5 grid sm:grid-cols-3 gap-3">
          {[['Paste or drop it', 'Paste text, or drop files anywhere on the page. Nothing has left your device yet.'],
            ['Create the link', 'Your browser encrypts it, uploads the locked bytes and copies a link with the key on the end.'],
            ['They open it, it burns', 'Their browser unlocks it. Burn links are deleted from the server the moment they are opened.']].map(([t, d], i) => (
            <li key={t} className="lift rounded-2xl border p-5" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
              <span className="w-8 h-8 rounded-full grid place-items-center text-[13px] font-semibold border border-line text-fg">{i + 1}</span>
              <div className="font-semibold text-[15px] mt-3">{t}</div>
              <div className="text-[13px] text-mute mt-1">{d}</div>
            </li>
          ))}
        </ol>
      </section>

      {FEATURES.pro && <section style={{ '--i': 4 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">Free and Pro</h2>
        <div className="mt-5 rounded-2xl border border-line overflow-x-auto">
          <table className="w-full text-[13.5px] min-w-[420px]">
            <thead><tr className="bg-panel">
              <th className="text-left font-semibold px-4 py-3 border-b border-line"> </th>
              <th className="text-left font-semibold px-4 py-3 border-b border-line">Free</th>
              <th className="text-left font-bold px-4 py-3 border-b border-line text-ink" style={{ background: 'var(--ember)' }}>Pro</th>
            </tr></thead>
            <tbody>
              {rows.map(([k, f, p]) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 text-mute">{k}</td>
                  <td className={`px-4 py-3 tabular ${f === '✓' ? 'text-ok' : ''}`}>{f}</td>
                  <td className={`px-4 py-3 tabular ${p === '✓' ? 'text-ok' : ''}`}>{p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>}

      <section style={{ '--i': 5 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">Questions</h2>
        <div className="mt-5 flex flex-col gap-2">
          {faq.map(([qq, a]) => (
            <details key={qq} className="group rounded-2xl border border-line bg-panel px-5 py-4">
              <summary className="cursor-pointer flex items-center justify-between gap-4 font-semibold text-[14.5px]">
                {qq}<span className="chev text-mute transition-transform duration-300" aria-hidden="true">›</span>
              </summary>
              <p className="text-[13.5px] text-mute mt-2 max-w-[65ch]">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-line p-8 text-center flex flex-col items-center gap-4"
        style={{ '--i': 6, background: 'var(--panel)' }}>
        <h2 className="font-display text-[26px] sm:text-[34px] font-bold">Try it with something real</h2>
        <p className="text-mute text-[14px] max-w-md">No account needed. Send your first burn link in about ten seconds.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <button onClick={onShare} className="press rounded-xl px-6 py-3 btn-primary font-display text-[16px]">Share something</button>
          {FEATURES.vaultFiles && <button onClick={onVault} className="press rounded-xl px-6 py-3 font-semibold border border-line bg-panel hover:border-mute transition-colors">Open your vault</button>}
        </div>
      </section>
    </div>
  );
}

/* ---------- why ashdrop ---------- */
// One quiet tone for the explainer pages; ember stays reserved for burning and sealing.
const POP = { ember: 'var(--mute)', gold: 'var(--mute)', cyan: 'var(--mute)', violet: 'var(--mute)', green: 'var(--mute)', pink: 'var(--mute)' };
const mix = (c, pct, base = 'var(--panel)') => `color-mix(in srgb, ${c} ${pct}%, ${base})`;
const GradText = ({ children }) => <>{children}</>;
function WhyIcon({ kind, c }) {
  const common = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, stroke: c };
  if (kind === 'lock') return (
    <svg {...common}><g className="why-shackle"><path d="M8 11V8a4 4 0 0 1 8 0v3" /></g><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M12 15v2" /></svg>);
  if (kind === 'flame') return (
    <svg {...common}><path className="why-flame" d="M12 3c2.5 3 5 5.2 5 9.2A5 5 0 0 1 7 12.2c0-1.8.8-3.2 1.9-4.4.2 1.5 1 2.4 2 2.8C10.6 8 11 5.5 12 3z" /></svg>);
  if (kind === 'shield') return (
    <svg {...common}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path className="why-check" d="M9 12l2 2 4-4" /></svg>);
  if (kind === 'user') return (
    <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5" /><path className="why-strike" d="M4 4l16 16" stroke="var(--ember)" /></svg>);
  if (kind === 'toggle') return (
    <svg {...common}><rect x="3" y="7" width="18" height="10" rx="5" /><circle className="why-knob" cx="8" cy="12" r="3" fill={c} stroke="none" /></svg>);
  return (
    <svg {...common}><path d="M4 7h16M4 12h10M4 17h6" /><circle className="why-ping" cx="18" cy="16" r="2.5" fill={c} stroke="none" /></svg>);
}

function WhyAshdrop({ onShare }) {
  const reasons = [
    ['lock', POP.ember, 'We cannot look', 'Your browser locks everything before it leaves your device, and the key never reaches us. The code is open source, so anyone can check.'],
    ['flame', POP.gold, 'Nothing lingers', 'A burn link is deleted from our servers the moment it is opened. No inbox copies, no chat history, no forgotten attachment.'],
    ['shield', POP.cyan, 'A leaked link is not enough', 'Add a password and anyone guessing gets a few tries before the link destroys itself. Even the free tier gets this.'],
    ['user', POP.violet, 'No accounts to send or open', 'Paste, lock, send. Your recipient clicks and reads. Nobody signs up for anything to share one secret.'],
    ['toggle', POP.green, 'Nothing to install', 'It runs in any modern browser, on a phone or a laptop. Your recipient does not need an app either.'],
    ['list', POP.pink, 'Limits we are upfront about', 'We keep free links small and short-lived instead of scanning your files. You always know exactly what you get.'],
  ];
  const compare = [
    ['The service can read it', ['Depends on the app', 'Usually', 'Usually', 'No']],
    ['Copies left after it is read', ['Both chat histories', 'Both inboxes', 'Until you delete it', 'None']],
    ['Expires on its own', ['Sometimes', 'No', 'If you set it', 'Always']],
    ['Locks out password guessing', ['No', 'No', 'Rarely', 'Yes']],
    ['Recipient needs an account', ['Yes', 'Yes', 'Sometimes', 'No']],
  ];
  const trail = ['Your chat history', 'Their chat history', 'Notification preview', 'Cloud backup', 'Their laptop sync', 'A screenshot'];
  return (
    <div className="stagger max-w-4xl mx-auto flex flex-col gap-14">
      <section style={{ '--i': 0 }} className="text-center flex flex-col items-center gap-4 pt-2">
        <h1 className="font-display text-[34px] sm:text-[54px] font-bold leading-[1.04] max-w-2xl">Sharing a secret should not leave a trail.</h1>
        <p className="text-mute text-[15px] max-w-xl">Most ways of sending a password or a private file make copies you never think about. Ashdrop makes exactly one, and then it is gone.</p>
      </section>

      <section style={{ '--i': 1 }} className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-3xl border border-line bg-panel p-5 sm:p-6 flex flex-col gap-4">
          <div className="label">The usual way</div>
          <div className="rounded-2xl bg-well border border-line px-4 py-3 font-mono text-[12.5px]">DB_PASSWORD=correct-horse-9</div>
          <div className="flex flex-wrap gap-2 min-h-[92px] content-start" aria-label="Copies the usual way leaves behind">
            {trail.map((t, i) => (
              <span key={t} className="trail-chip rounded-full border px-2.5 py-1 text-[12px] font-semibold"
                style={{ animationDelay: `calc(${i * 0.55}s * var(--spd))`, ...(() => { const c = [POP.gold, POP.pink, POP.violet, POP.cyan, POP.ember, POP.green][i]; return { color: tint(c), background: mix(c, 14), borderColor: mix(c, 45, 'var(--line)') }; })() }}>
                + {t}
              </span>
            ))}
          </div>
          <div className="text-[12.5px] text-mute">Six places it might still live next year.</div>
        </div>
        <div className="rounded-3xl border border-ember/40 p-5 sm:p-6 flex flex-col gap-4"
          style={{ background: 'var(--panel)' }}>
          <div className="label text-ember">With Ashdrop</div>
          <div className="relative rounded-2xl bg-well border border-line px-4 py-3 font-mono text-[12.5px] overflow-hidden">
            <span className="burn-loop inline-block">DB_PASSWORD=correct-horse-9</span>
          </div>
          <div className="flex flex-col gap-2 min-h-[92px] justify-center">
            <div className="flex items-center gap-2 text-[13px]"><span className="w-2 h-2 rounded-full bg-ok" aria-hidden="true" />Read once, in their browser</div>
            <div className="flex items-center gap-2 text-[13px]"><span className="w-2 h-2 rounded-full bg-ember flicker" aria-hidden="true" />Deleted from the server on open</div>
            <div className="flex items-center gap-2 text-[13px]"><span className="w-2 h-2 rounded-full bg-cyan" aria-hidden="true" />The link is dead afterwards</div>
          </div>
          <div className="text-[12.5px] text-mute">Zero places it lives next year.</div>
        </div>
      </section>

      <section style={{ '--i': 2 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">Six reasons people switch</h2>
        <div className="stagger mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {reasons.map(([icon, c, t, d], i) => (
            <div key={t} style={{ '--i': i, background: 'var(--panel)', borderColor: 'var(--line)' }}
              className="group lift relative overflow-hidden rounded-2xl border p-5 flex flex-col gap-3">
              <span className="absolute -right-8 -top-8 w-28 h-28 rounded-full blur-2xl opacity-40 group-hover:opacity-70 transition-opacity duration-500" style={{ background: c }} aria-hidden="true" />
              <span className="relative w-12 h-12 rounded-xl grid place-items-center border group-hover:scale-110 group-hover:-rotate-6 transition-transform duration-300"
                style={{ background: mix(c, 18, 'var(--well)'), borderColor: mix(c, 45, 'var(--line)') }}><WhyIcon kind={icon} c={c} /></span>
              <div className="relative font-semibold text-[15px]">{t}</div>
              <div className="relative text-[13px] text-mute">{d}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ '--i': 3 }}>
        <h2 className="font-display text-[26px] sm:text-[32px] font-bold">How it compares</h2>
        <p className="text-mute text-[13px] mt-1">Typical behaviour of each option. Some apps offer extra privacy settings you have to turn on yourself.</p>
        <div className="mt-5 rounded-2xl border border-line overflow-x-auto">
          <table className="w-full text-[13px] min-w-[600px]">
            <thead><tr className="bg-panel">
              <th className="text-left font-semibold px-4 py-3 border-b border-line w-[28%]"> </th>
              {['Chat apps', 'Email', 'Cloud drive link'].map(h => <th key={h} className="text-left font-semibold px-4 py-3 border-b border-line text-mute">{h}</th>)}
              <th className="text-left font-bold px-4 py-3 border-b border-ember/50 text-ink" style={{ background: 'var(--ember)' }}>Ashdrop</th>
            </tr></thead>
            <tbody className="stagger">
              {compare.map(([k, vals], i) => (
                <tr key={k} style={{ '--i': i }} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">{k}</td>
                  {vals.slice(0, 3).map((v, j) => <td key={j} className="px-4 py-3 text-mute">{v}</td>)}
                  <td className="px-4 py-3 font-semibold text-ember bg-[var(--ember-soft)]">
                    <span className="inline-flex items-center gap-1.5"><span className="check-pop inline-block" style={{ animationDelay: `calc(${300 + i * 120}ms * var(--spd))` }}>✓</span>{vals[3]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ '--i': 4, background: 'var(--panel)' }}
        className="relative overflow-hidden rounded-3xl border border-line p-8 text-center flex flex-col items-center gap-4">
        <span className="blob" style={{ background: POP.pink, left: '-40px', top: '-50px' }} aria-hidden="true" />
        <span className="blob" style={{ background: POP.cyan, right: '-40px', bottom: '-60px', animationDelay: 'calc(-4s * var(--spd))' }} aria-hidden="true" />
        <h2 className="relative font-display text-[26px] sm:text-[34px] font-bold">Send your next secret <GradText>the clean way</GradText></h2>
        <p className="relative text-mute text-[14px] max-w-md">It takes about ten seconds, and nobody needs an account.</p>
        <button onClick={onShare} className="press rounded-xl px-6 py-3 btn-primary font-display text-[16px] relative">Share something</button>
      </section>
    </div>
  );
}

function HowItWorks({ onShare, onVault }) {
  const [tab, setTab] = useState('how');
  return (
    <div className="relative flex flex-col gap-8">
      <div className="pointer-events-none absolute inset-x-0 -top-10 h-[520px] overflow-hidden -z-0" aria-hidden="true">
        <span className="blob big" style={{ background: POP.ember, left: '5%', top: '0' }} />
        <span className="blob big" style={{ background: POP.violet, left: '40%', top: '40px', animationDelay: 'calc(-6s * var(--spd))' }} />
        <span className="blob big" style={{ background: POP.cyan, right: '4%', top: '10px', animationDelay: 'calc(-3s * var(--spd))' }} />
      </div>
 <div className="relative w-full max-w-xs mx-auto">
        <Seg id="how-tab" label="About Ashdrop" value={tab} onChange={setTab}
          options={[{ v: 'how', label: 'How it works' }, { v: 'why', label: 'Why Ashdrop' }]} />
      </div>
      <div key={tab} className={`relative ${tab === 'why' ? 'step-fwd' : 'step-back'}`}>
        {tab === 'why' ? <WhyAshdrop onShare={onShare} /> : <HowContent onShare={onShare} onVault={onVault} />}
      </div>
    </div>
  );
}

/* ---------- settings ---------- */
const DEFAULT_SETTINGS = { theme: 'dark', speed: 1, perf: false, defaultExpiry: 'burn', defaultPw: false, defaultAttempts: 3, linksLock: true };
const SPEEDS = [{ v: 0, label: 'Off' }, { v: 1.6, label: 'Relaxed' }, { v: 1, label: 'Normal' }, { v: 0.6, label: 'Snappy' }];
const loadSettings = () => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('ashdrop.settings') || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; } };
const saveSettings = (v) => { try { localStorage.setItem('ashdrop.settings', JSON.stringify(v)); } catch {} };

/* Segmented control with a sliding highlight. Equal-width columns keep the pill math simple. */
function Seg({ options, value, onChange, label, id, small }) {
  const i = Math.max(0, options.findIndex(o => o.v === value)), n = options.length;
  return (
    <div className="relative grid gap-1 p-1 rounded-xl bg-well border border-line" role="radiogroup" aria-label={label}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      <span className="absolute top-1 bottom-1 left-1 rounded-lg fill-on shadow-xs transition-transform duration-500" aria-hidden="true"
        style={{ width: `calc((100% - 8px - ${(n - 1) * 4}px) / ${n})`, transform: `translateX(calc(${i} * (100% + 4px)))`, transitionTimingFunction: 'var(--ease-out)' }} />
      {options.map(o => (
        <button key={String(o.v)} id={`${id}-${o.v}`} role="radio" aria-checked={o.v === value} onClick={() => onChange(o.v)}
          className={`relative z-10 rounded-lg ${small ? 'py-1.5 text-[12px]' : 'py-2 text-[13px]'} font-medium transition-colors duration-300 truncate px-1 ${o.v === value ? 'on-fill font-semibold' : 'text-mute hover:text-fg'}`}>
          {o.icon && <span className="mr-1.5" aria-hidden="true">{o.icon}</span>}{o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ title, sub, children, stack }) {
  return (
    <div className={`flex ${stack ? 'flex-col items-stretch' : 'flex-col sm:flex-row sm:items-center'} gap-3 justify-between py-4 border-b border-line last:border-0`}>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold">{title}</div>
        {sub && <div className="text-[12.5px] text-mute mt-0.5">{sub}</div>}
      </div>
      <div className={stack ? '' : 'sm:w-[300px] shrink-0'}>{children}</div>
    </div>
  );
}

const SECTION_TONES = [['var(--violet)', 'var(--pink)'], ['var(--ember)', 'var(--gold)'], ['var(--gold)', 'var(--ember)'], ['var(--cyan)', 'var(--ok)'], ['var(--pink)', 'var(--violet)']];
function Section({ title, children, i, tone }) {
  const [t1, t2] = tone === 'danger' ? ['var(--ember)', 'var(--ember)'] : SECTION_TONES[i % SECTION_TONES.length];
  return (
    <section style={{ '--i': i, '--t1': t1, '--t2': t2 }} className={`tone-top rounded-2xl border bg-panel px-5 sm:px-6 py-2 ${tone === 'danger' ? 'border-ember/40' : 'border-line'}`}>
      <h2 className="font-display text-[15px] pt-5 pb-1">{title}</h2>
      {children}
    </section>
  );
}

/* ---------- My links ---------- */
const LINK_STATE = {
  waiting: { label: 'Waiting', cls: 'text-cyan border-cyan/40', dot: 'bg-cyan pulse-dot' },
  opened: { label: 'Opened', cls: 'text-ok border-ok/40', dot: 'bg-ok' },
  burned: { label: 'Burned', cls: 'text-ember border-ember/40', dot: 'bg-ember' },
  locked: { label: 'Locked out', cls: 'text-warn border-warn/40', dot: 'bg-warn' },
  revoked: { label: 'Revoked', cls: 'text-mute border-line', dot: 'bg-mute' },
  expired: { label: 'Expired', cls: 'text-mute border-line', dot: 'bg-mute' },
  removed: { label: 'Removed', cls: 'text-warn border-warn/40', dot: 'bg-warn' },
};
/* Passcode entry used by the My links lock. mode: 'set' | 'enter' | 'change'. */
function PasscodeForm({ mode, needCurrent, onSubmit, submitLabel, idPrefix = 'pc' }) {
  const [cur, setCur] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const asksNew = mode === 'set' || mode === 'change';
  const asksCurrent = mode === 'enter' || (mode === 'change' && needCurrent);
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (asksCurrent && !cur) return setErr('Enter your passcode.');
    if (asksNew && a.length < 4) return setErr('Use at least 4 characters.');
    if (asksNew && a !== b) return setErr('The two passcodes do not match.');
    setBusy(true);
    try { await onSubmit({ current: cur, next: a }); }
    catch (x) {
      if (x?.message === 'wrong_passcode') { setErr('That passcode is not right.'); setCur(''); setShake(n => n + 1); }
      else setErr('Something went wrong: ' + (x?.message || x));
    } finally { setBusy(false); }
  };
  const field = 'w-full bg-well border border-line rounded-xl px-4 py-3 font-mono text-[14px] outline-hidden focus:border-cyan transition-colors';
  return (
    <form key={shake} onSubmit={submit} className={`flex flex-col gap-2.5 ${shake ? 'shake' : ''}`}>
      {asksCurrent && <>
        <label htmlFor={`${idPrefix}-current`} className="sr-only">{mode === 'change' ? 'Current passcode' : 'Passcode'}</label>
        <input id={`${idPrefix}-current`} type="password" autoFocus={FINE_POINTER} inputMode="text" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)}
          placeholder={mode === 'change' ? 'Current passcode' : 'Passcode'} className={field} />
      </>}
      {asksNew && <>
        <label htmlFor={`${idPrefix}-new`} className="sr-only">New passcode</label>
        <input id={`${idPrefix}-new`} type="password" autoFocus={!asksCurrent && FINE_POINTER} autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)}
          placeholder={mode === 'change' ? 'New passcode' : 'Choose a passcode'} className={field} />
        <label htmlFor={`${idPrefix}-confirm`} className="sr-only">Repeat passcode</label>
        <input id={`${idPrefix}-confirm`} type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} placeholder="Repeat it" className={field} />
      </>}
      {err && <div role="alert" className="text-[12.5px] text-warn">{err}</div>}
      <button id={`${idPrefix}-submit`} disabled={busy} className="press rounded-xl py-3 font-semibold btn-primary transition disabled:opacity-60 flex items-center justify-center gap-2">
        {busy && <span className="w-4 h-4 rounded-full border-2 border-[#111317] border-t-transparent animate-spin" />}{busy ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}

function LockIcon({ open }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" /><path d={open ? 'M8 11V8a4 4 0 0 1 7.5-2' : 'M8 11V8a4 4 0 0 1 8 0v3'} /><path d="M12 15v2" />
    </svg>
  );
}

/* Below the composer on the home page: what Ashdrop is, for people and for search engines.
   Keep in step with the static copy inside #root in index.html. */
function HomeInfo({ onHow }) {
  const features = [
    ['Burn after reading', 'Links can burn after one view, expire after an hour or a day, or need a password with a limited number of tries.'],
    ['Encrypted in your browser', 'The server only stores encrypted bytes. It never sees the key, the text or the file names.'],
    ['Phone to computer in two taps', 'Pair your devices once, then send to one or several of them at a time. On the same Wi-Fi, Nearby sends files directly with no size limit.'],
    ['Free and open source', 'No account is needed to share. The code is public under the MIT license, and anyone can check that the live site runs it.'],
  ];
  const faq = [
    ['Can Ashdrop read what I send?', 'No. Your text and files are encrypted on your device before upload, and the key never reaches our servers.'],
    ['What happens after a link is opened?', 'A burn-after-reading link is deleted from the server the moment it is opened. Anyone who opens it afterwards sees that it is gone.'],
    ['Do I need an account or an app?', 'No. Ashdrop works in any modern browser on phones and computers. An account is only for the optional encrypted vault.'],
    ['How big can files be?', 'Up to 25 MB per link. Nearby, for devices on the same Wi-Fi, has no size limit.'],
  ];
  return (
    <section id="about" aria-labelledby="about-title" className="mt-14 border-t border-line pt-10 flex flex-col gap-8">
      <div>
        <h2 id="about-title" className="font-display text-[22px] sm:text-[26px] font-bold leading-tight">Share passwords, notes and files without leaving a copy</h2>
        <p className="text-mute text-[14px] mt-2 leading-relaxed">Ashdrop turns text or files into a one-time link. Everything is encrypted in your browser with AES-256-GCM before it is uploaded, and the key stays in the part of the link after the #, which browsers never send to a server. When the link is opened, the encrypted data is deleted.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {features.map(([t, d]) => (
          <div key={t} className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="font-semibold text-[15px]">{t}</h3>
            <p className="text-mute text-[13.5px] mt-1 leading-relaxed">{d}</p>
          </div>
        ))}
      </div>
      <div>
        <h2 className="font-display text-[20px] font-bold">Questions</h2>
        <div className="mt-3 flex flex-col divide-y divide-line border-y border-line">
          {faq.map(([q, a]) => (
            <details key={q} className="group py-3">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3"><h3 className="font-semibold text-[14.5px]">{q}</h3><span aria-hidden="true" className="text-mute group-open:rotate-45 transition-transform text-[18px] leading-none">+</span></summary>
              <p className="text-mute text-[13.5px] mt-2 leading-relaxed">{a}</p>
            </details>
          ))}
        </div>
        <p className="text-[12.5px] text-mute mt-4"><button onClick={onHow} className="text-fg underline underline-offset-2 hover:text-ember">How Ashdrop works, step by step</button> · <a href="/security" className="text-fg underline underline-offset-2 hover:text-ember">Security</a></p>
      </div>
    </section>
  );
}

/* My links when signed in: kept in the vault, opened with it. */
function AccountLinks({ toast, onOpen, onNew, refresh }) {
  const [, rerender] = useState(0);
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [oldLock, setOldLock] = useState(linkStore.hasLock);
  const s = account.session();
  const unlocked = !!account.vaultKeyRaw();
  useEffect(() => {
    if (!unlocked) return;
    let alive = true;
    myLinks.list().then((l) => alive && (setLinks(l), setErr(''))).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [unlocked, refresh]);
  if (!unlocked) return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-mute text-[13.5px]">Your links are kept in your vault. Unlock it to see them.</p>
      <UnlockGate email={s.email} onReady={() => rerender(n => n + 1)} onSignOut={async () => { await account.signOut(); rerender(n => n + 1); }} />
    </div>
  );
  const moveOld = async (pass) => {
    const r = await linkStore.unlock(pass);
    await myLinks.importRecords(r.records);
    linkStore.forgetAll(); setOldLock(false);
    setLinks(await myLinks.list());
    toast(`${r.records.length} link${r.records.length === 1 ? '' : 's'} moved into your vault. You won't need that passcode again.`);
  };
  return (
    <div className="flex flex-col gap-4">
      {oldLock && linkStore.sealedCount() > 0 && <OldLinksMove count={linkStore.sealedCount()} onMove={moveOld} onForget={() => { linkStore.forgetAll(); setOldLock(false); }} />}
      {err ? <div className="rounded-2xl border border-warn/40 text-warn text-[13.5px] p-4">{err} <button onClick={() => { setErr(''); setLinks(null); rerender(n => n + 1); myLinks.list().then(setLinks).catch(e => setErr(e.message)); }} className="underline ml-1">Try again</button></div>
        : !links ? <div className="text-center text-mute text-[13px] py-12">Opening your links…</div>
        : <LinksPanel inVault links={links} refreshKey={refreshKey} onOpen={onOpen} onNew={onNew}
            onRevoke={async (id) => { const l = links.find(x => x.id === id); try { await revokeLink(id, l.ownerToken); setRefreshKey(n => n + 1); toast('Link revoked. The encrypted data is deleted.'); } catch { toast('Could not revoke that link. Try again.'); } }} />}
    </div>
  );
}

/* Links saved on this device under the old My links passcode: move them into the vault once. */
function OldLinksMove({ count, onMove, onForget }) {
  const [open, setOpen] = useState(false);
  if (!open) return (
    <div className="rounded-2xl border border-line bg-panel p-4 flex flex-wrap items-center gap-3 justify-between">
      <span className="text-[13.5px]"><span className="font-semibold">{count} older link{count === 1 ? '' : 's'} on this device</span> <span className="text-mute">still use your old My links passcode. Enter it once to move them into your vault.</span></span>
      <span className="flex gap-2"><button id="old-links-move" onClick={() => setOpen(true)} className="press rounded-lg px-3 py-2 text-[13px] font-semibold btn-primary">Move them</button>
        <button onClick={onForget} className="press rounded-lg px-3 py-2 text-[13px] font-semibold border border-line hover:border-mute">Forget them</button></span>
    </div>
  );
  return (
    <div className="rounded-2xl border border-line bg-panel p-5 max-w-md mx-auto w-full flex flex-col gap-3">
      <div className="font-semibold">Enter your old My links passcode</div>
      <PasscodeForm mode="enter" idPrefix="old-links" submitLabel="Move into vault" onSubmit={({ current }) => onMove(current)} />
      <button onClick={() => setOpen(false)} className="text-[12.5px] text-mute hover:text-fg">Not now</button>
    </div>
  );
}

/* What My links shows before it can show the links. */
function LinksGate({ stage, count, onSet, onUnlock, onSkip, onForgot }) {
  const [forgot, setForgot] = useState(false);
  return (
    <div className="pop max-w-md mx-auto rounded-3xl border border-line bg-panel p-6 sm:p-8 flex flex-col gap-4">
      <span className="w-14 h-14 rounded-2xl grid place-items-center mx-auto" style={{ background: 'var(--ember)' }}><LockIcon /></span>
      <div className="text-center">
        <h2 className="font-display text-[24px] font-bold">{stage === 'set' ? 'Lock your sent links' : 'My links is locked'}</h2>
        <p className="text-mute text-[13px] mt-1">
          {stage === 'set'
            ? 'Every saved link holds its key, so anyone using this browser could open it. Choose a passcode and they are encrypted on this device.'
            : `${count} saved link${count === 1 ? '' : 's'}, encrypted on this device. Enter your passcode to see them.`}
        </p>
      </div>
      {stage === 'set'
        ? <PasscodeForm mode="set" idPrefix="lock-set" submitLabel="Lock My links" onSubmit={({ next }) => onSet(next)} />
        : <PasscodeForm mode="enter" idPrefix="lock-open" submitLabel="Unlock" onSubmit={({ current }) => onUnlock(current)} />}
      {stage === 'set' ? (
        <button id="lock-skip" onClick={onSkip} className="text-[12.5px] text-mute hover:text-fg">Show them without a passcode</button>
      ) : forgot ? (
        <div className="pop rounded-xl border border-ember/40 bg-[var(--ember-soft)] p-3 text-[12.5px] flex flex-col gap-2">
          <div><span className="font-semibold">There is no way to recover the passcode.</span> <span className="text-mute">You can clear the saved list and start fresh. The links you sent keep working for the people you sent them to, but you lose the ability to track or revoke them here.</span></div>
          <div className="flex gap-2">
            <button id="lock-forget" onClick={() => { onForgot(); setForgot(false); }} className="press rounded-lg px-3 py-1.5 font-semibold bg-ember text-ink">Clear saved links</button>
            <button onClick={() => setForgot(false)} className="rounded-lg px-3 py-1.5 text-mute hover:text-fg">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setForgot(true)} className="text-[12.5px] text-mute hover:text-fg">Forgot your passcode?</button>
      )}
      <p className="text-[11.5px] text-mute text-center">The passcode never leaves this device. Ashdrop cannot reset it.</p>
    </div>
  );
}

function PasscodeModal({ mode, needCurrent, onSubmit, onClose }) {
  const titles = { set: 'Choose a passcode', enter: 'Enter your passcode', change: 'Change passcode', off: 'Turn off the lock' };
  const subs = {
    set: 'Your sent links will be encrypted on this device. You will need this passcode to see them.',
    enter: 'Needed to open your saved links.',
    change: 'Your links stay encrypted. Only the passcode that opens them changes.',
    off: 'Enter your passcode. Your saved links will then be stored readable on this device.',
  };
  return (
    <Modal onClose={onClose} labelledBy="pc-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="pc-title" className="font-display text-2xl font-bold mt-1">{titles[mode]}</h2>
        </div>
        <CloseBtn className="text-mute hover:text-fg p-1 -m-1" />
      </div>
      <p className="text-[13px] text-mute mt-2 mb-4">{subs[mode]}</p>
      <PasscodeForm idPrefix="pc-modal" mode={mode === 'off' ? 'enter' : mode} needCurrent={needCurrent}
        submitLabel={mode === 'off' ? 'Turn off' : mode === 'change' ? 'Change passcode' : mode === 'set' ? 'Turn on' : 'Unlock'} onSubmit={onSubmit} />
    </Modal>
  );
}

function LinksPanel({ links, onRevoke, onOpen, onNew, refreshKey, onLock, inVault }) {
  const [qrFor, setQrFor] = useState(null);
  const [, setTick] = useState(0);
  const [statuses, setStatuses] = useState({});
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const pairs = await Promise.all(links.map(async l => [l.id, await linkStatus(l.id, l.ownerToken).catch(() => ({ state: 'unknown' }))]));
      if (alive) setStatuses(Object.fromEntries(pairs));
    };
    poll();
    const t = setInterval(poll, PERF ? 20000 : 5000);
    return () => { alive = false; clearInterval(t); };
  }, [links, refreshKey]);
  const [confirmId, setConfirmId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [filter, setFilter] = useState('all');
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), PERF ? 30000 : 1000); return () => clearInterval(t); }, []);
  const fallback = (l) => ({ state: Date.now() > l.expiresAt ? 'expired' : 'waiting', expiresAt: l.expiresAt, maxAttempts: l.maxAttempts, attemptsLeft: l.maxAttempts });
  const rows = links.map(l => { const st = statuses[l.id]; return { ...l, st: st && LINK_STATE[st.state] ? st : fallback(l) }; });
  const active = rows.filter(r => r.st.state === 'waiting' || r.st.state === 'opened');
  const shown = filter === 'active' ? active : filter === 'done' ? rows.filter(r => !active.includes(r)) : rows;
  const copy = async (l) => {
    try { await navigator.clipboard.writeText(`${location.origin}/p/${l.id}#${l.keyStr}`); setCopiedId(l.id); setTimeout(() => setCopiedId(null), 1600); } catch { setCopiedId('fail:' + l.id); }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        {[['Active', active.length, 'text-cyan'], ['Opened', rows.filter(r => r.st.state === 'opened' || r.st.state === 'burned').length, 'text-ok'], ['Locked out', rows.filter(r => r.st.state === 'locked').length, 'text-warn']].map(([k, v, c]) => (
          <div key={k} className="rounded-2xl border border-line bg-panel px-4 py-3">
            <div className="label">{k}</div>
            <div className={`font-display text-[28px] font-bold tabular leading-tight ${c}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-panel border-b border-line rounded-t-2xl">
          <div className="flex gap-1.5">
            {[['all', 'All'], ['active', 'Active'], ['done', 'Finished']].map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)} className={`press rounded-full px-3 py-1 text-[12.5px] font-medium border transition-colors duration-300 ${filter === id ? 'bg-fg text-ink border-fg' : 'border-line text-mute hover:text-fg'}`}>{label}</button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11.5px] text-mute hidden sm:inline">{inVault ? 'Encrypted in your vault. The server sees ids, not content.' : 'Labels are kept only on this device. The server sees ids, not content.'}</span>
            {onLock && <button id="lock-now" onClick={onLock} className="press shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-semibold border border-line hover:border-cyan hover:text-cyan transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Lock
            </button>}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center flex flex-col items-center gap-3">
            <div className="text-mute text-[13px] max-w-sm">Links you create show up here, so you can see when they are opened and kill them early if you sent one to the wrong person.</div>
            <button onClick={onNew} className="press rounded-lg px-4 py-2 text-[13px] font-semibold bg-ember text-ink hover:brightness-110 transition">Create a link</button>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-10 text-center text-mute text-[13px]">Nothing in this view.</div>
        ) : (
          <ul className="stagger" key={filter}>
            {shown.map((l, i) => {
              const st = LINK_STATE[l.st.state], live = l.st.state === 'waiting' || l.st.state === 'opened';
              const wrong = l.st.maxAttempts && live ? l.st.maxAttempts - l.st.attemptsLeft : 0;
              return (
                <li key={l.id} style={{ '--i': Math.min(i, 8) }} className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-4 py-3.5 border-b border-line last:border-0">
                  <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0 border border-line bg-well" aria-hidden="true">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: l.kind === 'paste' ? colorOf(l.lang) : 'var(--cyan)' }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{l.label}</div>
                    <div className="text-[11.5px] text-mute flex flex-wrap items-center gap-x-2">
                      <span className="font-mono">/p/{l.id}</span><span aria-hidden="true">·</span><span>sent {ago(l.createdAt)}</span>
                      {live && <><span aria-hidden="true">·</span><span className="tabular">{l.expiry === 'burn' ? 'burns on open, ' : ''}{timeLeft(l.st.expiresAt - Date.now())} left</span></>}
                      {l.password && <><span aria-hidden="true">·</span><span>password{wrong ? `, ${wrong} wrong ${wrong === 1 ? 'try' : 'tries'}` : ''}</span></>}
                    </div>
                    {l.code && live && <div className="mt-1.5 flex"><CodeWords code={l.code} size="sm" /></div>}
                  </div>
                  <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold ${st.cls}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} aria-hidden="true" />{st.label}{l.st.state === 'opened' && l.st.opens > 1 ? ` ×${l.st.opens}` : ''}
                  </span>
                  <div className="flex items-center gap-1 shrink-0 ml-auto sm:ml-0">
                    {confirmId === l.id ? (
                      <>
                        <button id={`revoke-confirm-${l.id}`} onClick={() => { onRevoke(l.id); setConfirmId(null); }} className="rounded-md px-2.5 py-1 text-[12px] font-semibold bg-ember text-ink">Revoke</button>
                        <button onClick={() => setConfirmId(null)} className="rounded-md px-2 py-1 text-[12px] text-mute hover:text-fg">Keep</button>
                      </>
                    ) : (
                      <>
                        {!l.qrOnly && <button onClick={() => copy(l)} disabled={!live} className="rounded-md px-2.5 py-1 text-[12px] font-medium border border-line hover:border-cyan hover:text-cyan transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg">{copiedId === l.id ? 'Copied' : 'Copy'}</button>}
                        <button id={`link-qr-${l.id}`} onClick={() => setQrFor(l)} disabled={!live} aria-label={`Show QR code for ${l.label}`} title={l.qrOnly ? 'QR only: show the code' : 'Show QR code'}
                          className="rounded-md px-1.5 py-1 border border-line hover:border-cyan hover:text-cyan transition-colors disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg [&_svg]:w-4 [&_svg]:h-4">{QR_ICON}</button>
                        <button onClick={() => onOpen(l)} className="rounded-md px-2.5 py-1 text-[12px] font-medium border border-line hover:border-mute transition-colors" title="See what the recipient sees">View</button>
                        {live && <button onClick={() => setConfirmId(l.id)} className="rounded-md px-2 py-1 text-[12px] text-mute hover:text-ember">Revoke</button>}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[12px] text-mute text-center">Revoking deletes the encrypted data on the server right away. Anyone who opens the link afterwards sees that it is gone.</p>
      {qrFor && <QRFullscreen link={`${location.origin}/p/${qrFor.id}#${qrFor.keyStr}`} burn={qrFor.expiry === 'burn'} onClose={() => setQrFor(null)} />}
    </div>
  );
}

/* Speed dial: one knob, presets as detents. t is the dial position 0..1; speed is the
   duration multiplier the CSS and JS read (0 = motion off, bigger = slower). */
const DIAL_PRESETS = [
  { t: 0, speed: 0, label: 'Off' },
  { t: 1 / 3, speed: 1.6, label: 'Relaxed' },
  { t: 2 / 3, speed: 1, label: 'Normal' },
  { t: 1, speed: 0.6, label: 'Snappy' },
];
const OFF_ZONE = 0.07;
const tToSpeed = (t) => {
  if (t < OFF_ZONE) return 0;
  if (t <= 1 / 3) return +(2.2 - (t - OFF_ZONE) / (1 / 3 - OFF_ZONE) * 0.6).toFixed(2);       // 2.2 → 1.6
  if (t <= 2 / 3) return +(1.6 - (t - 1 / 3) * 3 * 0.6).toFixed(2);                          // 1.6 → 1.0
  return +(1 - (t - 2 / 3) * 3 * 0.4).toFixed(2);                                            // 1.0 → 0.6
};
const speedToT = (sp) => {
  if (!sp) return 0;
  if (sp >= 1.6) return OFF_ZONE + (2.2 - Math.min(sp, 2.2)) / 0.6 * (1 / 3 - OFF_ZONE);
  if (sp >= 1) return 1 / 3 + (1.6 - sp) / 0.6 / 3;
  return 2 / 3 + (1 - Math.max(sp, 0.6)) / 0.4 / 3;
};
const ARC = 270, A0 = -135;
const polar = (cx, cy, r, deg) => { const a = (deg * Math.PI) / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
const arcPath = (cx, cy, r, d0, d1) => {
  const [x0, y0] = polar(cx, cy, r, d0), [x1, y1] = polar(cx, cy, r, d1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

function SpeedDial({ value, onChange }) {
  const svgRef = useRef(null);
  const [t, setT] = useState(() => speedToT(value));
  const [dragging, setDragging] = useState(false);
  useEffect(() => { if (!dragging) setT(speedToT(value)); }, [value]);

  const commit = (nt, snap) => {
    let x = Math.min(1, Math.max(0, nt));
    if (snap) { const near = DIAL_PRESETS.find(p => Math.abs(p.t - x) < 0.06); if (near) x = near.t; }
    setT(x); onChange(tToSpeed(x));
  };
  const fromPointer = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;        // 0 at 12 o'clock, clockwise
    if (deg > 135 || deg < -135) deg = deg > 0 ? (deg < 157.5 ? 135 : -135) : (deg > -157.5 ? -135 : 135);
    return (deg - A0) / ARC;
  };
  const onDown = (e) => { e.preventDefault(); svgRef.current.setPointerCapture?.(e.pointerId); setDragging(true); commit(fromPointer(e), false); };
  const onMove = (e) => { if (dragging) commit(fromPointer(e), false); };
  const onUp = () => { if (!dragging) return; setDragging(false); commit(t, true); };
  const onKey = (e) => {
    const presetIdx = DIAL_PRESETS.findIndex(p => Math.abs(p.t - t) < 0.001);
    const map = { ArrowRight: t + 0.02, ArrowUp: t + 0.02, ArrowLeft: t - 0.02, ArrowDown: t - 0.02, Home: 0, End: 1,
      PageUp: DIAL_PRESETS[Math.min(3, (presetIdx < 0 ? DIAL_PRESETS.findIndex(p => p.t > t) - 1 : presetIdx) + 1)]?.t,
      PageDown: DIAL_PRESETS[Math.max(0, (presetIdx < 0 ? DIAL_PRESETS.findIndex(p => p.t > t) : presetIdx) - 1)]?.t };
    if (e.key in map && map[e.key] != null) { e.preventDefault(); commit(map[e.key], e.key.startsWith('Page') || e.key === 'Home' || e.key === 'End'); }
  };

  const speed = tToSpeed(t), deg = A0 + t * ARC;
  const near = DIAL_PRESETS.find(p => Math.abs(p.t - t) < 0.001);
  const readout = speed === 0 ? 'Off' : `${(1 / speed).toFixed(2)}×`;
  const C = 110, R = 78;
  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <svg ref={svgRef} viewBox="0 0 220 220" width="220" height="220" className="shrink-0 touch-none select-none max-w-full cursor-grab active:cursor-grabbing"
        role="slider" tabIndex={0} aria-label="Animation speed" aria-valuemin={0} aria-valuemax={1} aria-valuenow={+t.toFixed(2)} aria-valuetext={near ? near.label : readout}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
        <defs>
          <linearGradient id="dial-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--mute)" /><stop offset="100%" stopColor="var(--ember)" />
          </linearGradient>
        </defs>
        {/* fine ticks */}
        {Array.from({ length: 28 }, (_, i) => {
          const d = A0 + (i / 27) * ARC, [x0, y0] = polar(C, C, R + 9, d), [x1, y1] = polar(C, C, R + 13, d);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round" />;
        })}
        {/* track + fill */}
        <path d={arcPath(C, C, R, A0, A0 + ARC)} fill="none" stroke="var(--well)" strokeWidth="12" strokeLinecap="round" />
        <path d={arcPath(C, C, R, A0, A0 + ARC)} fill="none" stroke="var(--line)" strokeWidth="12" strokeLinecap="round" opacity=".6" />
        {t > 0.004 && <path d={arcPath(C, C, R, A0, deg)} fill="none" stroke="url(#dial-grad)" strokeWidth="12" strokeLinecap="round" />}
        {/* preset detents + labels */}
        {DIAL_PRESETS.map(p => {
          const d = A0 + p.t * ARC, [dx, dy] = polar(C, C, R, d), [lx, ly] = polar(C, C, R + 28, d), on = near && near.label === p.label;
          return (
            <g key={p.label} onPointerDown={(e) => { e.stopPropagation(); commit(p.t, true); }} style={{ cursor: 'pointer' }}>
              <circle cx={dx} cy={dy} r={on ? 4.5 : 3} fill={on ? 'var(--fg)' : 'var(--mute)'} />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="11" fontWeight={on ? 700 : 500}
                fill={on ? 'var(--fg)' : 'var(--mute)'} style={{ fontFamily: 'var(--font-body)' }}>{p.label}</text>
            </g>
          );
        })}
        {/* knob */}
        <circle cx={C} cy={C} r="52" fill="var(--panel)" stroke="var(--line)" strokeWidth="1.5" />
        <circle cx={C} cy={C} r="44" fill="var(--well)" />
        <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: `${C}px ${C}px`, transition: dragging ? 'none' : 'transform .45s var(--ease-spring)' }}>
          <line x1={C} y1={C - 30} x2={C} y2={C - 42} stroke="var(--ember)" strokeWidth="4" strokeLinecap="round" />
        </g>
        <text x={C} y={C - 2} textAnchor="middle" dominantBaseline="middle" fontSize="20" fontWeight="700" fill="var(--fg)" style={{ fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' }}>{readout}</text>
        <text x={C} y={C + 18} textAnchor="middle" fontSize="9.5" letterSpacing=".08em" fill="var(--mute)" style={{ fontFamily: 'var(--font-body)', textTransform: 'uppercase' }}>{near ? near.label : 'Custom'}</text>
      </svg>
      <div className="flex-1 w-full min-w-0 flex flex-col gap-3">
        <div className="text-[12.5px] text-mute">
          {speed === 0 ? 'Motion is off. Everything changes instantly.' : `Animations run at ${readout} speed. Drag the dial, or click a preset to snap to it.`}
        </div>
        {speed !== 0 && <MotionDemo />}
      </div>
    </div>
  );
}

function MotionDemo() {
  return (
    <div className="h-8 rounded-lg bg-well border border-line relative overflow-hidden" aria-hidden="true">
      <span className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full motion-demo"
        style={{ background: 'var(--ember)' }} />
    </div>
  );
}

/* The site owner pastes their OWNER_KEY here once per device. Everyone else can ignore it. */
function OwnerAccess({ on, onChange }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setMsg('');
    try { await saveOwnerKey(key.trim()); setKey(''); setOpen(false); onChange(true); }
    catch (err) { setMsg(err.message); }
    setBusy(false);
  };
  if (on) return (
    <Row title="Owner key active on this device" sub="Links you make here can carry up to 95 MB and last up to 7 days. Remove the key before lending this device to anyone.">
      <div className="flex sm:justify-end"><button id="owner-remove" onClick={() => { clearOwnerKey(); onChange(false); }} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember transition-colors">Remove key</button></div>
    </Row>
  );
  return (
    <Row stack title="Run this site?" sub="Paste your owner key to unlock bigger links (95 MB) and 7-day expiry on this device. Visitors don't need this.">
      {!open
        ? <div><button id="owner-open" onClick={() => setOpen(true)} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute transition-colors">Enter owner key</button></div>
        : <form onSubmit={save} className="flex flex-col sm:flex-row gap-2">
            <label htmlFor="owner-key" className="sr-only">Owner key</label>
            <input id="owner-key" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="Owner key" autoComplete="off"
              className="flex-1 min-w-0 bg-well border border-line rounded-lg px-3 py-2.5 font-mono text-[13px] outline-hidden focus:border-mute" />
            <button id="owner-save" disabled={busy || key.trim().length < 32} className="press rounded-lg px-4 py-2.5 text-[13px] font-semibold btn-primary disabled:opacity-50">{busy ? 'Checking…' : 'Save'}</button>
          </form>}
      {msg && <div role="alert" className="text-[12.5px] text-warn mt-2">{msg}</div>}
    </Row>
  );
}

function Settings({ toast, onPair, peersVersion, onPeersChange, ownerOn, onOwnerChange, settings, setSettings, plan, onCancelPlan, onUpgrade, signedIn, onSignOut, onSignIn, vaultCount, onWipeVault, effectiveTheme, recoverySaved, onRecovery, onNewRecovery, linkLock, onLinkLockToggle, onChangePasscode }) {
  const [confirm, setConfirm] = useState(null); // 'cancel' | 'wipe' | 'reset'
  const set = (k, v) => setSettings(prev => ({ ...prev, [k]: v }));
  const isPro = plan.tier === 'pro';
  const renewDate = new Date(Date.now() + 30 * 864e5).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="stagger flex flex-col gap-4 max-w-3xl mx-auto">
      <Section title="Appearance" i={0}>
        <Row title="Theme" sub={settings.theme === 'system' ? `Following your device · ${effectiveTheme}` : 'Applies right away on this device'}>
          <Seg id="theme" label="Theme" value={settings.theme} onChange={(v) => set('theme', v)}
            options={[{ v: 'system', label: 'System' }, { v: 'dark', label: 'Dark', icon: '☾' }, { v: 'light', label: 'Light', icon: '☀' }]} />
        </Row>
        <Row title="Performance mode" sub={settings.perf
          ? 'On. No animations, blur or glow, and lists refresh less often. Good for older phones and saving battery.'
          : 'Turns off every animation and visual effect so Ashdrop runs as light as possible.'}>
          <div className="flex sm:justify-end"><Toggle id="perf-mode" label="Performance mode" on={!!settings.perf} onChange={(v) => set('perf', v)} /></div>
        </Row>
        <Row title="Animation speed" sub={settings.perf ? 'Paused while Performance mode is on.' : 'How fast steps, modals and meters move'} stack>
          <div className={settings.perf ? 'opacity-40 pointer-events-none select-none' : ''} aria-disabled={settings.perf || undefined}>
            <SpeedDial value={settings.speed} onChange={(v) => set('speed', v)} />
          </div>
        </Row>
      </Section>

      <Section title="Sharing defaults" i={1}>
        <Row title="Default expiration" sub="Pre-selected when you start a new share">
          <Seg id="def-exp" label="Default expiration" small value={settings.defaultExpiry} onChange={(v) => set('defaultExpiry', v)}
            options={[{ v: 'burn', label: '1 view' }, { v: '1h', label: '1 hour' }, { v: '24h', label: '24 hours' }]} />
        </Row>
        <Row title="Password + lockout on by default" sub="New shares start with the password layer switched on">
          <div className="flex sm:justify-end"><Toggle id="def-pw" label="Password on by default" on={settings.defaultPw} onChange={(v) => set('defaultPw', v)} /></div>
        </Row>
        <Row title="Wrong tries before a link is destroyed" sub="Used whenever the password layer is on">
          <Seg id="def-att" label="Default lockout attempts" small value={settings.defaultAttempts} onChange={(v) => set('defaultAttempts', v)}
            options={[1, 3, 5, 10].map(n => ({ v: n, label: String(n) }))} />
        </Row>
      </Section>

      {FEATURES.pro && <Section title="Subscription" i={2}>
        <div className="py-4 flex flex-wrap items-center gap-4 justify-between border-b border-line">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-[22px] font-bold">{isPro ? `Pro · ${plan.gb} GB` : 'Free · 5 GB'}</span>
              <span className={`text-[10.5px] font-semibold uppercase tracking-wider rounded-full px-2 py-px border ${isPro ? 'text-ember border-ember/40' : 'text-cyan border-cyan/40'}`}>{isPro ? 'Active' : 'Current plan'}</span>
            </div>
            <div className="text-[12.5px] text-mute mt-1">
              {isPro
                ? plan.billing === 'monthly' ? `$${plan.price.toFixed(2)} per month · renews ${renewDate}` : `30-day pass · ends ${renewDate} · will not renew`
                : 'Private vault, burn links with lockout, no card on file'}
            </div>
          </div>
          <button onClick={() => onUpgrade(isPro ? Math.min(100, plan.gb + 10) : 10)} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold bg-ember text-ink hover:brightness-110 transition">{isPro ? 'Change plan' : 'Upgrade to Pro'}</button>
        </div>
        {isPro && (
          <div className="py-4">
            {confirm === 'cancel' ? (
              <div className="pop rounded-xl border border-ember/40 bg-[var(--ember-soft)] p-4">
                <div className="font-semibold text-[14px]">Cancel Pro now?</div>
                <ul className="text-[12.5px] text-mute mt-2 flex flex-col gap-1 list-disc pl-4">
                  <li>Billing stops immediately. You are not charged again.</li>
                  <li>Your vault stays readable for 30 days so you can download everything.</li>
                  <li>Over 5 GB after that, new uploads are paused until you make room.</li>
                </ul>
                <div className="flex gap-2 mt-3">
                  <button id="cancel-confirm" onClick={() => { onCancelPlan(); setConfirm(null); }} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold bg-ember text-ink">Cancel subscription</button>
                  <button onClick={() => setConfirm(null)} className="rounded-lg px-3.5 py-2 text-[13px] text-mute hover:text-fg">Keep Pro</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-[12.5px] text-mute">No retention survey, no email. One click and it is done.</div>
                <button id="cancel-plan" onClick={() => setConfirm('cancel')} className="rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember transition-colors">Cancel subscription</button>
              </div>
            )}
          </div>
        )}
      </Section>}

      <Section title="Privacy" i={3}>
        {account.session() ? <Row title="My links" sub="Kept in your encrypted vault. They open when your vault opens, on any device you sign in on. No separate passcode."><div /></Row> : <>
        <Row title="Require a passcode for My links" sub={linkLock.on
          ? `On. Saved links are encrypted on this device${linkLock.unlocked ? ' and unlocked right now (they lock again after 10 minutes).' : '.'}`
          : settings.linksLock ? 'On, but no passcode is set yet. You will choose one the next time you open My links.' : 'Off. Anyone using this browser can see and open the links you sent.'}>
          <div className="flex sm:justify-end"><Toggle id="links-lock" label="Require a passcode for My links" on={linkLock.on || !!settings.linksLock} onChange={onLinkLockToggle} /></div>
        </Row>
        {linkLock.on && (
          <Row title="Passcode" sub="Change it any time. Your links stay encrypted while you do.">
            <div className="flex sm:justify-end"><button id="change-passcode" onClick={onChangePasscode} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute transition-colors">Change passcode</button></div>
          </Row>
        )}</>}
      </Section>

      {FEATURES.cloudVault && <Section title="Account" i={4}>
        <AccountSettings toast={toast} />
      </Section>}

      <Section title="Your devices" i={4}>
        <DevicesSettings onPair={onPair} peersVersion={peersVersion} onChange={onPeersChange} />
      </Section>

      <Section title="Owner access" i={4}>
        <OwnerAccess on={ownerOn} onChange={onOwnerChange} />
        {ownerOn && <OwnerStats />}
        {ownerOn && FEATURES.cloudVault && <InviteMaker />}
      </Section>

      {(FEATURES.accounts || FEATURES.recovery) && <Section title="Account" i={4}>
        {FEATURES.accounts && <Row title={signedIn ? 'Signed in' : 'Signed out'} sub={signedIn ? 'demo@ashdrop.cc · your vault key is unlocked on this device' : 'Sharing still works anonymously. Sign in to open your vault.'}>
          <div className="flex sm:justify-end">
            {signedIn
              ? <button id="sign-out" onClick={onSignOut} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute transition-colors">Sign out</button>
              : <button id="sign-in" onClick={onSignIn} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold btn-primary transition">Sign in</button>}
          </div>
        </Row>}
        {FEATURES.recovery && <Row title="Recovery key" sub={recoverySaved ? 'Saved. A new key cancels the old one.' : 'Not saved yet. Without it, a forgotten password means a lost vault.'}>
          <div className="flex sm:justify-end items-center gap-2 flex-wrap">
            {!recoverySaved && <span className="text-[11.5px] font-semibold text-warn">Not saved</span>}
            <button id="view-recovery" onClick={onRecovery} className={`press rounded-lg px-3.5 py-2 text-[13px] font-semibold transition ${recoverySaved ? 'border border-line hover:border-mute' : 'btn-primary'}`}>{recoverySaved ? 'View key' : 'Save key'}</button>
            {recoverySaved && <button id="new-recovery" onClick={onNewRecovery} className="press rounded-lg px-3 py-2 text-[13px] text-mute hover:text-fg">Make new</button>}
          </div>
        </Row>}
        {FEATURES.accounts && <Row title="Where your keys live" sub="Your vault key is derived from your password in this browser. Ashdrop stores only encrypted data and cannot reset it for you.">
          <div className="flex sm:justify-end items-center gap-2 text-[12px] text-ok"><span className="w-2 h-2 rounded-full bg-ok" aria-hidden="true" />Zero-knowledge</div>
        </Row>}
      </Section>}

      <Section title="Danger zone" i={5} tone="danger">
        {FEATURES.vaultFiles && (
        <Row title="Delete everything in my vault" sub={`${vaultCount} file${vaultCount === 1 ? '' : 's'}. This cannot be undone. Nobody, including Ashdrop, can recover them.`}>
          <div className="flex sm:justify-end gap-2">
            {confirm === 'wipe' ? (
              <>
                <button id="wipe-confirm" onClick={() => { onWipeVault(); setConfirm(null); }} className="press rounded-lg px-3 py-2 text-[13px] font-semibold bg-ember text-ink">Delete all</button>
                <button onClick={() => setConfirm(null)} className="rounded-lg px-3 py-2 text-[13px] text-mute hover:text-fg">Keep</button>
              </>
            ) : (
              <button id="wipe" onClick={() => setConfirm('wipe')} disabled={!vaultCount} className="rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-ember hover:text-ember transition-colors disabled:opacity-40">Delete vault files</button>
            )}
          </div>
        </Row>
        )}
        <Row title="Reset settings" sub="Theme, motion and sharing defaults go back to how Ashdrop ships">
          <div className="flex sm:justify-end">
            <button id="reset" onClick={() => setSettings({ ...DEFAULT_SETTINGS })} className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold border border-line hover:border-mute transition-colors">Reset</button>
          </div>
        </Row>
      </Section>
    </div>
  );
}

/* ---------- main app ---------- */
const FORMATS = [
  { id: 'Plain text', ext: '.txt', sub: 'Notes, messages, passwords' },
  { id: 'Markdown', ext: '.md', sub: 'Formatted notes' },
  { id: 'JSON', ext: '.json', sub: 'Data, configs' },
  { id: 'YAML', ext: '.yml', sub: 'Configs' },
  { id: 'Bash', ext: '.sh', sub: 'Shell scripts' },
  { id: 'JavaScript', ext: '.js', sub: 'Code' },
  { id: 'TypeScript', ext: '.ts', sub: 'Code' },
  { id: 'Python', ext: '.py', sub: 'Code' },
  { id: 'SQL', ext: '.sql', sub: 'Queries' },
  { id: 'Go', ext: '.go', sub: 'Code' },
  { id: 'Rust', ext: '.rs', sub: 'Code' },
];
const FORMAT_COLOR = { 'Plain text': '#c9d1dc', Markdown: '#8fb3ff', JSON: '#f5c451', YAML: '#ff8fa3', Bash: '#7ee2a8',
  JavaScript: '#f7df5e', TypeScript: '#5aa9ff', Python: '#6fc3ff', SQL: '#d58bff', Go: '#5cd6e0', Rust: '#ff9a62' };
const colorOf = (l) => FORMAT_COLOR[l] || 'var(--fg)';
const FINE_POINTER = (() => { try { return matchMedia('(pointer: fine)').matches; } catch { return false; } })(); // no keyboard pop-up on phones
/** A careful guess at the format, so nobody has to pick one. When unsure, plain text. */
function guessFormat(t) {
  const s = t.trim();
  if (s.length < 12) return 'Plain text';
  if (/^[[{]/.test(s)) { try { JSON.parse(s); return 'JSON'; } catch {} }
  if (/^#!.*\b(ba|z)?sh\b/.test(s) || /^(\$ |sudo |apt |npm |npx |git |curl |cd |export )/m.test(s) && s.split('\n').length < 40) return 'Bash';
  if (/^\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/im.test(s)) return 'SQL';
  if (/^package \w+$/m.test(s) || /^func \w+\(/m.test(s)) return 'Go';
  if (/\bfn \w+\(|\blet mut\b|\bimpl\b.*\{/.test(s)) return 'Rust';
  if (/^\s*(def \w+\(|from [\w.]+ import |import \w+$|class \w+(\(.*\))?:$)/m.test(s)) return 'Python';
  if (/\binterface \w+ \{|:\s*(string|number|boolean)\b/.test(s) && /\b(const|let|function|export)\b/.test(s)) return 'TypeScript';
  if (/\b(const|let|var) \w+ =|\bfunction\b|=>|console\.log|require\(/.test(s) && /[;{}()]/.test(s)) return 'JavaScript';
  if (/^(#{1,6} |```|- \[[ x]\] )/m.test(s)) return 'Markdown';
  return 'Plain text';
}
const extOf = (l) => (FORMATS.find(f => f.id === l) || FORMATS[0]).ext;



function App() {
  const [view, setView] = useState(() => (/^\/nearby\/?$/.test(location.pathname) ? 'nearby' : /^\/vault\/?$/.test(location.pathname) ? 'vault' : 'share'));
  const [text, setText] = useState('');
  const [lang, setLang] = useState('Plain text');
  const [langPicked, setLangPicked] = useState(false); // once chosen by hand, stop guessing
  const [optsOpen, setOptsOpen] = useState(false);
  const [dragPage, setDragPage] = useState(false);
  const [files, setFiles] = useState([]);
  const file = files[0] || null;                      // the first (or only) file
  const setFile = (f) => setFiles(f ? [f] : []);      // replace everything with one file
  const filesSize = files.reduce((n, f) => n + f.size, 0);
  const filesLabel = files.length > 1 ? `${files.length} files` : file ? file.name : '';
  const kind = files.length ? 'file' : 'paste'; // decided by what you put in: files, or else text
  const [drag, setDrag] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [plan, setPlan] = useState({ tier: 'free' });
  const [signedIn, setSignedIn] = useState(true);
  const [appToast, setAppToast] = useState(null);
  const [sysDark, setSysDark] = useState(() => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return true; } });
  const [expiry, setExpiry] = useState(() => loadSettings().defaultExpiry);
  const [pwOn, setPwOn] = useState(() => loadSettings().defaultPw);
  const [qrOnly, setQrOnly] = useState(false);
  const [codeOn, setCodeOn] = useState(false);
  // Your devices: pairing, and items other devices sent to this one.
  const [pairOpen, setPairOpen] = useState(false);
  const [peersVersion, setPeersVersion] = useState(0);
  const [inbox, setInbox] = useState([]);
  const [arrival, setArrival] = useState(null);
  // Touch to send, receiving side: a paired phone is ready, so show where to touch.
  const [touchTarget, setTouchTarget] = useState(null); // { from, fromName, until }
  const waitingReady = useRef(null); // a "ready" that came while this tab was hidden
  const showTouchTarget = (s) => {
    setTouchTarget({ from: s.from, fromName: s.fromName, until: s.until });
    const peer = getPeers().find(p => p.inboxId === s.from);
    if (peer) touchSignal(peer, 'here', s.until);
  };
  const onTouchSignal = (s) => {
    if (s.state === 'ready' && s.until > Date.now()) {
      if (document.visibilityState === 'visible') showTouchTarget(s); else waitingReady.current = s;
    } else if (s.state === 'off') { setTouchTarget(t => (t && t.from === s.from ? null : t)); if (waitingReady.current?.from === s.from) waitingReady.current = null; }
    else if (s.state === 'here') window.dispatchEvent(new CustomEvent('ashdrop-touch-here', { detail: s }));
  };
  useEffect(() => {
    const onVis = () => { const s = waitingReady.current; if (document.visibilityState === 'visible' && s) { waitingReady.current = null; if (s.until > Date.now()) showTouchTarget(s); } };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => { if (!touchTarget) return; const t = setTimeout(() => setTouchTarget(null), Math.max(0, touchTarget.until - Date.now())); return () => clearTimeout(t); }, [touchTarget]);
  useEffect(() => {
    if (!getPeers().length && !hasPendingPairing()) return;
    return listenInbox((all) => {
      // "We're paired" notes from a device that joined while our pairing window was closed.
      const paired = all.filter(it => it.type === 'paired');
      if (paired.length) {
        ackInbox(paired.map(it => it.msgId));
        const fresh = paired.filter(it => !it.already);
        if (fresh.length) { toast(`Paired with ${fresh.map(it => it.peer.name).join(', ')}. You can send to it now.`); setPeersVersion(v => v + 1); }
      }
      // Touch to send signals: short-lived, handled right away, never kept in the inbox.
      const sig = all.filter(it => it.type === 'touch');
      if (sig.length) { ackInbox(sig.map(it => it.msgId)); sig.forEach(onTouchSignal); }
      const items = all.filter(it => it.type !== 'paired' && it.type !== 'touch');
      if (!items.length) return;
      // Sent by a touch: it is what you were waiting for, so open it straight away.
      const touched = items.find(it => it.touch && Date.now() - (it.sentAt || 0) < 60000);
      if (touched) { setTouchTarget(null); openInboxItem(touched); if (items.length === 1) return; }
      setInbox(prev => [...prev, ...items.filter(it => !prev.some(p => p.msgId === it.msgId))]);
      setArrival({ item: items[items.length - 1], more: items.length - 1 });
    });
  }, [peersVersion, pairOpen]); // re-check after the pairing window closes: a pairing may still be waiting
  const openInboxItem = (it) => { setArrival(null); setInbox(prev => prev.filter(p => p.msgId !== it.msgId)); ackInbox([it.msgId]); setRecipientOf({ id: it.id, keyStr: it.keyStr }); };
  const dismissInboxItem = (it) => { setInbox(prev => prev.filter(p => p.msgId !== it.msgId)); ackInbox([it.msgId]); };
  const [progress, setProgress] = useState(null); // upload progress 0..1 while a big link is sent
  // Site owner mode: bigger links and 7-day expiry, unlocked by the owner key saved in Settings.
  const [ownerOn, setOwnerOn] = useState(() => !!getOwnerKey());
  const maxTotal = ownerOn ? OWNER_MAX_TOTAL : MAX_TOTAL;
  const limitLabel = ownerOn ? '95 MB' : '25 MB';
  const [pw, setPw] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(() => loadSettings().defaultAttempts);
  const [recipientOf, setRecipientOf] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [pro, setPro] = useState(null); // { gb, reason }
  const [vaultFiles, setVaultFiles] = useState([]);
  // Folders start empty; you make your own. (v2 key: older builds saved sample folders under v1.)
  const savedFolders = useMemo(() => { try { localStorage.removeItem('ashdrop.folders'); return JSON.parse(localStorage.getItem('ashdrop.folders.v2') || 'null'); } catch { return null; } }, []);
  const [folders, setFolders] = useState(savedFolders?.list || []);
  const [folderColors, setFolderColors] = useState(savedFolders?.colors || {});
  useEffect(() => { try { localStorage.setItem('ashdrop.folders.v2', JSON.stringify({ list: folders, colors: folderColors })); } catch {} }, [folders, folderColors]);
  const [vaultTabState, setVaultTab] = useState(() => (account.session() || /^\/vault\/?$/.test(location.pathname) ? 'files' : 'links'));
  const vaultTab = FEATURES.vaultFiles || FEATURES.cloudVault ? vaultTabState : 'links';
  // Links you sent, kept on this device only (they include each link's key and owner token).
  // With the passcode lock on they are encrypted at rest and only decrypted in memory after unlocking.
  const [lockOn, setLockOn] = useState(linkStore.hasLock);
  const [unlocked, setUnlocked] = useState(null); // { priv, privJwk } while My links is open
  const [links, setLinks] = useState(() => (linkStore.hasLock() ? [] : linkStore.loadPlain()));
  const [linksRefresh, setLinksRefresh] = useState(0);
  const [acctLinksTick, setAcctLinksTick] = useState(0);
  const [passModal, setPassModal] = useState(null); // { mode, needCurrent }
  const linksVisible = !lockOn || !!unlocked;
  const lockLinks = () => { setUnlocked(null); setLinks([]); };
  useEffect(() => { if (!unlocked) return; const t = setTimeout(lockLinks, 10 * 60e3); return () => clearTimeout(t); }, [unlocked]);
  const setPasscode = async (pass) => {
    const r = await linkStore.createLock(pass, linkStore.loadPlain());
    setLockOn(true); setUnlocked({ priv: r.priv, privJwk: r.privJwk }); setLinks(r.records);
    setSettings(prev => ({ ...prev, linksLock: true }));
  };
  const unlockLinks = async (pass) => {
    const r = await linkStore.unlock(pass);
    setUnlocked({ priv: r.priv, privJwk: r.privJwk }); setLinks(r.records);
    return r;
  };
  const turnLockOff = async (priv) => {
    await linkStore.removeLock(priv);
    setLockOn(false); setUnlocked(null); setLinks(linkStore.loadPlain());
    setSettings(prev => ({ ...prev, linksLock: false }));
    toast('My links no longer needs a passcode.');
  };
  const onLinkLockToggle = (want) => {
    if (want) { if (!lockOn) setPassModal({ mode: 'set' }); return; }
    if (!lockOn) { setSettings(prev => ({ ...prev, linksLock: false })); return; }
    if (unlocked) turnLockOff(unlocked.priv); else setPassModal({ mode: 'off' });
  };
  const submitPassModal = async ({ current, next }) => {
    const m = passModal.mode;
    if (m === 'set') { await setPasscode(next); toast('My links is locked with your passcode.'); }
    else if (m === 'off') { const r = await unlockLinks(current); await turnLockOff(r.priv); }
    else if (m === 'change') {
      const jwk = unlocked ? unlocked.privJwk : (await unlockLinks(current)).privJwk;
      await linkStore.changePasscode(jwk, next); toast('Passcode changed.');
    }
    setPassModal(null);
  };
  const [recoveryKey, setRecoveryKey] = useState(makeRecoveryKey);
  const [recoverySaved, setRecoverySaved] = useState(() => { try { return localStorage.getItem('ashdrop.recovery') === '1'; } catch { return false; } });
  const [showRecovery, setShowRecovery] = useState(false);
  useEffect(() => { try { localStorage.setItem('ashdrop.recovery', recoverySaved ? '1' : '0'); } catch {} }, [recoverySaved]);

  // theme + motion follow settings
  const hostTheme = () => document.documentElement.getAttribute('data-theme');
  const [hostT, setHostT] = useState(hostTheme);
  useEffect(() => {
    let mq; const onMq = (e) => setSysDark(e.matches);
    try { mq = matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener('change', onMq); } catch {}
    const mo = new MutationObserver(() => setHostT(hostTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { try { mq && mq.removeEventListener('change', onMq); } catch {} mo.disconnect(); };
  }, []);
  const effectiveTheme = settings.theme === 'system' ? (hostT === 'light' || hostT === 'dark' ? hostT : (sysDark ? 'dark' : 'light')) : settings.theme;
  useEffect(() => { document.documentElement.setAttribute('data-ash', effectiveTheme); }, [effectiveTheme]);
  useEffect(() => {
    PERF = !!settings.perf;
    SPEED = PERF ? 0 : settings.speed;
    const root = document.documentElement;
    root.style.setProperty('--spd', String(settings.speed || 1));
    if (SPEED === 0) root.setAttribute('data-motion', 'off'); else root.removeAttribute('data-motion');
    if (PERF) root.setAttribute('data-perf', 'on'); else root.removeAttribute('data-perf');
  }, [settings.speed, settings.perf]);
  useEffect(() => { saveSettings(settings); }, [settings]);
  const setSettingsAndDefaults = (updater) => setSettings(prev => {
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next.defaultExpiry !== prev.defaultExpiry) setExpiry(next.defaultExpiry);
    if (next.defaultPw !== prev.defaultPw) setPwOn(next.defaultPw);
    if (next.defaultAttempts !== prev.defaultAttempts) setMaxAttempts(next.defaultAttempts);
    return next;
  });
  const toast = (text) => { setAppToast(text); setTimeout(() => setAppToast(t => (t === text ? null : t)), 3200); };
  const cap = plan.tier === 'pro' ? plan.gb * 1e9 : FREE_CAP;
  const fileInput = useRef(null);

  const lines = useMemo(() => text.split('\n').length, [text]);
  const bytes = kind === 'file' ? filesSize : enc.encode(text).length;
  const hasContent = kind === 'file' ? files.length > 0 : !!text.trim();

  useEffect(() => { if (!langPicked) setLang(guessFormat(text)); }, [text, langPicked]);
  useEffect(() => { setErr(e => (e.startsWith('Paste or type') ? '' : e)); }, [text, files.length]); // the "empty" hint goes once there is something
  const shareFromVault = async (item) => {
    try {
      const f = await vaultItemToFile(item);
      setView('share'); setFile(f); setErr('');
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
    } catch (e) { setErr('Could not open that vault file: ' + e.message); }
  };
  const pickFromVault = async (item) => {
    if (item.size - 16 > SHARE_LIMIT) { setErr(`${item.name} is ${fmtDec(item.size)}. Free links carry up to 25 MB.`); return; }
    try { setFile(await vaultItemToFile(item)); setErr(''); } catch (e) { setErr('Could not open that vault file: ' + e.message); }
  };
  const startOver = () => { setText(''); setFile(null); setLang('Plain text'); setLangPicked(false); setOptsOpen(false); setPw(''); setPwOn(settings.defaultPw); setExpiry(settings.defaultExpiry); setMaxAttempts(settings.defaultAttempts); setQrOnly(false); setCodeOn(false); setErr(''); };

  useEffect(() => { if (!ownerOn && expiry === '7d') setExpiry('24h'); }, [ownerOn, expiry]);
  // Add files to the list. Everything together must stay under the limit (25 MB, or 95 MB for the site owner).
  const addFiles = (list) => {
    const incoming = Array.from(list || []).filter(f => !files.some(g => g.name === f.name && g.size === f.size && g.lastModified === f.lastModified));
    if (!incoming.length) return;
    let next = [...files], skipped = [];
    for (const f of incoming) {
      if (next.length >= MAX_FILES) { skipped.push(`${f.name} (limit of ${MAX_FILES} files)`); continue; }
      if (next.reduce((n, g) => n + g.size, 0) + f.size > maxTotal) { skipped.push(`${f.name} (${fmtBytes(f.size)})`); continue; }
      next.push(f);
    }
    setFiles(next);
    setErr(skipped.length ? `Not added, it would go over ${limitLabel} in total: ${skipped.join(', ')}.` : '');
  };
  const removeFile = (i) => { setFiles(fs => fs.filter((_, j) => j !== i)); setErr(''); };

  // Paste or drop anywhere on the Share screen.
  const addFilesRef = useRef(addFiles); addFilesRef.current = addFiles;
  useEffect(() => {
    if (view !== 'share' || result || recipientOf) return;
    const onPaste = (e) => {
      const fs = [...(e.clipboardData?.files || [])];
      if (fs.length) { e.preventDefault(); addFilesRef.current(fs); return; }
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return; // normal paste into a field
      const t = e.clipboardData?.getData('text');
      if (!t) return;
      e.preventDefault(); setText(p => p + t);
      setTimeout(() => document.getElementById('editor')?.focus(), 0);
    };
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const onOver = (e) => { if (hasFiles(e)) { e.preventDefault(); setDragPage(true); } };
    const onLeave = (e) => { if (!e.relatedTarget) setDragPage(false); };
    const onDrop = (e) => { setDragPage(false); if (e.defaultPrevented || !e.dataTransfer?.files?.length) return; e.preventDefault(); addFilesRef.current(e.dataTransfer.files); };
    window.addEventListener('paste', onPaste); window.addEventListener('dragover', onOver); window.addEventListener('dragleave', onLeave); window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('paste', onPaste); window.removeEventListener('dragover', onOver); window.removeEventListener('dragleave', onLeave); window.removeEventListener('drop', onDrop); };
  }, [view, result, recipientOf]);

  const [sendingTo, setSendingTo] = useState(null);
  // to: nothing (show the link), one paired device, or several. Several devices each get their own copy,
  // sealed with its own key, so a burn-after-reading link burns separately on every device.
  const create = async (to = null, { touch = false } = {}) => {
    const targets = Array.isArray(to) ? to.filter(p => p?.inboxId) : to?.inboxId ? [to] : [];
    setErr('');
    if (!hasContent) return setErr('Paste or type something first, or drop files anywhere on the page.');
    if (pwOn && pw.length < 6) return setErr('Use a password of at least 6 characters, or turn the password off.');
    if (!crypto?.subtle) return setErr('This browser does not expose Web Crypto here. Open the page over HTTPS.');
    setBusy(true);
    try {
      // Names, types and format are sealed inside the payload; the server sees only bytes.
      let header, content;
      if (kind === 'file' && files.length > 1) ({ header, content } = await bundleFiles(files));
      else if (kind === 'file') { header = { kind, name: file.name, mime: file.type || '' }; content = new Uint8Array(await file.arrayBuffer()); }
      else { header = { kind, lang }; content = enc.encode(text); }
      const payload = pack(header, content);
      const label = kind === 'file' ? (files.length > 1 ? `${files.length} files: ${files.map(f => f.name).join(', ')}`.slice(0, 80) : file.name) : ((text.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 60));
      const makeLink = async (withCode, forName) => {
        const sealed = await sealPayload(payload, pwOn ? pw : null);
        // Optional typeable code. On the tiny chance it is already taken, pick another one.
        let code = null, created;
        for (let tries = 0; ; tries++) {
          code = withCode ? generateCode() : null;
          try {
            created = await createLink({ ...sealed, expiry, maxAttempts: pwOn ? maxAttempts : null, code: code ? await sealCode(code, sealed.keyStr) : null,
              ownerKey: ownerOn ? getOwnerKey() : '', onProgress: sealed.ct.byteLength > 2e6 ? setProgress : undefined });
            break;
          } catch (e) { if (e.code !== 'code_taken' || tries >= 2) throw e; }
        }
        const { id, ownerToken, expiresAt } = created;
        const shown = forName ? `${label} → ${forName}`.slice(0, 90) : label;
        const record = { id, keyStr: sealed.keyStr, ownerToken, expiresAt, maxAttempts: pwOn ? maxAttempts : null, kind, lang: kind === 'paste' ? lang : null, label: shown, expiry, password: pwOn, qrOnly, code, createdAt: Date.now() };
        if (myLinks.active()) { await myLinks.add(record); setAcctLinksTick(n => n + 1); } // in the vault, opens with it
        else {
          await linkStore.addLink(record); // sealed to the lock's public key when the lock is on
          if (linksVisible) setLinks(prev => [record, ...prev]);
        }
        return { ...sealed, id, expiry, expiresAt, label, password: pwOn, maxAttempts, kind, qrOnly, code };
      };
      if (!targets.length) { setResult(await makeLink(codeOn)); return; }
      const sent = [], failed = []; let lastRes = null;
      for (const peer of targets) {
        setSendingTo(peer.inboxId);
        try {
          const res = await makeLink(false, targets.length > 1 ? peer.name : null); lastRes = res;
          await sendToPeer(peer, { id: res.id, keyStr: res.keyStr, label, kind, expiry, expiresAt: res.expiresAt, password: pwOn, ...(touch ? { touch: true } : {}) });
          sent.push(peer.name);
        } catch (e) { failed.push(`${peer.name} (${e.message})`); }
      }
      setSendingTo(null);
      if (sent.length) {
        const who = sent.length === 1 ? sent[0] : `${sent.length} devices`;
        toast(`Sent to ${who}.${pwOn ? ' Send the password another way.' : sent.length > 1 ? ' Each got its own copy.' : ' It opens there with one tap.'}${failed.length ? ` Not sent: ${failed.join(', ')}.` : ''}`);
        if (!failed.length) startOver();
      } else {
        if (lastRes && targets.length === 1) setResult(lastRes);
        toast(`Could not reach ${failed.join(', ')}.${lastRes && targets.length === 1 ? ' Here is the link instead.' : ''}`);
      }
    } catch (e) { setErr(e.message.startsWith('Could not') || e.message.startsWith('That') || e.message.startsWith('Too many') ? e.message : 'Encryption failed: ' + e.message); }
    finally { setBusy(false); setProgress(null); setSendingTo(null); }
  };

  const NAV = [['share', 'Share'], ['nearby', 'Nearby'], ['vault', FEATURES.vaultFiles || FEATURES.cloudVault ? 'Vault' : 'My links']];
  const navIdx = NAV.findIndex(([id]) => id === view); // -1 on Settings
  const GEAR = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
  return (
    <div className="min-h-full">
      {/* header */}
      <header className="sticky z-40 bg-ink/95 backdrop-blur-sm border-b border-line" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <div className="gutter max-w-6xl mx-auto py-3 flex items-center gap-1.5 sm:gap-3">
          <button onClick={() => { setView('share'); }} aria-label="Ashdrop home" className="shrink-0"><Logo /></button>
          {ownerOn && <span id="owner-chip" title="Owner key active on this device: links up to 95 MB, 7-day expiry" style={{ '--t1': 'var(--gold)' }} className="tone-chip hidden sm:inline-flex border rounded-full px-2 py-0.5 text-[11px] font-semibold">Owner</span>}
          <nav className="flex-1 sm:flex-none sm:mx-auto min-w-0" aria-label="Sections">
            <div className="relative grid grid-cols-3 gap-1 p-1 rounded-xl bg-panel border border-line w-full sm:w-max">
              <span className="absolute top-1 bottom-1 left-1 rounded-lg fill-on transition-all duration-500" aria-hidden="true"
                style={{ width: 'calc((100% - 16px) / 3)', transform: `translateX(calc(${Math.max(navIdx, 0)} * (100% + 4px))) scale(${navIdx < 0 ? 0.85 : 1})`, opacity: navIdx < 0 ? 0 : 1, transitionTimingFunction: 'var(--ease-out)' }} />
              {NAV.map(([id, label]) => (
                <button key={id} id={`nav-${id}`} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}
                  className={`relative z-10 px-1 sm:px-3.5 py-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap text-center transition-colors duration-300 ${view === id ? 'on-fill font-semibold' : 'text-mute hover:text-fg'}`}>
                  {label}
                  {id === 'vault' && inbox.length > 0 && <span id="inbox-badge" className="ml-1.5 inline-grid place-items-center min-w-4 h-4 px-1 rounded-full bg-ember text-[10.5px] font-semibold text-[#1a0d05] align-[1px]" aria-label={`${inbox.length} new`}>{inbox.length}</span>}
                </button>
              ))}
            </div>
          </nav>
          <button id="nav-how" onClick={() => setView('how')} aria-label="How it works" title="How it works" aria-current={view === 'how' ? 'page' : undefined}
            className={`press shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-lg grid place-items-center border transition-colors duration-300 ${view === 'how' ? 'bg-fg text-ink border-fg' : 'border-line text-mute hover:text-fg hover:border-mute'}`}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01"/></svg>
          </button>
          <button id="nav-settings" onClick={() => setView('settings')} aria-label="Settings" title="Settings" aria-current={view === 'settings' ? 'page' : undefined}
            className={`group shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-lg grid place-items-center border transition-colors duration-300 ${view === 'settings' ? 'bg-fg text-ink border-fg' : 'border-line text-mute hover:text-fg hover:border-mute'}`}>
            <span className={`transition-transform duration-500 ${view === 'settings' ? 'rotate-90' : 'group-hover:rotate-45'}`} style={{ transitionTimingFunction: 'var(--ease-out)' }}>{GEAR}</span>
          </button>
          {!FEATURES.pro && FEATURES.accounts && !signedIn
            ? <button onClick={() => { setSignedIn(true); toast('Signed in. Your vault is unlocked.'); }} className="press shrink-0 rounded-lg px-3 py-2 text-[13px] font-semibold btn-primary transition whitespace-nowrap">Sign in</button>
            : !FEATURES.pro ? null
            : FEATURES.accounts && !signedIn
            ? <button onClick={() => { setSignedIn(true); toast('Signed in. Your vault is unlocked.'); }} className="press shrink-0 rounded-lg px-3 py-2 text-[13px] font-semibold btn-primary transition whitespace-nowrap">Sign in</button>
            : plan.tier === 'pro'
              ? <button onClick={() => setView('settings')} className="shrink-0 rounded-lg px-3 py-2 text-[12px] font-semibold border border-ember/50 text-ember whitespace-nowrap">PRO</button>
              : <button onClick={() => setPro({ gb: 10 })} className="press shrink-0 rounded-lg px-3 py-2 text-[13px] font-semibold bg-ember text-ink hover:brightness-110 transition whitespace-nowrap">Pro<span className="hidden sm:inline"> Upgrade</span></button>}
        </div>
      </header>

      <main className="gutter max-w-6xl mx-auto py-6 sm:py-10">
        {view === 'settings' ? (
          <div key="settings" className="step-fwd">
            <div className="max-w-3xl mx-auto mb-6">
              <h1 className="font-display text-[28px] sm:text-[34px] font-bold leading-tight">Settings</h1>
              <p className="text-mute text-[14px] mt-2">Saved on this device. Nothing here is sent to Ashdrop.</p>
            </div>
            <Settings toast={toast} settings={settings} setSettings={setSettingsAndDefaults} plan={plan} effectiveTheme={effectiveTheme} ownerOn={ownerOn} onOwnerChange={setOwnerOn} onPair={() => setPairOpen(true)} peersVersion={peersVersion} onPeersChange={() => setPeersVersion(v => v + 1)}
              onCancelPlan={() => { setPlan({ tier: 'free' }); toast('Pro canceled. Billing has stopped.'); }}
              onUpgrade={(gb) => setPro({ gb })}
              signedIn={signedIn} onSignOut={() => { setSignedIn(false); setView('share'); toast('Signed out. Your vault key was cleared from this tab.'); }}
              onSignIn={() => { setSignedIn(true); toast('Signed in. Your vault is unlocked.'); }}
              vaultCount={vaultFiles.length} onWipeVault={() => { setVaultFiles([]); toast('All vault files deleted.'); }}
              recoverySaved={recoverySaved} onRecovery={() => setShowRecovery(true)}
              onNewRecovery={() => { setRecoveryKey(makeRecoveryKey()); setRecoverySaved(false); setShowRecovery(true); }}
              linkLock={{ on: lockOn, unlocked: !!unlocked }} onLinkLockToggle={onLinkLockToggle}
              onChangePasscode={() => setPassModal({ mode: 'change', needCurrent: !unlocked })} />
          </div>
        ) : view === 'how' ? (
          <div key="how" className="fade-in py-2">
            <HowItWorks onShare={() => setView('share')} onVault={() => setView('vault')} />
          </div>
        ) : view === 'nearby' ? (
          <div key="nearby" className="fade-in"><NearbyView /></div>
        ) : view === 'vault' ? (
          <div key="vault" className="step-fwd">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
              <div>
                <h1 className="font-display text-[28px] sm:text-[34px] font-bold leading-tight">{vaultTab === 'links' ? 'My links' : 'Vault'}</h1>
                <p className="text-mute text-[14px] mt-2">{vaultTab === 'links' ? 'Every link you sent, live. See when it is opened and revoke it early.' : 'Files you keep. Encrypted in this browser before upload, so only you can open them.'}</p>
              </div>
              {(FEATURES.cloudVault || (FEATURES.vaultFiles && signedIn)) && <div className="w-full sm:w-64"><Seg id="vault-tab" label="Vault section" value={vaultTab} onChange={setVaultTab}
                options={[{ v: 'files', label: 'Files' }, { v: 'links', label: myLinks.active() ? 'My links' : linksVisible ? `My links${links.length ? ` · ${links.length}` : ''}` : 'My links (locked)' }]} /></div>}
            </div>
            {vaultTab === 'links' && <InboxPanel items={inbox} onOpen={openInboxItem} onDismiss={dismissInboxItem} />}
            {(vaultTab === 'links'
                ? <div key="links" className="step-fwd">{
                    myLinks.active()
                      ? <AccountLinks toast={toast} refresh={acctLinksTick} onOpen={(l) => setRecipientOf({ id: l.id, keyStr: l.keyStr })} onNew={() => setView('share')} />
                    : settings.linksLock && !lockOn
                      ? <LinksGate stage="set" onSet={async (p) => { await setPasscode(p); toast('My links is locked with your passcode.'); }} onSkip={() => setSettings(prev => ({ ...prev, linksLock: false }))} />
                      : lockOn && !unlocked
                        ? <LinksGate stage="enter" count={linkStore.sealedCount()} onUnlock={unlockLinks} onForgot={() => { linkStore.forgetAll(); setLockOn(false); setLinks([]); toast('Saved links cleared. Choose a new passcode.'); }} />
                        : <LinksPanel onLock={lockOn ? lockLinks : null} links={links} onRevoke={async (id) => { const l = links.find(x => x.id === id); try { await revokeLink(id, l.ownerToken); setLinksRefresh(n => n + 1); toast('Link revoked. The encrypted data is deleted.'); } catch { toast('Could not revoke that link. Try again.'); } }} refreshKey={linksRefresh} onOpen={(l) => setRecipientOf({ id: l.id, keyStr: l.keyStr })} onNew={() => setView('share')} />
                  }</div>
                : <div key="files" className="step-back"><VaultFiles toast={toast} onShare={(f) => { setView('share'); setFile(f); setErr(''); window.scrollTo?.({ top: 0 }); }} /></div>)}
          </div>
        ) : (
          <div key="share" className="fade-in max-w-3xl mx-auto flex flex-col gap-7">
            <div>
              <h1 className="font-display text-[28px] sm:text-[36px] leading-[1.1]">Share something that burns</h1>
              <p className="text-mute text-[14px] mt-2">Paste text or drop files. It is encrypted in this tab before anything is sent.</p>
            </div>

            <div className="flex flex-col gap-4">
                <section className="min-w-0 rounded-2xl overflow-hidden border border-line" aria-label="Content"
                  style={{ background: 'var(--panel)' }}>
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line">
                    <span className="text-[12px] font-mono truncate min-w-0 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: kind === 'paste' ? colorOf(lang) : 'var(--cyan)' }} aria-hidden="true" />
                      <span className="text-mute">{kind === 'paste' ? 'untitled' + extOf(lang) : (filesLabel || 'no files yet')}</span>
                    </span>
                    {kind === 'paste' && (
                      <span className="flex items-center gap-2 shrink-0">
                        <label htmlFor="format" className="sr-only">Format</label>
                        <select id="format" value={lang} onChange={(e) => { setLang(e.target.value); setLangPicked(true); }} title="How your recipient sees it"
                          className="text-[12px] font-mono rounded-md border border-line bg-panel px-1.5 py-1 hover:border-mute outline-hidden" style={{ color: tint(colorOf(lang)) }}>
                          {FORMATS.map(f => <option key={f.id} value={f.id}>{f.id}</option>)}
                        </select>
                        <button id="add-files" onClick={() => fileInput.current.click()} className="press text-[12px] font-semibold rounded-md border border-line px-2.5 py-1 hover:border-mute">Add files</button>
                      </span>
                    )}
                  </div>

                  {kind === 'paste' ? (
                    <div className="relative flex bg-well min-h-[320px]"
                      >
                      <div className="select-none text-right font-mono text-[12.5px] leading-[1.7] text-mute/50 py-4 pl-3 pr-3 border-r border-line tabular" aria-hidden="true">
                        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
                      </div>
                      <label htmlFor="editor" className="sr-only">Text to encrypt</label>
                      <textarea id="editor" autoFocus={FINE_POINTER} spellCheck="false" value={text} onChange={(e) => setText(e.target.value)}
                        className="editor relative z-10 flex-1 min-w-0 bg-transparent resize-none outline-hidden font-mono text-[12.5px] leading-[1.7] py-4 px-4 text-fg whitespace-pre overflow-x-auto"
                        style={{ minHeight: `${Math.max(lines, 9) * 1.7 * 12.5 + 32}px` }} />
                      {!text && (
                        <div className="absolute inset-0 pointer-events-none grid place-items-center p-6 text-center">
                          <div className="flex flex-col items-center gap-3">
                            <div className="w-14 h-14 rounded-2xl grid place-items-center"
                              style={{ background: 'var(--ember)' }} aria-hidden="true">
                              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>
                              </svg>
                            </div>
                            <div className="font-display text-[20px] font-bold">Paste or type here</div>
                            <div className="text-mute text-[13px] max-w-xs">A password, a message, notes or code. Or drop files anywhere on this page, up to {limitLabel} in total.</div>
                            <div className="flex items-center gap-1.5 text-[11.5px] text-ok mt-1"><span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />Encrypted in this tab before anything is sent</div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 bg-well min-h-[320px] flex flex-col gap-3">
                      <div
                        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
                        onClick={() => fileInput.current.click()}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current.click()}
                        role="button" tabIndex={0} id="dropzone"
                        className={`${files.length ? 'flex-row py-4' : 'flex-1 flex-col p-6'} rounded-xl border-2 border-dashed flex items-center justify-center text-center gap-3 px-4 cursor-pointer transition-colors ${drag ? 'border-ember bg-[var(--ember-soft)]' : 'border-line hover:border-cyan'}`}>
                        <svg width={files.length ? 22 : 40} height={files.length ? 22 : 40} viewBox="0 0 24 24" fill="none" stroke={drag ? 'var(--ember)' : 'var(--cyan)'} strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                          <path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>
                        </svg>
                        {files.length
                          ? <div className="font-semibold text-[13.5px]">Add more files <span className="text-mute font-normal">· drop or click</span></div>
                          : <div>
                              <div className="font-semibold">Drop files here</div>
                              <div className="text-mute text-[12.5px] mt-1">or click to browse. Pick as many as you like.</div>
                            </div>}
                      </div>
                      {files.length > 0 && (
                        <>
                          <ul id="file-list" className="flex flex-col gap-1.5 max-h-[260px] overflow-y-auto">
                            {files.map((f, i) => {
                              const ts = TYPE_STYLE[typeOf(f.name, f.type)];
                              return (
                                <li key={f.name + f.size + f.lastModified} className="rise flex items-center gap-3 rounded-lg bg-panel border border-line px-3 py-2">
                                  <span className="w-9 h-9 rounded-lg grid place-items-center font-mono text-[10px] font-bold shrink-0" style={{ background: ts.c + '22', color: tint(ts.c), border: `1px solid ${ts.c}55` }} aria-hidden="true">{ts.t}</span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block font-mono text-[12.5px] truncate">{f.name}</span>
                                    <span className="block text-mute text-[11.5px] tabular">{fmtBytes(f.size)}</span>
                                  </span>
                                  <button onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`} className="press shrink-0 w-8 h-8 rounded-lg grid place-items-center text-mute hover:text-ember hover:bg-[var(--ember-soft)] transition-colors">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                          <div>
                            <div className="flex justify-between text-[11.5px] text-mute tabular mb-1.5">
                              <span id="files-total">{files.length} file{files.length === 1 ? '' : 's'} · {fmtBytes(filesSize)} of {limitLabel}</span>
                              <button id="remove-all" onClick={() => setFiles([])} className="hover:text-ember transition-colors">{text.trim() ? 'Remove all, back to text' : 'Remove all'}</button>
                            </div>
                            <div className="h-1.5 rounded-full bg-line overflow-hidden" aria-hidden="true">
                              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, filesSize / maxTotal * 100)}%`, background: filesSize / maxTotal > 0.9 ? 'var(--warn)' : 'var(--grad-cool)' }} />
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <div className="flex justify-between px-4 py-2 border-t border-line text-[11.5px] font-mono text-mute tabular">
                    <span>{kind === 'paste' ? `${lines} line${lines === 1 ? '' : 's'} · ${lang}` : `${files.length} file${files.length === 1 ? '' : 's'}`}</span>
                    <span>{bytes.toLocaleString('en-US')} B</span>
                  </div>
                </section>
                <input ref={fileInput} id="file" type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />

                {FEATURES.vaultFiles && kind === 'file' && (() => {
                  const own = vaultFiles.filter(v => !v.example);
                  return (
                    <div className="rounded-2xl border border-line bg-panel p-4">
                      <div className="flex items-center justify-between gap-3 mb-2.5">
                        <span className="label">Or pick from your vault</span>
                        <button onClick={() => setView('vault')} className="text-[12px] text-mute hover:text-ember">Open vault →</button>
                      </div>
                      {own.length === 0 ? (
                        <div className="text-[12.5px] text-mute">Nothing in your vault yet. Files you add there show up here, ready to send.</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {own.map(v => {
                            const ts = TYPE_STYLE[typeOf(v.name, v.mime)], picked = file && file.name === v.name;
                            return (
                              <button key={v.id} onClick={() => pickFromVault(v)}
                                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-mono max-w-full transition-colors ${picked ? 'border-ember bg-[var(--ember-soft)]' : 'border-line hover:border-mute'}`}>
                                <span className="text-[9px] font-bold shrink-0" style={{ color: tint(ts.c) }}>{ts.t}</span>
                                <span className="truncate min-w-0">{v.name}</span>
                                <span className="text-mute shrink-0">{fmtDec(v.size)}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="rounded-2xl border border-line bg-panel">
                  <button id="options-toggle" onClick={() => setOptsOpen(o => !o)} aria-expanded={optsOpen}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left">
                    <span className="label shrink-0">Options</span>
                    <span id="options-summary" className="text-[13px] truncate min-w-0 flex-1">{[(EXPIRY.find(o => o.id === expiry) || EXPIRY[0]).label, pwOn ? 'password' : 'no password', qrOnly && 'QR only', codeOn && '4-word code'].filter(Boolean).join(' · ')}</span>
                    <span className="text-[12.5px] text-mute shrink-0">{optsOpen ? 'Hide' : 'Change'}</span>
                  </button>
                  {optsOpen && <div className="rise flex flex-col gap-4 p-3 pt-0">
                <div className="tone-top rounded-2xl border border-line bg-panel p-4 sm:p-5" style={{ '--t1': 'var(--ember)', '--t2': 'var(--gold)' }}>
                  <div className="label mb-3">Expiration</div>
                  <div className={`grid gap-2 ${ownerOn ? 'grid-cols-2 sm:grid-cols-4' : 'sm:grid-cols-3'}`} role="radiogroup" aria-label="Expiration">
                    {EXPIRY.filter(o => !o.owner || ownerOn).map(o => (
                      <button key={o.id} id={`exp-${o.id}`} role="radio" aria-checked={expiry === o.id} onClick={() => setExpiry(o.id)} style={{ '--t1': EXPIRY_TONE[o.id] }}
                        className="press tone-opt flex items-start gap-3 text-left rounded-xl px-3 py-3 border transition-all duration-300">
                        <span className="tone-dot mt-1 w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-all duration-300" />
                        <span><span className="block text-[13.5px] font-semibold">{o.label}</span><span className="block text-[12px] text-mute">{o.sub}</span></span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="tone-top rounded-2xl border border-line bg-panel p-4 sm:p-5" style={{ '--t1': 'var(--pink)', '--t2': 'var(--violet)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-mute shrink-0" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>
                      <div>
                      <div className="text-[13.5px] font-semibold">Password + lockout</div>
                      <div className="text-[12px] text-mute">Wrong guesses destroy the link</div>
                      </div>
                    </div>
                    <Toggle id="pw-toggle" label="Password and lockout" on={pwOn} onChange={setPwOn} />
                  </div>
                  {pwOn && (
                    <div className="mt-4 rise grid sm:grid-cols-2 gap-4 items-start">
                      <div>
                        <label htmlFor="pw" className="sr-only">Decryption password</label>
                        <input id="pw" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Decryption password"
                          className="w-full bg-well border border-line rounded-lg px-3 py-2.5 font-mono text-[13px] outline-hidden focus:border-cyan" autoComplete="new-password" />
                        <div className="text-[11.5px] text-mute mt-1.5">Never stored. Lose it and the content is gone.</div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-3">
                        <span id="att-label" className="text-[12.5px]">Destroy after</span>
                        <div className="flex gap-1 p-0.5 rounded-lg bg-well border border-line" role="radiogroup" aria-labelledby="att-label">
                          {[1, 3, 5, 10].map(n => (
                            <button key={n} id={`att-${n}`} role="radio" aria-checked={maxAttempts === n} onClick={() => setMaxAttempts(n)}
                              className={`w-8 py-1 rounded-md font-mono text-[12px] tabular transition-colors ${maxAttempts === n ? 'fill-on on-fill font-semibold' : 'text-mute hover:text-fg'}`}>{n}</button>
                          ))}
                        </div>
                        <span className="text-[12.5px] text-mute">wrong tries</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="tone-top rounded-2xl border border-line bg-panel p-4 sm:p-5" style={{ '--t1': 'var(--cyan)', '--t2': 'var(--violet)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-mute shrink-0">{QR_ICON}</span>
                      <div>
                        <div className="text-[13.5px] font-semibold">QR code only</div>
                        <div className="text-[12px] text-mute">For handing a secret over in person. The link is shown only as a QR code, never as text, so it never lands in a chat or on a clipboard.</div>
                      </div>
                    </div>
                    <Toggle id="qr-only-toggle" label="QR code only" on={qrOnly} onChange={setQrOnly} />
                  </div>
                </div>

                <div className="tone-top rounded-2xl border border-line bg-panel p-4 sm:p-5" style={{ '--t1': 'var(--gold)', '--t2': 'var(--ok)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-gold shrink-0">{KEYBOARD_ICON}</span>
                      <div>
                        <div className="text-[13.5px] font-semibold">Typeable code</div>
                        <div className="text-[12px] text-mute">Also get 4 words that open this link, for a computer that cannot scan the QR code. Type them at {location.host}/code.</div>
                      </div>
                    </div>
                    <Toggle id="code-toggle" label="Typeable code" on={codeOn} onChange={setCodeOn} />
                  </div>
                  {codeOn && (
                    <div className="rise mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px]">
                      A code is shorter than a link, so it is easier to guess. It is fine for quick hand-offs between your own devices.
                      {pwOn ? ' Your password adds the missing strength.' : ' For anything very sensitive, add a password too.'}
                    </div>
                  )}
                </div>

                  </div>}
                </div>

                {err && <div className="rounded-xl border border-warn/50 bg-warn/10 text-warn text-[12.5px] px-3 py-2.5" role="alert">{err}</div>}

                <button id="create" onClick={() => create()} disabled={busy}
                  className={`press rounded-xl py-3.5 px-5 font-display font-bold text-[17px] transition flex items-center justify-center gap-2 ${hasContent ? 'btn-burn ember-glow hover:brightness-110' : 'bg-panel text-mute border border-line'} ${busy ? 'shimmer' : ''}`}>
                  {busy ? <><span className="w-4 h-4 rounded-full border-2 border-[#111317] border-t-transparent animate-spin" />{progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Encrypting…'}</> : 'Create link'}
                </button>
                {!qrOnly && hasContent && <TouchSend peersVersion={peersVersion} disabled={busy} onSend={(p) => create(p, { touch: true })} />}
                {!qrOnly && <DeviceRow peersVersion={peersVersion} onPair={() => setPairOpen(true)} onSend={(p) => create(p)} sendingTo={sendingTo} disabled={busy} />}
                <p className="text-[12.5px] text-mute text-center">
                  <a id="have-code" href="/code" className="text-fg underline underline-offset-2 hover:text-ember">Got a 4-word code?</a>
                  {' · '}<button onClick={() => setView('how')} className="text-fg underline underline-offset-2 hover:text-ember">How does this work?</button>
                </p>
              </div>

            {dragPage && (
              <div className="fixed inset-0 z-[60] pointer-events-none grid place-items-center bg-ink/70 backdrop-blur-[2px]">
                <div className="rounded-2xl border-2 border-dashed border-ember px-8 py-6 font-display text-xl">Drop to add files</div>
              </div>
            )}

            <div className="flex items-center justify-center gap-2 text-[12px] text-mute">
              Encrypted in this tab with AES-256-GCM before anything is sent.
            </div>
            <HomeInfo onHow={() => setView('how')} />
          </div>
        )}
      </main>
      <Footer className="gutter pb-8 pt-2" />

      {result && <OutputModal result={result} onPair={() => setPairOpen(true)}
        onClose={() => { setResult(null); startOver(); }}
        onOpenRecipient={() => { setRecipientOf({ id: result.id, keyStr: result.keyStr }); setResult(null); startOver(); }} />}
      {pairOpen && <PairModal onClose={() => setPairOpen(false)} onPaired={() => setPeersVersion(v => v + 1)} />}
      {touchTarget && !recipientOf && <TouchTarget name={touchTarget.fromName} onClose={() => setTouchTarget(null)} />}
      {arrival && !recipientOf && <ArrivalCard item={arrival.item} more={arrival.more} onOpen={() => openInboxItem(arrival.item)} onLater={() => setArrival(null)} />}
      {recipientOf && <RecipientPage key={recipientOf.id} id={recipientOf.id} keyStr={recipientOf.keyStr} onExit={() => setRecipientOf(null)} />}
      {passModal && <PasscodeModal mode={passModal.mode} needCurrent={passModal.needCurrent} onSubmit={submitPassModal} onClose={() => setPassModal(null)} />}
      {showRecovery && <RecoveryModal keyStr={recoveryKey} saved={recoverySaved} onClose={() => setShowRecovery(false)}
        onConfirm={() => { setRecoverySaved(true); setShowRecovery(false); toast('Recovery key saved. Keep it somewhere safe.'); }} />}
      {pro && <ProModal initialGb={pro.gb} reason={pro.reason} onClose={() => setPro(null)}
        onSubscribe={({ gb, billing, price }) => { setPlan({ tier: 'pro', gb, billing, price }); setSignedIn(true); setPro(null); toast(`You're on Pro with ${gb} GB. Cancel anytime in Settings.`); }} />}
      {appToast && (
        <div className="fixed z-[70] inset-x-0 flex justify-center gutter pointer-events-none" style={{ bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))' }}>
          <div key={appToast} className="pop rounded-xl border border-line bg-panel px-4 py-2.5 text-[13px] shadow-2xl flex items-center gap-2" role="status">
            <span className="w-2 h-2 rounded-full bg-ok shrink-0" aria-hidden="true" />{appToast}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
