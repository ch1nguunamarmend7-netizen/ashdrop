# Ashdrop

Share secrets that burn after reading. Everything is encrypted in the browser with AES-256-GCM;
the key travels in the link's `#fragment`, which browsers never send to a server.

**Live:** https://ashdrop.cc · **Code:** https://github.com/ch1nguunamarmend7-netizen/ashdrop · **License:** MIT · **Security reports:** see [SECURITY.md](SECURITY.md)

Ashdrop is open source so anyone can check that it does what it says. It is new and has not been
independently audited yet; reviews and reports are very welcome.

This repo is one Cloudflare Worker that serves the website **and** the API:

```
index.html, src/        React + Tailwind frontend (Vite)
  src/lib/crypto.js     all encryption and decryption (browser only)
  src/lib/api.js        talks to /api/p
  src/lib/linkStore.js  My links on the sender's device, encrypted with a passcode
  src/Legal.jsx         Terms, Privacy, Contact pages and the footer
  src/site.js           operator name, country, emails and the source-code link used on those pages
  src/main.jsx          routes /p/:id, /terms, /privacy, /contact; everything else to the app
worker/index.js         API routes, security headers, serves dist/
worker/link.js          one Durable Object per link: attempt counter, burn, expiry
test/                   API tests that run in plain Node
scripts/postbuild.mjs   integrity hashes + build.json after every build
scripts/verify.mjs      compares a live site with build.json and with your own build
.github/workflows/      deploy (with signed build attestation) and the hourly live check
wrangler.toml           Cloudflare config (R2 bucket, Durable Object, static assets)
```

## What works for real

- **Burn links and timed links** (1 view, 1 hour, 24 hours), text or files up to 25 MB.
- **Password + lockout.** The password derives two keys: one encrypts, the other proves knowledge
  to the server. The server stores only a SHA-256 of that proof and releases nothing until it
  matches. Wrong tries count down; the last one deletes the data.
- **Atomic.** Each link is its own Durable Object, handling one request at a time. A burn link
  cannot be opened twice, and parallel guesses cannot skip the counter.
- **File names, types and text format are encrypted** inside the payload. The server sees a size.
- **My links**: live status (waiting, opened, burned, locked out, revoked, expired) and revoke,
  using a secret owner token kept on the sender's device.
- **Expiry**: an alarm deletes the ciphertext when a link expires, even if nobody opens it.
- **Recipient page** at `/p/:id`: reveal button (so chat link previews cannot burn it), reads the
  key from the fragment and removes it from the address bar and history.
- **Security headers** on every response: strict CSP (`script-src 'self'`, no third-party
  anything), `Referrer-Policy: no-referrer`, HSTS, `X-Frame-Options: DENY`.
- **Rate limits** per IP: 20 new links and 60 open attempts per minute (`wrangler.toml`).
- **Abuse removal**: an admin endpoint deletes any reported link without needing its key.
- **Link previews**: shared links show an Ashdrop card; secret links preview as "Someone sent you
  a secret" and reveal nothing.
- **Logs**: Cloudflare Workers Logs (method, path, status, errors) for debugging.

## Hidden until they are real

`FEATURES` at the top of `src/App.jsx` switches off everything that is designed but not built on
the server yet: `pro` (plans, upgrade prompts, subscription settings), `accounts` (sign in/out),
`recovery` (the vault recovery key) and `vaultFiles` (storing files in the vault, which today only
live in the browser tab). With `vaultFiles` off, the Vault tab is just **My links**.
Turn each one on only when its backend exists.

The app ships with no sample data: the vault and the folder list start empty.

## Still a local stand-in (next steps)

| Area | Now | To build |
|---|---|---|
| Vault | Files are encrypted but kept in the browser tab | Store vault ciphertext in R2 per account, with keys derived from the password |
| Sign in / sign out | A toggle | An auth service (passkeys or email + password with an SRP/OPAQUE-style login) |
| Recovery key | Generated and shown, not yet tied to a vault key | Wrap the vault key with it at sign-up |
| Pro plan and cancel | A toggle | Stripe Checkout + Customer Portal, webhook updates the plan |

## Verify that the live site runs this code

Every build writes `dist/build.json` (the commit plus a SHA-256 of every file) and adds integrity
hashes to `index.html`, so browsers refuse any script or stylesheet that was changed. Pages are served
byte-for-byte as built; the Worker never rewrites them.

**Check it yourself** (needs Node 20+ and Git):

```bash
git clone https://github.com/ch1nguunamarmend7-netizen/ashdrop && cd ashdrop
npm run verify -- https://ashdrop.cc        # step 1, and prints the commit the site runs
git checkout <that commit>
npm ci && npm run build
npm run verify -- https://ashdrop.cc        # step 2: compares every live file with your own build
```

**Check the signature** that GitHub made when it built the files (needs the GitHub CLI):

```bash
curl -sL https://ashdrop.cc/ -o index.html
gh attestation verify index.html -R ch1nguunamarmend7-netizen/ashdrop
```

**Hourly public check:** `.github/workflows/verify-live.yml` rebuilds the commit the site reports and
compares every file. Its results are public on the repository's Actions tab.

What this cannot prove: a check run from one place shows what the site serves to everyone, not what a
single visitor was sent at one moment. Closing that gap needs a browser extension that checks every page load.

## Deploying (GitHub Actions)

Production deploys run from `.github/workflows/deploy.yml` on every push to `main`: tests, build,
signed attestation, then `wrangler deploy`. Do not deploy from a laptop, or the hourly check turns red.

One-time setup:

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → use the **Edit Cloudflare
   Workers** template, limited to your account. If a deploy fails with a permission error about R2 or
   Durable Objects, edit the token and add that permission.
2. Copy your **Account ID** (Workers & Pages overview page, right side).
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Push to `main` (or run the workflow from the Actions tab). The `ADMIN_TOKEN` secret you set with
   wrangler stays on the Worker across deploys.

In the Cloudflare zone settings, keep **Rocket Loader** and **Email Address Obfuscation** off: they
rewrite pages, which would break the integrity hashes and the byte-for-byte check.

## Run it locally

Needs Node 20 or newer.

```bash
npm install
npm test                 # API tests, no Cloudflare account needed
npm run dev:worker       # builds the site and runs the Worker locally on http://127.0.0.1:8787
```

`wrangler dev` simulates R2 and Durable Objects on your machine, so links work end to end.
For fast UI work, run `npm run dev` (Vite on :5173) in a second terminal; it forwards `/api` to the Worker.

## Deploy to Cloudflare

1. Create a free Cloudflare account, then log in from the project folder:
   ```bash
   npx wrangler login
   ```
2. Create the storage bucket once:
   ```bash
   npx wrangler r2 bucket create ashdrop-blobs
   ```
3. Deploy (builds the site, uploads the Worker, creates the Durable Object):
   ```bash
   npm run deploy
   ```
   You get a `https://ashdrop.<your-subdomain>.workers.dev` address. Try a link there first.
4. Durable Objects and R2 need the Workers Paid plan ($5/month) once you go past the free
   allowances; check the current limits in the Cloudflare dashboard.

### Use your domain (ashdrop.cc)

1. Add the domain to Cloudflare (Websites → Add a site) and switch its nameservers at your
   registrar to the two Cloudflare gives you.
2. In the Worker's **Settings → Domains & Routes**, add `ashdrop.cc` as a Custom Domain.
   Cloudflare issues the HTTPS certificate.
3. Once it works over HTTPS, submit the domain at hstspreload.org (the Worker already sends the header).

### Rate limiting and logs

Already configured in `wrangler.toml` (needs Wrangler 4.36 or newer): 20 new links and 60 open
attempts per IP per minute, plus Workers Logs. Change the numbers there if real users hit them.

### Removing a reported link

1. Once, set an admin token (any long random string, 32+ characters; keep it in a password manager):
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```
2. To remove a link, use the 10 characters after `/p/` in the reported link. In PowerShell:
   ```powershell
   Invoke-RestMethod -Method Delete -Uri "https://ashdrop.cc/api/admin/p/LINKID" -Headers @{ Authorization = "Bearer YOUR_ADMIN_TOKEN" }
   ```
   The answer is `state: removed`. The encrypted data is deleted; nobody needed the key.

## Launch checklist

- [x] `src/site.js`: `operator` and `country` are filled in.
- [x] Source code published at https://github.com/ch1nguunamarmend7-netizen/ashdrop
- [ ] Have the Terms and Privacy text reviewed by someone qualified for your country.
- [ ] Check the contact email in `src/site.js` is right and that you can receive mail there.
- [ ] `npx wrangler secret put ADMIN_TOKEN`
- [ ] `npm audit`, update what it flags, then `npm test` and `npm run dev:worker` again.
- [ ] Add the two GitHub secrets (see "Deploying"), push, and check the Actions tab is green.
- [ ] Add the custom domain, and test from two phones on the real address.
- [ ] Paste a link into a chat app and check the preview card shows (and the link still works after).

## Security rules for anyone changing this code

1. **Never add third-party scripts** (analytics, chat widgets, tag managers, CDNs). Any script on
   the page can read `location.hash`, which is the key. The CSP blocks them; keep it that way.
2. **Keep everything self-hosted.** Fonts come from `@fontsource`, the QR code from
   `qrcode-generator`, both bundled by Vite.
3. **The server must never see the key, the password, or file names.** If you add a field to the
   upload, ask whether it leaks something; put it inside the encrypted header in `pack()` instead.
4. **Do not log request bodies or the `x-ashdrop-meta` header** in the Worker.
5. Links in **My links** are stored in the sender's `localStorage` (they contain the key and owner
   token, so the sender can copy and revoke them). They are dropped after 8 days.

## How a link is made

```
browser:  content ──pack(name,type)──▶ AES-256-GCM (random key K) ──▶ [password layer?] ──▶ ciphertext
browser:  POST /api/p  body=ciphertext  meta={iv, salt, iv2, authToken, expiry, maxAttempts}
worker:   R2.put(p/<id>), Durable Object stores sha256(authToken), counter, expiry
link:     https://ashdrop.cc/p/<id>#<K>          ← K never leaves browsers
```

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a pull request, and read the
security rules above: no third-party scripts, nothing that lets the server see keys, passwords or
file names. Report security problems privately (see [SECURITY.md](SECURITY.md)), not in public issues.
