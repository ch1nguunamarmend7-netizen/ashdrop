# Security policy

Ashdrop is new and has not yet been independently audited. Reports are very welcome.

## Reporting a vulnerability

Please email **helloashdrop.cc@gmail.com** with the subject "Security report". Include what you found,
how to reproduce it, and what an attacker could do with it. Please do not open a public GitHub issue for
security problems until a fix is out.

We will reply, keep you updated while we work on a fix, and credit you in the release notes if you want.
We will not take legal action against anyone who reports a problem in good faith and does not access or
harm other people's data.

## What is in scope

- Anything that lets the server, Cloudflare, or a network attacker read what users share
- Getting a link's key, password, file name or content without having the full link
- Opening a burn link twice, skipping the password lockout, or reviving a deleted link
- Running scripts on ashdrop.cc (XSS) or bypassing the Content Security Policy
- Reading or tampering with another user's My links data

## Out of scope

- Someone who already has the full link opening it (that is how links work)
- Attacks that need malware on the user's device
- Rate limits being reachable, missing best-practice headers with no real impact, and denial of service
