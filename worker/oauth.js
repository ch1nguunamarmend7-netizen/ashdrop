// Sign in with Google (and Apple, once configured).
//
// The standard OpenID Connect "authorization code" flow, run by this Worker, so no Google or Apple
// script is ever loaded on the page:
//   1. The browser asks us to prepare (POST /api/oauth/google/prepare). We make a one-time `state`,
//      a `nonce` and a PKCE secret, remember them for 10 minutes, and send back the Google URL.
//   2. Google sends the person back to /api/oauth/google/callback with a code. We swap the code for an
//      ID token directly with Google (server to server, with our client secret), check who it is for,
//      who issued it, its nonce and expiry, and that the email is verified.
//   3. We redirect to /vault#oauth=<ticket>&state=<state>. The browser checks `state` is the one it
//      started with (so nobody can log you into their account) and swaps the ticket for the result.
// Signing in this way proves who you are. It does not unlock the vault: that still needs a passkey,
// the vault PIN or the recovery key, because Google and Apple must never hold the key.

import { json, b64urlToBytes, bytesToB64url } from './link.js';
import { call, userStub, indexStub, sha, rand, okPin, normEmail, DEFAULT_QUOTA, MAX_QUOTA } from './vault.js';

const B64 = /^[A-Za-z0-9_-]+$/;
const isB64 = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && B64.test(v);
const bearer = (request) => {
  const m = (request.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/);
  return m ? { uid: m[1], token: m[2] } : null;
};

function providers(env) {
  return {
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
      clientId: env.GOOGLE_CLIENT_ID, scope: 'openid email', pkce: true,
      secret: async () => env.GOOGLE_CLIENT_SECRET, extra: { prompt: 'select_account' },
    } : null,
    // Apple needs a paid Apple Developer account. It switches on when these four settings exist.
    apple: env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY ? {
      authUrl: env.APPLE_AUTH_URL || 'https://appleid.apple.com/auth/authorize',
      tokenUrl: env.APPLE_TOKEN_URL || 'https://appleid.apple.com/auth/token',
      issuers: ['https://appleid.apple.com'],
      clientId: env.APPLE_CLIENT_ID, scope: 'email', pkce: false,
      secret: () => appleClientSecret(env), extra: { response_mode: 'form_post' },
    } : null,
  };
}

const redirectUri = (url, p) => `${url.origin}/api/oauth/${p}/callback`;
const back = (url, hash) => new Response(null, { status: 302, headers: { location: `${url.origin}/vault#${hash}`, 'cache-control': 'no-store' } });

export async function handleOAuth(request, env, url, parts, { allowed, isSiteOwner }) {
  const [, , p, step] = parts; // ['api','oauth', provider|'providers'|'exchange'|'signup', step]
  if (p === 'providers') { const all = providers(env); return json({ google: !!all.google, apple: !!all.apple }); }
  if (p === 'exchange' && request.method === 'POST') return exchange(request, env);
  if (p === 'signup' && request.method === 'POST') return signup(request, env, { allowed, isSiteOwner });
  const cfg = providers(env)[p];
  if (!cfg) return json({ error: 'not_enabled' }, 404);

  if (step === 'prepare' && request.method === 'POST') {
    if (!(await allowed(env.CODE_LIMITER || env.OPEN_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
    const b = await request.json().catch(() => ({}));
    const mode = b.mode === 'link' ? 'link' : 'signin';
    let linkUid = null;
    if (mode === 'link') { // connecting Google/Apple to the account you are signed in to
      const who = bearer(request);
      if (!who || (await call(userStub(env, who.uid), 'auth', { token: who.token })).status !== 200) return json({ error: 'signed_out' }, 401);
      linkUid = who.uid;
    }
    const state = rand(24), nonce = rand(24), verifier = rand(48);
    await call(indexStub(env, 'oauth:' + state), 'index-claim', { value: { p, mode, linkUid, nonce, verifier, exp: Date.now() + 10 * 60e3 } });
    const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri(url, p), response_type: 'code', scope: cfg.scope, state, nonce, ...cfg.extra });
    if (cfg.pkce) { q.set('code_challenge', bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))); q.set('code_challenge_method', 'S256'); }
    return json({ url: `${cfg.authUrl}?${q}`, state });
  }

  if (step === 'callback' && (request.method === 'GET' || request.method === 'POST')) {
    const form = request.method === 'POST' ? Object.fromEntries(await request.formData().catch(() => new Map())) : Object.fromEntries(url.searchParams);
    if (form.error) return back(url, 'oauth_error=' + encodeURIComponent(form.error === 'access_denied' ? 'cancelled' : 'provider'));
    if (!isB64(form.state || '', 32, 32) || typeof form.code !== 'string' || form.code.length > 2000) return back(url, 'oauth_error=bad_request');
    const st = await call(indexStub(env, 'oauth:' + form.state), 'index-take');
    if (st.status !== 200 || st.data.p !== p) return back(url, 'oauth_error=expired');
    // Swap the code for tokens, directly with the provider.
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: form.code, redirect_uri: redirectUri(url, p), client_id: cfg.clientId, client_secret: await cfg.secret() });
    if (cfg.pkce) body.set('code_verifier', st.data.verifier);
    let tok;
    try {
      const r = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      tok = await r.json();
      if (!r.ok || !tok.id_token) throw new Error('token');
    } catch { return back(url, 'oauth_error=provider'); }
    // The ID token came straight from the provider over TLS in answer to our own request, so its issuer is
    // already proven (OpenID Connect Core 3.1.3.7); we still check every claim that matters.
    let c;
    try { c = JSON.parse(new TextDecoder().decode(b64urlToBytes(tok.id_token.split('.')[1]))); } catch { return back(url, 'oauth_error=provider'); }
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!cfg.issuers.includes(c.iss) || !aud.includes(cfg.clientId) || c.nonce !== st.data.nonce || !(c.exp * 1000 > Date.now()) || typeof c.sub !== 'string') return back(url, 'oauth_error=bad_token');
    const verified = c.email_verified === true || c.email_verified === 'true';
    if (!c.email || !verified) return back(url, 'oauth_error=no_email');
    const result = { p, mode: st.data.mode, linkUid: st.data.linkUid, subHash: await sha(`${p}:${c.sub}`), email: normEmail(c.email) };
    const ticket = rand(24);
    await call(indexStub(env, 'ticket:' + ticket), 'index-claim', { value: { ...result, exp: Date.now() + 3 * 60e3 } });
    return back(url, `oauth=${ticket}&state=${form.state}`);
  }
  return json({ error: 'not_found' }, 404);
}

// POST /api/oauth/exchange { ticket } → signed in, linked, or "new account needed"
async function exchange(request, env) {
  const b = await request.json().catch(() => ({}));
  if (!isB64(b.ticket || '', 32, 32)) return json({ error: 'bad_ticket' }, 400);
  const t = await call(indexStub(env, 'ticket:' + b.ticket), 'index-take');
  if (t.status !== 200) return json({ error: 'expired' }, 410);
  const { p, mode, linkUid, subHash, email } = t.data;
  const label = (request.headers.get('user-agent') || '').slice(0, 60);
  const idName = `oidc:${p}:${subHash}`;
  const known = await call(indexStub(env, idName), 'index-get');

  if (mode === 'link') {
    // Only the same signed-in account that started the link may finish it.
    const who = bearer(request);
    if (!who || who.uid !== linkUid) return json({ error: 'signed_out' }, 401);
    if (known.status === 200 && known.data.uid !== linkUid) return json({ error: 'identity_in_use' }, 409);
    const r = await call(userStub(env, linkUid), 'identity-add', { token: who.token, identity: { provider: p, subHash, email } });
    if (r.status !== 200) return json(r.data, r.status);
    if (known.status !== 200) await call(indexStub(env, idName), 'index-claim', { value: { uid: linkUid } });
    return json({ status: 'linked', provider: p, account: r.data });
  }
  if (known.status === 200) {
    const r = await call(userStub(env, known.data.uid), 'identity-login', { provider: p, subHash, label });
    return r.status === 200 ? json({ status: 'signedin', ...r.data }) : json({ error: 'wrong' }, 401);
  }
  // A new person. If the email already has an account, they must sign in to it and connect Google there:
  // linking automatically would let anyone who controls an email at a provider take over the account.
  const byEmail = await call(indexStub(env, 'email:' + (await sha(email))), 'index-get');
  if (byEmail.status === 200) return json({ error: 'email_has_account', email }, 409);
  const signupTicket = rand(24);
  await call(indexStub(env, 'signup:' + signupTicket), 'index-claim', { value: { p, subHash, email, exp: Date.now() + 30 * 60e3 } });
  return json({ status: 'new', signupTicket, email, provider: p });
}

// POST /api/oauth/signup { signupTicket, invite?, recoveryAuth, recoveryWrapped, pin }
async function signup(request, env, { allowed, isSiteOwner }) {
  if (!(await allowed(env.CODE_LIMITER || env.OPEN_LIMITER, request))) return json({ error: 'rate_limited' }, 429);
  const b = await request.json().catch(() => ({}));
  if (!isB64(b.signupTicket || '', 32, 32) || !isB64(b.recoveryAuth || '', 43, 43) || !isB64(b.recoveryWrapped || '', 40, 200) || !okPin(b.pin)) return json({ error: 'bad_keys' }, 400);
  const t = await call(indexStub(env, 'signup:' + b.signupTicket), 'index-get');
  if (t.status !== 200) return json({ error: 'expired' }, 410);
  const { p, subHash, email } = t.data;
  const owner = await isSiteOwner(request, env);
  let quota = DEFAULT_QUOTA, inviteName = null;
  if (!owner) {
    if (typeof b.invite !== 'string' || b.invite.length > 64) return json({ error: 'bad_invite' }, 400);
    inviteName = 'invite:' + (await sha(b.invite.trim().toUpperCase()));
    const inv = await call(indexStub(env, inviteName), 'index-get');
    if (inv.status !== 200) return json({ error: 'bad_invite' }, 403);
    quota = inv.data.quota || DEFAULT_QUOTA;
  } else quota = MAX_QUOTA;
  const uid = rand(12);
  const claimEmail = await call(indexStub(env, 'email:' + (await sha(email))), 'index-claim', { value: { uid } });
  if (claimEmail.status === 409) return json({ error: 'email_has_account', email }, 409);
  await call(indexStub(env, `oidc:${p}:${subHash}`), 'index-claim', { value: { uid } });
  await call(indexStub(env, 'signup:' + b.signupTicket), 'index-take');
  if (inviteName) await call(indexStub(env, inviteName), 'index-take');
  const label = (request.headers.get('user-agent') || '').slice(0, 60);
  const r = await call(userStub(env, uid), 'create', { uid, email, recoveryAuth: b.recoveryAuth, recoveryWrapped: b.recoveryWrapped, pin: b.pin, identity: { provider: p, subHash, email }, quota, owner, label });
  return json(r.data, r.status === 200 ? 201 : r.status);
}

/* Apple's "client secret" is a short-lived JWT signed with your Apple key (ES256). */
async function appleClientSecret(env) {
  const pem = String(env.APPLE_PRIVATE_KEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'ES256', kid: env.APPLE_KEY_ID });
  const claims = enc({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${claims}`)));
  return `${head}.${claims}.${bytesToB64url(sig)}`;
}
