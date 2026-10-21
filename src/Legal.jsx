// Terms, Privacy and Contact pages, and the footer that links to them.
// The privacy text describes what worker/ and src/lib/ actually store. If you change what is
// stored or logged, change this text in the same commit.
import React, { useState, useEffect } from 'react';
import { Logo } from './App.jsx';
import { SITE, LEGAL_IS_DRAFT } from './site.js';

// Many computers have no mail app set up, so mailto: links silently do nothing.
// Gmail's compose page works in any browser.
export const gmailCompose = (to, subject = '') =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}${subject ? `&su=${encodeURIComponent(subject)}` : ''}`;

const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const who = () => SITE.operator || 'the operator of Ashdrop';

export function Footer({ className = '' }) {
  return (
    <footer className={`text-[12px] text-mute flex flex-wrap items-center justify-center gap-x-4 gap-y-1 ${className}`}>
      <span>© {new Date().getFullYear()} {SITE.name}</span>
      <a href="/terms" className="hover:text-fg underline-offset-2 hover:underline">Terms</a>
      <a href="/privacy" className="hover:text-fg underline-offset-2 hover:underline">Privacy</a>
      <a href="/contact" className="hover:text-fg underline-offset-2 hover:underline">Contact</a>
      <a href="/contact#abuse" className="hover:text-fg underline-offset-2 hover:underline">Report abuse</a>
      <a href="/contact#ideas" className="text-ember hover:underline underline-offset-2">Send us ideas</a>
    </footer>
  );
}

function Email({ address, id, subject }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { const r = document.createRange(); r.selectNodeContents(document.getElementById(id)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a id={id} href={`mailto:${address}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`} className="font-mono text-[14px] text-fg underline underline-offset-4 decoration-ember/60 hover:decoration-ember select-all break-all">{address}</a>
      <button onClick={copy} className="press rounded-md px-2 py-0.5 text-[12px] border border-line text-mute hover:text-fg hover:border-mute transition-colors">{copied ? 'Copied' : 'Copy'}</button>
      <a href={gmailCompose(address, subject)} target="_blank" rel="noopener noreferrer"
        className="press rounded-md px-2 py-0.5 text-[12px] border border-line text-mute hover:text-fg hover:border-mute transition-colors">Open in Gmail</a>
    </span>
  );
}

const H = ({ children, id }) => <h2 id={id} className="font-display text-[22px] font-bold mt-10 mb-3 text-fg scroll-mt-24">{children}</h2>;
const P = ({ children }) => <p className="mb-3">{children}</p>;
const UL = ({ children }) => <ul className="mb-3 pl-5 list-disc flex flex-col gap-1.5 marker:text-ember">{children}</ul>;

function Privacy() {
  return (
    <>
      <div className="rounded-2xl border border-ok/40 bg-ok/10 px-5 py-4 text-fg">
        <div className="font-semibold mb-1">The short version</div>
        We cannot read what you send. Everything is encrypted in your browser, and the key stays in the link,
        which our servers never receive. We keep the encrypted data only until the link is opened, expires or is
        deleted. No ads, no analytics, no tracking.
      </div>

      <H>What our servers store for each link</H>
      <UL>
        <li>The encrypted content. File names, file types and text formats are inside the encryption, so we cannot see them either.</li>
        <li>Its size, when it was created, when it expires, and how many times it has been opened.</li>
        <li>Encryption settings that are needed to decrypt but are useless without the key (an initialization vector and, for password links, a salt).</li>
        <li>For password links: a one-way hash of a value your browser derives from the password, and how many tries are left. We never receive the password.</li>
        <li>A one-way hash of a management token that lets the sender check or cancel the link.</li>
      </UL>
      <P>We never receive the link's key, your password, or anything you sent in readable form.</P>

      <H>How long we keep it</H>
      <P>
        The encrypted content is deleted as soon as a burn-after-reading link is opened, when a link expires (at the
        latest 24 hours after it was created), when the sender revokes it, when someone runs out of password tries, or
        when we remove it after an abuse report. A small status record with no content (for example "opened" or
        "expired") stays for up to 7 days so the sender can see what happened, and is then deleted.
      </P>

      <H>IP addresses and logs</H>
      <P>
        Ashdrop runs on Cloudflare. Like any web host, Cloudflare sees the IP address of everyone who connects. We use
        it only to count requests per minute so that one person cannot flood the service; we do not store it.
        Cloudflare keeps short-lived request logs for us (time, address requested, response status and errors) for
        3 to 7 days so we can fix problems. The link key is never in these logs, because browsers do not send the part
        of a link after the # to any server.
      </P>

      <H>What stays on your device</H>
      <P>Your browser stores a few things locally. They are never sent to us, and you can delete them by clearing this site's data in your browser.</P>
      <UL>
        <li>Your settings, such as theme, animation speed and sharing defaults.</li>
        <li>My links: the links you sent, including their keys, so you can copy, track and revoke them. With the passcode lock on, this list is encrypted with your passcode.</li>
        <li>While you view a link, its key is kept for that tab only, so reloading the page still works.</li>
      </UL>

      <H>Cookies</H>
      <P>We do not set cookies. Cloudflare may set strictly necessary security cookies to protect the site from attacks.</P>

      <H>Who else is involved</H>
      <P>
        Cloudflare hosts the site and stores the encrypted data on our behalf. We do not sell or share data with anyone
        else, and we do not use advertising or analytics services. If we receive a lawful request, we can only provide
        what we have: encrypted data we cannot read, sizes and timestamps. Once a link is gone, we have nothing at all.
      </P>

      <H>Your rights</H>
      <P>
        Depending on where you live, you may have rights to access or delete personal data about you. Because Ashdrop
        has no accounts and cannot read what is stored, we usually cannot tell which data relates to you. As a sender
        you can delete any link at any time with Revoke in My links. For anything else, write to us at the address below.
      </P>

      <H>Children</H>
      <P>Ashdrop is not meant for anyone under {SITE.minAge}.</P>

      <H>Changes</H>
      <P>If we change how Ashdrop handles data, we will update this page and the date at the top before the change takes effect.</P>

      <H>Contact</H>
      <P>Privacy questions: <Email address={SITE.contactEmail} id="privacy-email" /></P>
    </>
  );
}

function Terms() {
  return (
    <>
      <P>
        These terms are an agreement between you and {who()}{SITE.country ? `, based in ${SITE.country}` : ''}. By using
        Ashdrop you accept them. If you do not agree, please do not use the service.
      </P>

      <H>The service</H>
      <P>
        Ashdrop lets you share text and files through encrypted links that delete themselves. It is free and needs no
        account. We may change, limit or stop the service at any time, for example to deal with abuse or cost.
      </P>

      <H>Your responsibilities</H>
      <UL>
        <li>You are responsible for what you share and who you share it with.</li>
        <li>Anyone who has a link (and its password, if it has one) can open it. Keep links and passwords private.</li>
        <li>We cannot read, recover or restore anything. Do not use Ashdrop as the only copy of something you need.</li>
      </UL>

      <H>What you must not do</H>
      <UL>
        <li>Share anything illegal where you or the recipient are, including child sexual abuse material, which we report to the authorities when we become aware of it.</li>
        <li>Share malware, phishing pages or anything meant to deceive or harm the person who opens it.</li>
        <li>Harass, threaten or expose other people, or share their private information without permission.</li>
        <li>Share material that infringes someone else's copyright or other rights.</li>
        <li>Overload the service, get around its limits, or attack its security. If you find a security problem, please report it to us instead; we welcome that.</li>
      </UL>

      <H>What we do about abuse</H>
      <P>
        We cannot see what is inside a link, so we rely on reports. When a link is reported to us we may remove it
        without notice, and we may block requests that abuse the service. We cooperate with lawful requests, within the
        limits of what we hold (see the Privacy page).
      </P>

      <H>No warranty</H>
      <P>
        Ashdrop is provided as it is, without warranties of any kind. We work hard to keep it secure and available, but
        we cannot promise that it will always work, or that a link will reach or be readable by the person you send it to.
      </P>

      <H>Limitation of liability</H>
      <P>
        To the extent the law allows, we are not liable for any indirect or consequential loss, or for loss of data,
        arising from your use of Ashdrop. Nothing in these terms limits liability that cannot be limited by law.
      </P>

      <H>Governing law</H>
      <P>{SITE.country ? `These terms are governed by the laws of ${SITE.country}.` : 'These terms are governed by the laws of the country where the operator is based.'}</P>

      <H>Changes</H>
      <P>We may update these terms. The date at the top shows the latest version. Using Ashdrop after a change means you accept the new terms.</P>

      <H>Contact</H>
      <P>Questions about these terms: <Email address={SITE.contactEmail} id="terms-email" /></P>
    </>
  );
}

function Contact() {
  const ideas = ['A feature you wish Ashdrop had', 'Something that felt slow or confusing', 'A bug, or a page that looked wrong', 'Where you use Ashdrop, so we know what matters'];
  return (
    <>
      <section id="ideas" className="relative overflow-hidden rounded-3xl border border-line p-6 sm:p-7 mb-8 scroll-mt-24"
        style={{ background: 'linear-gradient(135deg, rgb(var(--c-ember) / .14), rgb(181 107 255 / .12) 50%, rgb(var(--c-cyan) / .12))' }}>
        <div className="label text-ember">Ideas and feedback</div>
        <h2 className="font-display text-[26px] sm:text-[30px] font-bold text-fg mt-1 leading-tight">Tell us what to add or improve. We listen.</h2>
        <p className="mt-2 text-fg/80">
          Ashdrop is young, and what we build next depends on the people using it. Send us your ideas, big or small.
          We read every message and use them to decide what comes next.
        </p>
        <ul className="mt-4 grid sm:grid-cols-2 gap-2">
          {ideas.map(t => (
            <li key={t} className="flex items-start gap-2 rounded-xl bg-panel/70 border border-line px-3 py-2 text-[13.5px] text-fg">
              <span className="text-ember mt-0.5" aria-hidden="true">✦</span>{t}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a id="ideas-gmail" href={gmailCompose(SITE.contactEmail, 'Idea for Ashdrop')} target="_blank" rel="noopener noreferrer"
            className="press ember-glow inline-flex items-center gap-2 rounded-xl px-5 py-3 bg-ember text-ink font-semibold hover:brightness-110 transition">
            Write in Gmail
          </a>
          <a id="ideas-mailto" href={`mailto:${SITE.contactEmail}?subject=${encodeURIComponent('Idea for Ashdrop')}`}
            className="press inline-flex items-center gap-2 rounded-xl px-5 py-3 font-semibold border border-line bg-panel/70 text-fg hover:border-mute transition-colors">
            Use my email app
          </a>
        </div>
        <div className="mt-3 text-[13px]">
          Or copy the address: <Email address={SITE.contactEmail} id="ideas-email" subject="Idea for Ashdrop" />
        </div>
      </section>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="label mb-2">General, privacy and security</div>
          <Email address={SITE.contactEmail} id="contact-email" />
          <p className="text-[13px] mt-3">Questions, feedback, privacy requests, or a security problem you found.</p>
        </div>
        <div className="rounded-2xl border border-ember/40 bg-panel p-5">
          <div className="label mb-2 text-ember">Report abuse</div>
          <Email address={SITE.abuseEmail} id="abuse-email" />
          <p className="text-[13px] mt-3">A link that breaks our Terms: illegal content, malware, phishing or harassment.</p>
        </div>
      </div>

      <H id="abuse">Reporting a link</H>
      <P>Send us the link and a short description of the problem. We remove reported links that break our Terms.</P>
      <UL>
        <li>The part of the link before the # is enough for us to remove it, for example <span className="font-mono text-fg">{SITE.domain}/p/abcd2345ef</span>.</li>
        <li>We cannot see what is inside a link, so tell us what it contains and why you are reporting it.</li>
        <li>If someone is in danger or a crime is involved, contact your local police as well. We act on reports, but we are not an emergency service.</li>
      </UL>

      <H>Requests from authorities</H>
      <P>
        Send them to <span className="font-mono text-fg">{SITE.abuseEmail}</span>. Please read the Privacy page first:
        we hold only encrypted data we cannot read, sizes and timestamps, and nothing at all once a link is gone.
      </P>
    </>
  );
}

const PAGES = {
  terms: { title: 'Terms of use', Body: Terms },
  privacy: { title: 'Privacy', Body: Privacy },
  contact: { title: 'Contact', Body: Contact },
};

export function LegalPage({ page }) {
  const { title, Body } = PAGES[page];
  // The page is drawn after the browser looks for #ideas or #abuse, so scroll there ourselves.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, []);
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-line">
        <div className="gutter max-w-6xl mx-auto py-3 flex items-center gap-3">
          <a href="/" aria-label="Ashdrop home"><Logo /></a>
          <nav className="ml-auto flex gap-1 text-[13px]" aria-label="Pages">
            {Object.entries(PAGES).map(([k, v]) => (
              <a key={k} href={`/${k}`} aria-current={k === page ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 transition-colors ${k === page ? 'bg-fg text-ink font-semibold' : 'text-mute hover:text-fg'}`}>{k === 'terms' ? 'Terms' : v.title}</a>
            ))}
          </nav>
        </div>
      </header>
      <main className="gutter flex-1 py-10 sm:py-14">
        <article className="max-w-[68ch] mx-auto text-[15px] leading-relaxed text-mute fade-in">
          {LEGAL_IS_DRAFT && page !== 'contact' && (
            <div role="note" className="mb-6 rounded-xl border border-warn/50 bg-warn/10 px-4 py-3 text-[13px] text-warn">
              Draft. Before launch, fill in who runs Ashdrop and where (src/site.js), and have this page reviewed.
            </div>
          )}
          <h1 className="font-display text-[34px] sm:text-[44px] font-bold leading-tight text-fg text-balance">{title}</h1>
          {page !== 'contact' && <p className="text-[13px] mt-2 mb-8">Last updated {fmtDate(SITE.updated)}</p>}
          {page === 'contact' && <p className="text-[15px] mt-2 mb-8">We read every message. We do not offer phone support.</p>}
          <Body />
          <p className="mt-12"><a href="/" className="text-ember hover:underline underline-offset-4">← Back to Ashdrop</a></p>
        </article>
      </main>
      <Footer className="gutter py-6 border-t border-line" />
    </div>
  );
}
