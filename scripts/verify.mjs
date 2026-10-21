// Check that a live Ashdrop site is serving exactly the code in this repository.
//
//   npm run verify -- https://ashdrop.cc
//
// Step 1 downloads the site's build.json and every file it lists, and checks each one.
// Step 2 (the one that matters) compares the live files with YOUR OWN build of the same commit:
//   git checkout <commit printed by step 1>
//   npm ci && npm run build
//   npm run verify -- https://ashdrop.cc
// If every file matches, the site is running this public code and nothing else.
//
// Exit code 0 = everything matches, 1 = a mismatch, 2 = could not check.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const site = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(site)) {
  console.error('Usage: npm run verify -- https://ashdrop.cc');
  process.exit(2);
}
const sha256 = (buf) => 'sha256-' + createHash('sha256').update(buf).digest('base64');
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

// Cloudflare serves index.html at "/" (and redirects /index.html there), so ask for "/".
const urlFor = (p) => (p === '/index.html' ? '/' : p);

async function get(p) {
  const res = await fetch(site + urlFor(p), { cache: 'no-store', redirect: 'manual' });
  if (!res.ok) throw new Error(`${p} answered HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let live;
try { live = JSON.parse((await get('/build.json')).toString('utf8')); }
catch (e) { console.error(`Could not read ${site}/build.json: ${e.message}`); process.exit(2); }

console.log(`\n${site} says it is running commit ${live.commit}${live.dirty ? ' WITH UNCOMMITTED CHANGES' : ''}`);
let failures = 0;

// Step 1: the live files match the live manifest.
console.log('\nStep 1: live files match the live manifest');
const fetched = {};
for (const [p, want] of Object.entries(live.files)) {
  try {
    fetched[p] = sha256(await get(p));
    if (fetched[p] === want) ok(p); else { bad(`${p} does not match its own manifest`); failures++; }
  } catch (e) { bad(`${p}: ${e.message}`); failures++; }
}
// The pages people actually open are served from index.html too; they must be byte-identical.
for (const page of ['/', '/p/verifycheck', '/security']) {
  try {
    const h = sha256(await get(page));
    if (h === live.files['/index.html']) ok(`${page} is exactly index.html`); else { bad(`${page} differs from index.html`); failures++; }
  } catch (e) { bad(`${page}: ${e.message}`); failures++; }
}

// Step 2: the live files match a build you made yourself.
console.log('\nStep 2: live files match your own build (dist/build.json)');
const localPath = path.resolve('dist', 'build.json');
if (!fs.existsSync(localPath)) {
  console.log('  - skipped: no local build. Run: git checkout ' + live.commit + ' && npm ci && npm run build');
} else {
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  if (local.commit !== live.commit) {
    console.log(`  - your build is from commit ${local.commit.slice(0, 7)}, the site runs ${live.commit.slice(0, 7)}.`);
    console.log(`    Run: git checkout ${live.commit} && npm ci && npm run build, then verify again.`);
    failures++;
  } else if (local.dirty) {
    console.log('  - your build has uncommitted changes, so it cannot match. Commit or discard them and rebuild.');
    failures++;
  } else {
    const names = new Set([...Object.keys(local.files), ...Object.keys(live.files)]);
    for (const p of [...names].sort()) {
      if (!(p in live.files)) { bad(`${p} is in your build but not on the site`); failures++; }
      else if (!(p in local.files)) { bad(`${p} is on the site but not in your build`); failures++; }
      else if (local.files[p] !== (fetched[p] || live.files[p])) { bad(`${p} differs from your build`); failures++; }
      else ok(p);
    }
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nEverything matches.');
process.exit(failures ? 1 : 0);
