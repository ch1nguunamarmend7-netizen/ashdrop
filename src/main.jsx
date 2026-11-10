import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/martian-mono/400.css';
import '@fontsource/martian-mono/500.css';
import './styles.css';
import App, { RecipientPage, CodePage, PairPage } from './App.jsx';
import { LegalPage } from './Legal.jsx';
import { TouchLab } from './TouchLab.jsx';

// Apply the saved theme before first paint so the recipient page matches too.
try {
  const saved = JSON.parse(localStorage.getItem('ashdrop.settings') || '{}');
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = !saved.theme || saved.theme === 'dark' ? 'dark' : saved.theme === 'light' ? 'light' : dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-ash', theme);
  // Pages outside the app (recipient, Terms...) follow Performance mode and motion settings too.
  if (saved.perf) document.documentElement.setAttribute('data-perf', 'on');
  if (saved.perf || saved.speed === 0) document.documentElement.setAttribute('data-motion', 'off');
  if (saved.speed) document.documentElement.style.setProperty('--spd', String(saved.speed));
} catch {}

// iPhone zooms in when you tap a small text field and never zooms back out when the keyboard closes.
// Capping the zoom at 1 stops that automatic zoom. On iPhone and iPad this does NOT block zooming
// yourself (iOS ignores the cap for pinch-to-zoom), so it is only set there; Android keeps the plain tag.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
if (IOS) {
  const meta = document.querySelector('meta[name=viewport]');
  if (meta && !/maximum-scale/.test(meta.content)) meta.setAttribute('content', meta.content + ', maximum-scale=1');
}

const root = createRoot(document.getElementById('root'));
const match = location.pathname.match(/^\/p\/([a-z2-9]{10})\/?$/);
const legal = location.pathname.match(/^\/(terms|privacy|security|contact)\/?$/);

if (legal) {
  root.render(<LegalPage page={legal[1]} />);
} else if (/^\/lab\/touch\/?$/.test(location.pathname)) {
  root.render(<TouchLab />);
} else if (/^\/code\/?$/.test(location.pathname)) {
  root.render(<CodePage />);
} else if (/^\/pair\/?$/.test(location.pathname)) {
  // The pairing words may arrive in the fragment (from the QR code). Take them out of the address bar.
  const words = decodeURIComponent(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);
  root.render(<PairPage initialWords={words} />);
} else if (match) {
  // Read the key from the fragment, then remove it from the address bar and history,
  // so it is not left behind in the browser's history or a screenshot of the URL bar.
  // sessionStorage keeps it for this tab only, so a reload still works.
  const id = match[1];
  let key = decodeURIComponent(location.hash.slice(1));
  try {
    if (key) sessionStorage.setItem(`ashdrop.k.${id}`, key);
    else key = sessionStorage.getItem(`ashdrop.k.${id}`) || '';
  } catch {}
  if (location.hash) history.replaceState(null, '', location.pathname);
  root.render(<RecipientPage id={id} keyStr={key} standalone onExit={() => location.assign('/')} />);
} else {
  root.render(<App />);
}
