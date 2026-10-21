// Runs after `vite build`. Two jobs, both so that anyone can check the live site:
//
// 1. Subresource Integrity: every script and stylesheet tag in index.html gets an integrity hash,
//    so the browser refuses any JS or CSS file that differs from what index.html expects.
//    That pins all the code to a single file: index.html.
// 2. dist/build.json: the commit this was built from and a SHA-256 of every file in dist/.
//    scripts/verify.mjs compares the live site against it, and against your own build.
//
// The output only depends on the source and package-lock.json, so building the same commit
// gives the same bytes: that is what makes the comparison meaningful.

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.argv[2] || 'dist');
const sha = (buf, alg) => createHash(alg).update(buf).digest('base64');

// 1. SRI on <script src> and <link rel="stylesheet|modulepreload" href> that point at our own files.
const indexPath = path.join(DIST, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
let tagged = 0;
html = html.replace(/<(script|link)\b([^>]*?)\s(src|href)="(\/[^"]+\.(?:js|css))"([^>]*)>/g, (tag, name, before, attr, url, after) => {
  if (/\bintegrity=/.test(tag)) return tag;
  if (name === 'link' && !/rel="(stylesheet|modulepreload)"/.test(before + after)) return tag;
  const file = path.join(DIST, url);
  if (!fs.existsSync(file)) throw new Error(`index.html points at ${url}, which is not in dist/`);
  tagged++;
  const cors = /\bcrossorigin\b/.test(tag) ? '' : ' crossorigin';
  return `<${name}${before} ${attr}="${url}" integrity="sha384-${sha(fs.readFileSync(file), 'sha384')}"${cors}${after}>`;
});
if (!tagged) throw new Error('No script or stylesheet tags found in dist/index.html');
fs.writeFileSync(indexPath, html);

// 2. Manifest of every file, sorted so the JSON is stable.
const files = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else {
      const rel = '/' + path.relative(DIST, full).split(path.sep).join('/');
      if (rel !== '/build.json') files[rel] = 'sha256-' + sha(fs.readFileSync(full), 'sha256');
    }
  }
})(DIST);

let commit = process.env.GITHUB_SHA || '';
if (!commit) { try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {} }
let dirty = false;
if (!process.env.GITHUB_SHA) {
  // A build with uncommitted changes cannot match any published commit; say so in the manifest.
  try { dirty = execSync('git status --porcelain -- src worker index.html public package.json package-lock.json vite.config.js', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== ''; } catch {}
}

const manifest = { version: 1, commit: commit || 'unknown', dirty, files };
fs.writeFileSync(path.join(DIST, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`postbuild: integrity added to ${tagged} tag(s); build.json lists ${Object.keys(files).length} files for commit ${manifest.commit.slice(0, 7)}${dirty ? ' (uncommitted changes)' : ''}`);
