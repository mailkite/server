// api-local — reference implementation of the backend contract (docs/contract.md).
// Node >= 22.5 (node:sqlite), zero npm dependencies.
//
// Implements: /api/ingest, /api/mx/accepted-domains, /api/smtp/auth, /api/relay,
// /api/imap/{auth,status,list,flags,raw}.
//
// Outbound: /api/relay stores to Sent, loop-delivers to locally-hosted domains, and
// hands everyone else to the smarthost named by SMARTHOST (see lib/smarthost.mjs).
// Unset SMARTHOST → external recipients are skipped and logged.
//
// Env: HMAC_SECRET (required), PORT (8787), HOST (127.0.0.1), DATA_DIR (./data),
//      SMARTHOST (cloud | smtp[s]://user:pass@host:port), MAILKITE_SEND_KEY

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Store } from './lib/db.mjs';
import { headers, firstAddress, subject } from './lib/rfc822.mjs';
import { parseSmarthost, relayExternal, sendViaSmtp } from './lib/smarthost.mjs';
import {
  authorizeUrl, codeMatches, fetchOauthEmail, hashCode, isEmailMethod, isOauthMethod,
  newCode, newState, publicSettings, sendSetupCode, smtpCfg,
} from './lib/auth-setup.mjs';
import { matchesAddress, normalizePattern, splitAddress } from './lib/patterns.mjs';
import { buildPayload, runDue, startScanner } from './lib/webhooks.mjs';

const SECRET = process.env.HMAC_SECRET || '';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
const MAX_BODY = 30 * 1024 * 1024; // a hair above the edges' 25 MB databytes
const DRIFT_S = 5 * 60;

if (!SECRET) { console.error('api-local: HMAC_SECRET is required'); process.exit(1); }

const store = new Store(DATA_DIR);
// Outbound to recipients we don't host: cloud relay, an SMTP smarthost, or nothing.
const SMARTHOST = parseSmarthost();

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const constEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && timingSafeEqual(A, B); };
const edgeAuthed = (req) => constEq((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET);

// ---- console auth (magic link + cookie sessions) --------------------------------
// ADMIN_EMAIL anchors who may sign in; more admins can be invited once inside.
// With neither ADMIN_EMAIL nor any admin on record, the install is unclaimed and the
// first email entered on the web console becomes the admin (the WordPress-install
// pattern — accepted race by decision; recovery is `cli.mjs reset-admin`, since box
// access is the root credential).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const SEND_KEY = process.env.MAILKITE_SEND_KEY || '';
const MAGIC_FROM = process.env.MAGIC_LINK_FROM || '';
// Configurable so tests can exercise the real link flow against a stub, and so a
// self-hoster can point at their own compatible send endpoint.
const SEND_URL = process.env.MAILKITE_SEND_URL || 'https://api.mailkite.dev/v1/send';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
if (ADMIN_EMAIL) store.addAdminUser(ADMIN_EMAIL);

// ---- sign-in state machine (docs/auth-setup.md) ---------------------------------
// unclaimed → claimed/setup-incomplete → complete. Direct sign-in exists ONLY in the
// claim step, so "knows the admin address" is enough for exactly one session, not for
// the life of the install.

/**
 * Env-supplied credentials are honoured as pre-configuration: a scripted deploy comes
 * up already set up and never shows the wizard. Env always wins over the database.
 */
function envAuthMethod() {
  if (SEND_KEY) return { method: 'email_cloud', settings: { key: SEND_KEY, from: MAGIC_FROM, url: SEND_URL }, source: 'env' };
  const provider = (process.env.OAUTH_PROVIDER || '').trim().toLowerCase();
  const clientId = process.env.OAUTH_CLIENT_ID || '';
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || '';
  if ((provider === 'google' || provider === 'github') && clientId && clientSecret) {
    const allowed = (process.env.OAUTH_ALLOWED_EMAILS || ADMIN_EMAIL || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return { method: `oauth_${provider}`, settings: { clientId, clientSecret, allowedEmails: allowed }, source: 'env' };
  }
  return null;
}

/** The method actually in force, or null while setup is still owed. */
function effectiveAuth() {
  const env = envAuthMethod();
  if (env) return env;
  const cfg = store.authConfig();
  return cfg.complete && cfg.method ? { method: cfg.method, settings: cfg.settings, source: 'configured' } : null;
}

const unclaimed = () => !ADMIN_EMAIL && store.adminUserCount() === 0;
/** Claimed, but no proven sign-in method yet: the console is gated on finishing setup. */
const setupOwed = () => !unclaimed() && !effectiveAuth();

/** Where the provider sends the user back. Must match what was sent to `authorize`. */
const oauthRedirect = (req) => `${scheme}://${req.headers.host}/api/auth/oauth/callback`;

/** OAuth errors land in a browser, not a fetch — render a readable page, not JSON. */
function oauthFail(res, message) {
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const safe = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>`
    + `<body style="font:15px/1.5 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.5rem;background:#0b0d12;color:#e6e8ee">`
    + `<h1 style="font-size:1.1rem">Sign-in failed</h1><p style="color:#9aa3b2">${safe}</p>`
    + `<p><a href="/" style="color:#6ea8fe">Back to sign in</a></p>`);
}

const getCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};
// Cookie path requires the x-mailkite-ui header — a cross-site form can post
// cookies but can't attach custom headers, so this is the CSRF gate.
const uiSession = (req) => (req.headers['x-mailkite-ui'] === '1' ? store.sessionEmail(getCookie(req, 'mk_session')) : null);
const adminAuthed = (req) => edgeAuthed(req) || !!uiSession(req);
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const setSessionCookie = (res, raw, maxAge = 30 * 24 * 60 * 60) =>
  res.setHeader('set-cookie', `mk_session=${raw}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${scheme === 'https' ? '; Secure' : ''}`);

const defaultFrom = () => MAGIC_FROM || `no-reply@${store.domains()[0] || 'localhost'}`;

/**
 * Send a sign-in link over whichever email method setup proved.
 * @returns {Promise<boolean>} true only if the mail was actually accepted for delivery.
 */
async function deliverLink(auth, email, url) {
  const subject = 'Sign in to MailKite Server';
  const text = `Click to sign in to your MailKite Server console:\n\n${url}\n\n`
    + `The link works once and expires in 15 minutes. If you didn't request it, ignore this email.`;
  const from = auth.settings.from || defaultFrom();
  try {
    if (auth.method === 'email_cloud') {
      const r = await fetch(auth.settings.url || SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.settings.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: email, subject, text }),
      });
      if (!r.ok) throw new Error(`send API ${r.status}`);
      return true;
    }
    if (auth.method === 'email_smtp') {
      await sendViaSmtp(smtpCfg(auth.settings), { from, to: email, subject, text });
      return true;
    }
    return false;
  } catch (e) {
    // The link is logged so the operator can still recover from the box, but no session
    // is issued — see the request-link handler for why this fails closed.
    console.error(`magic-link: send failed (${e.message})\nmagic-link: ${url}`);
    return false;
  }
}

// x-mailkite-signature: t=<unix>,v1=<hex of HMAC-SHA256(secret, "<t>." + raw)>
function verifyIngestSignature(req, raw) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers['x-mailkite-signature'] || '');
  if (!m) return false;
  const [, t, sig] = m;
  if (Math.abs(Date.now() / 1000 - Number(t)) > DRIFT_S) return false;
  const expect = createHmac('sha256', SECRET).update(`${t}.`).update(raw).digest('hex');
  return constEq(sig, expect);
}

function metaFrom(raw, extra = {}) {
  const h = headers(raw);
  return {
    from_addr: firstAddress(h.from),
    to_addr: firstAddress(h.to),
    subject: subject(h.subject),
    ...extra,
  };
}

// The A record for a mail host must point at this server, so tell the web console what
// this server's public address actually is instead of making the admin look it up:
// resolve the hostname they're browsing (already public by definition), and fall back to
// the local address of the connection they arrived on. Behind a proxy/NAT the latter is
// private, so it is only reported when it isn't in an RFC1918/loopback/CGNAT range.
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const isPrivateV4 = (ip) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
const publicIpCache = new Map();
async function detectPublicIp(req) {
  const host = String(req.headers.host || '').split(':')[0];
  if (IPV4_RE.test(host) && !isPrivateV4(host)) return host;
  if (host && host !== 'localhost') {
    if (publicIpCache.has(host)) return publicIpCache.get(host);
    try {
      const { resolve4 } = await import('node:dns/promises');
      const [ip] = await resolve4(host);
      if (ip) { publicIpCache.set(host, ip); return ip; }
    } catch { /* unresolvable (fresh install, split-horizon DNS) — fall through */ }
  }
  const local = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
  return IPV4_RE.test(local) && !isPrivateV4(local) ? local : null;
}

/**
 * Resolve an app-password secret against a concrete address and protocol.
 * Returns the shape /api/imap/auth has always answered with, plus the row, or null
 * when the secret is unknown, lacks the protocol, or doesn't cover the address.
 * Rows predating scoping default to imap-only on their own address.
 */
function resolveAppPassword(secret, address, protocol) {
  const pw = store.findAppPassword(secret);
  if (!pw) return null;
  if (!String(pw.protocols || 'imap').split(',').includes(protocol)) return null;
  const scope = pw.domain || splitAddress(pw.username).domain;
  const pattern = pw.address || splitAddress(pw.username).local;
  if (!matchesAddress(pattern, address, scope)) return null;
  const { domain } = splitAddress(address);
  // A wildcard password is account-wide; a concrete one scopes the session to that
  // address, so IMAP shows exactly what the REST routes would. The edge echoes
  // mailboxId back on every read, so this needs no edge change.
  const wildcard = String(pattern).includes('*');
  return {
    userId: pw.user_id,
    domain,
    mailboxId: pw.mailbox_id ?? (wildcard ? null : address.toLowerCase()),
    row: pw,
  };
}

// mailboxId carries the session's address scope for address-scoped app passwords
// (numeric/absent values are legacy account-wide sessions).
const addressScope = (mailboxId) =>
  typeof mailboxId === 'string' && mailboxId.includes('@') ? mailboxId.toLowerCase() : null;

const routes = {
  // ---- inbound ---------------------------------------------------------------
  'POST /api/ingest': async (req, res, raw) => {
    if (!verifyIngestSignature(req, raw)) return json(res, 401, { error: 'bad signature', code: 'bad_signature' });
    const rcpts = String(req.headers['x-mailkite-rcpt'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!rcpts.length) return json(res, 400, { error: 'no recipients', code: 'no_rcpt' });
    let stored = 0;
    let deduped = 0;
    let queued = 0;
    // Idempotent by (recipient, mailbox, content hash): a multi-backend edge tempfailing
    // on a sibling backend makes the sender retry — the re-delivery must not duplicate.
    const blobSha = Store.hashRaw(raw);
    const meta0 = metaFrom(raw);
    for (const rcpt of rcpts) {
      const domain = (rcpt.split('@')[1] || '').toLowerCase();
      const userId = store.userForDomain(domain);
      if (userId == null) continue; // not ours; RCPT gating should have caught it
      if (store.messageExists(userId, 'INBOX', blobSha, rcpt)) { deduped++; continue; }
      const uid = store.storeMessage(userId, 'INBOX', raw, metaFrom(raw, {
        to_addr: rcpt,
        mailfrom: req.headers['x-mailkite-mailfrom'] || '',
        rcpt: rcpt,
        spf: req.headers['x-mailkite-spf'], dkim: req.headers['x-mailkite-dkim'],
        dmarc: req.headers['x-mailkite-dmarc'], spam: req.headers['x-mailkite-spam'],
        spam_verdict: req.headers['x-mailkite-spam-verdict'],
      }));
      stored++;
      // Store first, then queue: the message is safe even if dispatch never succeeds.
      const hook = store.webhook(domain);
      if (hook) {
        store.queueDelivery(domain, hook.url, buildPayload({
          domain, rcpt, uid,
          mailfrom: req.headers['x-mailkite-mailfrom'] || '',
          from: meta0.from_addr, subject: meta0.subject,
          baseUrl: `${scheme}://${req.headers.host || ''}`,
        }));
        queued++;
      }
    }
    // Fire the queue now (don't await — the edge's 2xx shouldn't wait on a receiver).
    if (queued) runDue(store).catch((e) => console.error('webhook dispatch:', e.message));
    return json(res, 200, { ok: true, stored, deduped, webhooksQueued: queued });
  },

  'GET /api/mx/accepted-domains': async (req, res) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { domains: store.domains() });
  },

  // ---- outbound --------------------------------------------------------------
  'POST /api/smtp/auth': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { key } = JSON.parse(raw.toString() || '{}');
    const userId = key ? store.userForApiKey(key) : null;
    return json(res, 200, userId != null ? { ok: true, userId } : { ok: false });
  },

  'POST /api/relay': async (req, res, raw) => {
    const key = (req.headers.authorization || '').replace(/^Bearer /, '');
    const userId = key ? store.userForApiKey(key) : null;
    if (userId == null) return json(res, 401, { error: 'invalid API key', code: 'bad_key' });
    const meta = metaFrom(raw);
    // Gate: the From domain must belong to the authenticated user (contract parity
    // with the cloud's verified-domain gate).
    const fromDomain = (meta.from_addr.split('@')[1] || '').toLowerCase();
    if (!fromDomain || store.userForDomain(fromDomain) !== userId) {
      return json(res, 403, { error: `From domain not owned by this account: ${fromDomain || '(none)'}`, code: 'from_domain' });
    }
    const rcpts = String(req.headers['x-mailkite-rcpt'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!rcpts.length) return json(res, 400, { error: 'no recipients', code: 'no_rcpt' });
    store.storeMessage(userId, 'Sent', raw, { ...meta, flags: 'Seen', rcpt: rcpts.join(',') });
    // Loop-delivery: recipients on locally-hosted domains land in their INBOX.
    const externalRcpts = [];
    let local = 0;
    for (const rcpt of rcpts) {
      const rcptUser = store.userForDomain(rcpt.split('@')[1] || '');
      if (rcptUser != null) { store.storeMessage(rcptUser, 'INBOX', raw, metaFrom(raw, { to_addr: rcpt, mailfrom: meta.from_addr, rcpt })); local++; }
      else externalRcpts.push(rcpt);
    }
    // Everyone else goes out through the smarthost, if one is configured.
    let relayed = 0;
    if (externalRcpts.length && SMARTHOST) {
      try {
        ({ relayed } = await relayExternal(SMARTHOST, raw, externalRcpts, meta.from_addr));
        console.log(`relay: ${relayed} external recipient(s) via ${SMARTHOST.mode} smarthost`);
      } catch (e) {
        // The Sent copy is already stored; report the failure so the SMTP edge
        // tempfails and the client retries rather than silently losing the mail.
        console.error(`relay: smarthost (${SMARTHOST.mode}) failed — ${e.message}`);
        return json(res, 502, { error: `smarthost delivery failed: ${e.message}`, code: 'smarthost_failed', localDelivered: local });
      }
    } else if (externalRcpts.length) {
      console.warn(`relay: ${externalRcpts.length} external recipient(s) NOT delivered (no SMARTHOST configured)`);
    }
    return json(res, 200, {
      ok: true,
      localDelivered: local,
      externalSkipped: SMARTHOST ? 0 : externalRcpts.length,
      smarthost: SMARTHOST ? SMARTHOST.mode : null,
      relayed,
    });
  },

  // ---- IMAP read API -----------------------------------------------------------
  // App passwords: domain + address pattern + the `imap` protocol. Secrets issued
  // before scoping existed (`mk_imap_…`) resolve through the same path.
  'POST /api/imap/auth': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { username, password, ip } = JSON.parse(raw.toString() || '{}');
    if (store.lockedOut(ip)) return json(res, 429, { ok: false, code: 'locked_out' });
    const hit = (username && password) ? resolveAppPassword(password, username, 'imap') : null;
    if (!hit) { store.authFail(ip); return json(res, 200, { ok: false, code: 'bad_credentials' }); }
    store.authOk(ip);
    return json(res, 200, { ok: true, userId: hit.userId, domain: hit.domain, mailboxId: hit.mailboxId });
  },

  'POST /api/imap/status': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, mailboxId } = JSON.parse(raw.toString() || '{}');
    return json(res, 200, store.status(userId, mailbox, addressScope(mailboxId)));
  },

  'POST /api/imap/list': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, mailboxId } = JSON.parse(raw.toString() || '{}');
    return json(res, 200, { messages: store.list(userId, mailbox, addressScope(mailboxId)) });
  },

  'POST /api/imap/raw': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, uid, mailboxId } = JSON.parse(raw.toString() || '{}');
    const bytes = store.raw(userId, mailbox, uid, addressScope(mailboxId));
    if (!bytes) return json(res, 404, { error: 'raw unavailable', code: 'no_raw' });
    res.writeHead(200, { 'content-type': 'message/rfc822' });
    return res.end(bytes);
  },

  'POST /api/imap/flags': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, uid, flags, mailboxId } = JSON.parse(raw.toString() || '{}');
    const scope = addressScope(mailboxId);
    if (scope) store.setFlagsForAddress(userId, mailbox, scope, uid, String(flags || ''));
    else store.setFlags(userId, mailbox, uid, String(flags || ''));
    return json(res, 200, { ok: true });
  },
};

// ---- console auth endpoints ------------------------------------------------------
Object.assign(routes, {
  // Always {ok:true} for unknown emails — no account enumeration. Rate limiting counts
  // *failed* attempts only (10 / 15 min) and resets on success: an admin signing in
  // repeatedly must never lock themselves out, and a locked-out caller gets an explicit
  // 429 rather than a silent "check your email" that never arrives.
  'POST /api/auth/request-link': async (req, res, raw) => {
    const ip = 'link:' + clientIp(req);
    if (store.lockedOut(ip, 10)) {
      return json(res, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.', code: 'rate_limited' });
    }
    const { email } = JSON.parse(raw.toString() || '{}');
    const auth = effectiveAuth();
    // Not set up yet: no verification method exists, so a known admin still signs in
    // directly — the same posture as an unclaimed install, and the only one available
    // when nothing can send mail. Restricting this to a single session bricked an admin
    // who lost their cookie before finishing setup (recovery meant shell access), which
    // is worse friction than the window it closed. The console gates every screen behind
    // setup, and once a method is proven this branch is gone for good.
    if (!auth) {
      if (typeof email === 'string' && store.isAdminUser(email)) {
        store.authOk(ip);
        console.warn(`sign-in before setup (no verification method configured): ${email.toLowerCase()} ip=${clientIp(req)}`);
        setSessionCookie(res, store.createSession(email.toLowerCase()));
        return json(res, 200, { ok: true, signedIn: true, setupRequired: true, email: email.toLowerCase() });
      }
      store.authFail(ip);
      return json(res, 200, { ok: true, setupRequired: true });
    }
    // OAuth installs have no email path at all.
    if (isOauthMethod(auth.method)) {
      return json(res, 200, { ok: true, oauth: auth.method === 'oauth_google' ? 'google' : 'github' });
    }
    if (typeof email === 'string' && store.isAdminUser(email)) {
      store.authOk(ip); // known admin — clear any accumulated failures
      const token = store.createLoginToken(email);
      const delivered = await deliverLink(auth, email.toLowerCase(), `${scheme}://${req.headers.host}/login#token=${token}`);
      // FAIL CLOSED. Sign-in is verified by email, so a delivery failure must NOT hand
      // out a session: otherwise any outage — or one an attacker waits for — downgrades
      // authentication to "knows the admin address". Recovery is `cli.mjs reset-auth`.
      if (!delivered) {
        console.error(`magic-link: NOT delivered for ${email.toLowerCase()} — session refused; use the logged link above, or run: node cli.mjs reset-auth`);
      }
      return json(res, 200, { ok: true });
    }
    store.authFail(ip); // unknown email — this is what the limiter is for
    return json(res, 200, { ok: true });
  },
  'POST /api/auth/verify': async (req, res, raw) => {
    const { token } = JSON.parse(raw.toString() || '{}');
    const email = token ? store.consumeLoginToken(token) : null;
    if (!email) return json(res, 400, { error: 'That sign-in link is invalid or expired — request a new one.', code: 'bad_token' });
    setSessionCookie(res, store.createSession(email));
    return json(res, 200, { ok: true, email });
  },
  'POST /api/auth/logout': async (req, res) => {
    store.deleteSession(getCookie(req, 'mk_session'));
    setSessionCookie(res, '', 0);
    return json(res, 200, { ok: true });
  },
  'GET /api/auth/me': async (req, res) => {
    const email = uiSession(req);
    return email ? json(res, 200, { email }) : json(res, 401, { error: 'not signed in' });
  },
  // Routing probe for the web console. Which METHOD is in force is not a secret (the
  // sign-in screen has to render it); its credentials never appear here.
  'GET /api/auth/status': async (req, res) => {
    const auth = effectiveAuth();
    return json(res, 200, {
      needsSetup: unclaimed(),
      setupRequired: setupOwed(),
      method: auth?.method ?? null,
      mailChannel: !!auth && isEmailMethod(auth.method),
    });
  },
  // First-visitor admin claim (WordPress-style): only while the install has no admin
  // and no ADMIN_EMAIL. Recovery from a squatted claim: `cli.mjs reset-admin <email>`.
  'POST /api/auth/setup': async (req, res, raw) => {
    if (!unclaimed()) {
      return json(res, 403, { error: 'Setup is not available — an admin already exists.', code: 'no_setup' });
    }
    const { email } = JSON.parse(raw.toString() || '{}');
    if (!EMAIL_RE.test(email || '')) return json(res, 400, { error: 'Enter a valid email address.', code: 'bad_email' });
    store.addAdminUser(email);
    console.log(`web console admin claimed: ${email.toLowerCase()} ip=${clientIp(req)}`);
    setSessionCookie(res, store.createSession(email));
    return json(res, 200, { ok: true, email: email.toLowerCase() });
  },
  // ---- sign-in setup (docs/auth-setup.md) ---------------------------------------
  // All session-authed: only someone already inside the console may choose how future
  // sign-ins are verified.

  'GET /api/auth/setup-state': async (req, res) => {
    const email = uiSession(req);
    if (!email) return json(res, 401, { error: 'not signed in' });
    const auth = effectiveAuth();
    const cfg = store.authConfig();
    const pendingEmail = store.pendingSetup('email');
    return json(res, 200, {
      state: unclaimed() ? 'unclaimed' : auth ? 'complete' : 'setup',
      method: auth?.method ?? null,
      source: auth?.source ?? null,          // 'env' installs can't be changed from here
      verifiedAt: cfg.verifiedAt ?? null,
      settings: auth ? publicSettings(auth.method, auth.settings) : {},
      pending: pendingEmail ? { kind: 'email', method: pendingEmail.method, sentTo: pendingEmail.email } : null,
      adminEmail: email,
    });
  },

  // Prove an email path: send a real code through the CANDIDATE config. Nothing is
  // persisted as authoritative here — a key that 401s fails loudly instead.
  'POST /api/auth/setup/email': async (req, res, raw) => {
    const email = uiSession(req);
    if (!email) return json(res, 401, { error: 'not signed in' });
    if (envAuthMethod()) return json(res, 409, { error: 'Sign-in is configured by environment variables on this server.', code: 'env_managed' });
    const body = JSON.parse(raw.toString() || '{}');
    const mode = body.mode === 'smtp' ? 'smtp' : 'cloud';
    let method, settings;
    if (mode === 'cloud') {
      const key = String(body.key || '').trim();
      if (!key) return json(res, 400, { error: 'Enter a MailKite Cloud API key.', code: 'bad_key' });
      method = 'email_cloud';
      settings = { key, from: String(body.from || '').trim() || defaultFrom(), url: SEND_URL };
    } else {
      const s = body.smtp || {};
      const missing = ['host', 'from'].filter((k) => !String(s[k] || '').trim());
      if (missing.length) return json(res, 400, { error: `Missing SMTP ${missing.join(' and ')}.`, code: 'bad_smtp' });
      method = 'email_smtp';
      settings = {
        host: String(s.host).trim(), port: Number(s.port) || 587,
        user: String(s.user || '').trim(), pass: String(s.pass || ''),
        from: String(s.from).trim(),
      };
    }
    const code = newCode();
    try {
      await sendSetupCode({ method, settings, to: email, code, sendUrl: SEND_URL });
    } catch (e) {
      // Proof failed → nothing stored. This is the whole point of the flow.
      return json(res, 400, { error: `Couldn't send the verification email — ${e.message}`, code: 'send_failed' });
    }
    store.putPendingSetup('email', { method, settings, codeHash: hashCode(code), email });
    console.log(`sign-in setup: verification code sent to ${email} via ${method}`);
    return json(res, 200, { sent: true, to: email });
  },

  // The code came back → the path demonstrably works → promote it.
  'POST /api/auth/setup/email/verify': async (req, res, raw) => {
    const email = uiSession(req);
    if (!email) return json(res, 401, { error: 'not signed in' });
    const pending = store.pendingSetup('email');
    if (!pending) return json(res, 400, { error: 'That code expired — send a new one.', code: 'no_pending' });
    if (store.bumpPendingAttempts('email') > 5) {
      store.clearPendingSetup('email');
      return json(res, 429, { error: 'Too many attempts — send a new code.', code: 'too_many_attempts' });
    }
    const { code } = JSON.parse(raw.toString() || '{}');
    if (!codeMatches(code, pending.code_hash)) {
      return json(res, 400, { error: "That code doesn't match.", code: 'bad_code' });
    }
    store.setAuthConfig(pending.method, pending.settings);
    store.clearPendingSetup('email');
    console.log(`sign-in setup complete: ${pending.method} (verified by ${email})`);
    return json(res, 200, { ok: true, method: pending.method });
  },

  // Stage an OAuth candidate and hand back the authorize URL. Completing the round
  // trip is the proof; nothing is authoritative until the callback succeeds.
  'POST /api/auth/setup/oauth': async (req, res, raw) => {
    const email = uiSession(req);
    if (!email) return json(res, 401, { error: 'not signed in' });
    if (envAuthMethod()) return json(res, 409, { error: 'Sign-in is configured by environment variables on this server.', code: 'env_managed' });
    const { provider, clientId, clientSecret, allowedEmails } = JSON.parse(raw.toString() || '{}');
    if (provider !== 'google' && provider !== 'github') {
      return json(res, 400, { error: 'Choose Google or GitHub.', code: 'bad_provider' });
    }
    if (!String(clientId || '').trim() || !String(clientSecret || '').trim()) {
      return json(res, 400, { error: 'Enter the client ID and secret.', code: 'bad_client' });
    }
    const allowed = (Array.isArray(allowedEmails) ? allowedEmails : [])
      .map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
    // The admin doing setup must be able to get back in, or completing setup would
    // lock them out of their own console.
    if (!allowed.includes(email.toLowerCase())) allowed.unshift(email.toLowerCase());
    const state = newState();
    const settings = { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim(), allowedEmails: allowed };
    store.putPendingSetup('oauth', { method: `oauth_${provider}`, settings, state, email });
    const url = authorizeUrl({ provider, clientId: settings.clientId, redirectUri: oauthRedirect(req), state });
    return json(res, 200, { authorizeUrl: url, allowedEmails: allowed });
  },

  // Start an OAuth SIGN-IN (setup already complete): 302 to the provider.
  'GET /api/auth/oauth/start': async (req, res) => {
    const auth = effectiveAuth();
    if (!auth || !isOauthMethod(auth.method)) {
      return json(res, 400, { error: 'This server does not use OAuth sign-in.', code: 'not_oauth' });
    }
    const provider = auth.method === 'oauth_google' ? 'google' : 'github';
    const state = newState();
    store.putPendingSetup('oauth_login', { method: auth.method, settings: {}, state, ttlMs: 10 * 60 * 1000 });
    res.writeHead(302, { location: authorizeUrl({ provider, clientId: auth.settings.clientId, redirectUri: oauthRedirect(req), state }) });
    return res.end();
  },

  // One callback serves both legs: proving a new OAuth config, and ordinary sign-in.
  'GET /api/auth/oauth/callback': async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const code = q.get('code');
    const state = q.get('state');
    if (!code || !state) return oauthFail(res, 'The provider did not return an authorization code.');

    const setupPending = store.pendingSetup('oauth');
    const loginPending = store.pendingSetup('oauth_login');
    const isSetup = !!setupPending && constEq(setupPending.state || '', state);
    const isLogin = !isSetup && !!loginPending && constEq(loginPending.state || '', state);
    // A mismatched state is CSRF (or a stale tab) — never proceed on it.
    if (!isSetup && !isLogin) return oauthFail(res, 'That sign-in attempt expired or did not match. Try again.');

    const auth = isSetup
      ? { method: setupPending.method, settings: setupPending.settings }
      : effectiveAuth();
    if (!auth || !isOauthMethod(auth.method)) return oauthFail(res, 'OAuth is not configured on this server.');
    const provider = auth.method === 'oauth_google' ? 'google' : 'github';

    let email;
    try {
      email = await fetchOauthEmail({
        provider, clientId: auth.settings.clientId, clientSecret: auth.settings.clientSecret,
        redirectUri: oauthRedirect(req), code,
      });
    } catch (e) {
      console.error(`oauth: ${e.message}`);
      return oauthFail(res, `Sign-in with ${provider} failed: ${e.message}`);
    }

    const allowed = (auth.settings.allowedEmails || []).map((s) => String(s).toLowerCase());
    if (!allowed.includes(email)) {
      console.warn(`oauth: refused ${email} — not in the allow-list`);
      return oauthFail(res, `${email} is not on this server's allow-list.`);
    }

    if (isSetup) {
      store.setAuthConfig(setupPending.method, setupPending.settings);
      store.clearPendingSetup('oauth');
      for (const e of allowed) store.addAdminUser(e);
      console.log(`sign-in setup complete: ${setupPending.method} (verified by ${email})`);
    } else {
      store.clearPendingSetup('oauth_login');
    }
    store.addAdminUser(email);
    setSessionCookie(res, store.createSession(email));
    res.writeHead(302, { location: '/' });
    return res.end();
  },

  // Invite another console admin (admin-only).
  'POST /api/admin/users': async (req, res, raw) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { email } = JSON.parse(raw.toString() || '{}');
    if (!EMAIL_RE.test(email || '')) return json(res, 400, { error: 'Enter a valid email address.', code: 'bad_email' });
    store.addAdminUser(email);
    return json(res, 200, { ok: true });
  },
});

// ---- admin API (drives ui/ via the `local` provider driver) -------------------
// Same HMAC bearer as the edges. Single-tenant: everything belongs to the implicit
// 'default' account (multi-user provisioning stays on the CLI).

Object.assign(routes, {
  'GET /api/admin/overview': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const u = store.defaultUser();
    return json(res, 200, {
      domains: store.domains().length,
      publicIp: await detectPublicIp(req),
      inbox: store.status(u, 'INBOX'),
      sent: store.status(u, 'Sent'),
      capabilities: {
        inbound: true,
        imap: true,
        outboundLocal: true,
        outboundInternet: !!SMARTHOST,   // true once a smarthost is configured
        webhooks: true,                  // configurable per domain (may be unset)
        routes: false,
      },
    });
  },
  'GET /api/admin/domains': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { domains: store.domains() });
  },
  'POST /api/admin/domains': async (req, res, raw) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { domain } = JSON.parse(raw.toString() || '{}');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain || '')) return json(res, 400, { error: 'invalid domain', code: 'bad_domain' });
    store.addDomain(domain, store.defaultUser());
    return json(res, 200, { ok: true, domain: domain.toLowerCase() });
  },
  // Webhook config, one target per domain. GET lists every configured hook; POST
  // sets or clears one (empty url = clear) and returns the signing secret so it can
  // be copied into the receiver.
  'GET /api/admin/domains/webhook': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const one = q.get('domain');
    if (one) {
      const hook = store.webhook(one);
      return json(res, 200, { domain: one.toLowerCase(), url: hook?.url || null, secret: hook?.secret || null });
    }
    return json(res, 200, { webhooks: store.webhooks() });
  },
  'POST /api/admin/domains/webhook': async (req, res, raw) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { domain, url } = JSON.parse(raw.toString() || '{}');
    if (!domain || !store.domains().includes(String(domain).toLowerCase())) {
      return json(res, 400, { error: `domain not hosted here: ${domain || '(none)'}`, code: 'bad_domain' });
    }
    if (url) {
      let u;
      try { u = new URL(url); } catch { return json(res, 400, { error: 'Enter a valid URL.', code: 'bad_url' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return json(res, 400, { error: 'Webhook URL must be http(s).', code: 'bad_url' });
      }
    }
    const saved = store.setWebhook(domain, url || null);
    return json(res, 200, { ok: true, domain: String(domain).toLowerCase(), ...saved });
  },
  'GET /api/admin/domains/webhook-status': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    return json(res, 200, store.deliveryStatus(q.get('domain'), Math.min(Number(q.get('limit')) || 20, 100)));
  },

  'GET /api/admin/credentials': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const u = store.defaultUser();
    return json(res, 200, {
      apiKeys: store.apiKeys(u),
      appPasswords: store.appPasswordUsers(u),      // legacy shape: addresses only
      appPasswordRows: store.appPasswords(u),       // full rows: scope + access + usage
    });
  },
  'POST /api/admin/keys': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { key: store.addApiKey(store.defaultUser()) });
  },
  // App passwords (docs/app-passwords.md). Canonical body is
  // {domain, address, protocols[], label}; the older {username} form still works and
  // means "this one address, IMAP only".
  'GET /api/admin/app-passwords': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { appPasswords: store.appPasswords(store.defaultUser()) });
  },
  'POST /api/admin/app-passwords': async (req, res, raw) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const body = JSON.parse(raw.toString() || '{}');
    const legacy = !body.domain && typeof body.username === 'string';
    const parsed = legacy ? splitAddress(body.username) : { local: null, domain: null };
    const d = String(legacy ? parsed.domain : (body.domain || '')).toLowerCase();
    if (!d || !store.domains().includes(d)) {
      return json(res, 400, { error: `domain not hosted here: ${d || '(none)'}`, code: 'bad_domain' });
    }
    const pattern = normalizePattern(legacy ? parsed.local : (body.address ?? '*'), d);
    if (!pattern) {
      return json(res, 400, { error: `invalid address pattern: ${body.address ?? body.username}`, code: 'bad_address' });
    }
    const protos = [...new Set(legacy ? ['imap'] : (body.protocols || ['imap']))]
      .filter((p) => p === 'imap' || p === 'api');
    if (!protos.length) return json(res, 400, { error: 'pick at least one kind of access (imap, api)', code: 'bad_protocols' });
    const label = body.label || null;
    const { id, secret } = store.addAppPassword({
      domain: d, address: pattern, protocols: protos, label, userId: store.defaultUser(),
    });
    return json(res, 200, {
      id, domain: d, address: pattern, protocols: protos, label,
      secret, password: secret, username: `${pattern}@${d}`,  // password/username: legacy field names
    });
  },
  'GET /api/admin/messages': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const mailbox = q.get('mailbox') === 'Sent' ? 'Sent' : 'INBOX';
    const limit = Math.min(Number(q.get('limit')) || 50, 200);
    const beforeUid = q.get('before') ? Number(q.get('before')) : null;
    const u = store.defaultUser();
    const messages = store.listPaged(u, mailbox, { limit, beforeUid });
    return json(res, 200, { messages, nextBefore: messages.length === limit ? messages[messages.length - 1].uid : null });
  },
  'GET /api/admin/raw': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const bytes = store.raw(store.defaultUser(), q.get('mailbox') === 'Sent' ? 'Sent' : 'INBOX', Number(q.get('uid')));
    if (!bytes) return json(res, 404, { error: 'raw unavailable', code: 'no_raw' });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(bytes);
  },

});

// ---- mailbox REST API (user-trust: Bearer app password with `api` access) --------
// The address must be concrete and covered by the password — one scoped `*` still has
// to name which mailbox it's acting on, and reads are scoped to that address.
const mailboxAuth = (req, address) => {
  const secret = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!secret) return { error: 'missing bearer token', code: 'no_key', status: 401 };
  const { local, domain } = splitAddress(address);
  if (!local || !domain) return { error: 'address query parameter is required', code: 'bad_address', status: 400 };
  // A pattern is not a mailbox: `*@domain` names no inbox to read or write.
  if (local.includes('*')) {
    return { error: 'address must be one concrete mailbox, not a pattern', code: 'bad_address', status: 400 };
  }
  const hit = resolveAppPassword(secret, address, 'api');
  if (!hit) return { error: 'this app password does not grant API access to that address', code: 'forbidden', status: 403 };
  store.touchAppPassword(hit.row.id);
  return { hit };
};
const mailboxOf = (q) => (q.get('mailbox') === 'Sent' ? 'Sent' : 'INBOX');

Object.assign(routes, {
  'GET /api/mailbox/messages': async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const address = q.get('address');
    const auth = mailboxAuth(req, address);
    if (auth.error) return json(res, auth.status, { error: auth.error, code: auth.code });
    const limit = Math.min(Number(q.get('limit')) || 50, 200);
    const beforeUid = q.get('before') ? Number(q.get('before')) : null;
    const messages = store.listPagedForAddress(auth.hit.userId, mailboxOf(q), address, { limit, beforeUid });
    return json(res, 200, {
      address: address.toLowerCase(),
      mailbox: mailboxOf(q),
      messages,
      nextBefore: messages.length === limit ? messages[messages.length - 1].uid : null,
    });
  },
});

// Parameterized mailbox routes: /api/mailbox/messages/:uid/{raw,flags}.
const MAILBOX_UID_ROUTE = /^\/api\/mailbox\/messages\/(\d+)\/(raw|flags)$/;
async function handleMailboxUid(req, res, rawBody, match) {
  const uid = Number(match[1]);
  const leaf = match[2];
  const q = new URL(req.url, 'http://x').searchParams;
  const body = rawBody?.length ? JSON.parse(rawBody.toString()) : {};
  const address = q.get('address') || body.address;
  const auth = mailboxAuth(req, address);
  if (auth.error) return json(res, auth.status, { error: auth.error, code: auth.code });
  const mailbox = body.mailbox === 'Sent' ? 'Sent' : mailboxOf(q);

  if (leaf === 'raw') {
    if (req.method !== 'GET') return json(res, 405, { error: 'use GET', code: 'bad_method' });
    const bytes = store.rawForAddress(auth.hit.userId, mailbox, address, uid);
    if (!bytes) return json(res, 404, { error: 'no such message for that address', code: 'no_raw' });
    res.writeHead(200, { 'content-type': 'message/rfc822' });
    return res.end(bytes);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'use POST', code: 'bad_method' });
  const ok = store.setFlagsForAddress(auth.hit.userId, mailbox, address, uid, String(body.flags ?? ''));
  if (!ok) return json(res, 404, { error: 'no such message for that address', code: 'no_message' });
  return json(res, 200, { ok: true, uid, flags: String(body.flags ?? '') });
}

// ---- static UI ----------------------------------------------------------------
// Serves ui/dist when present (built SPA); the UI calls the admin API same-origin.
import { readFileSync as readFs, existsSync as existsFs } from 'node:fs';
import { join as joinPath, normalize } from 'node:path';
const UI_DIR = process.env.UI_DIR || new URL('../ui/dist', import.meta.url).pathname;
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2', json: 'application/json' };
function serveUi(req, res) {
  if (req.method !== 'GET' || !existsFs(UI_DIR)) return false;
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = joinPath(UI_DIR, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(UI_DIR)) return false;
  if (!existsFs(file)) file = joinPath(UI_DIR, 'index.html'); // SPA fallback
  try {
    const body = readFs(file);
    // index.html must never be cached: a stale copy points at asset hashes this build
    // no longer has, so the app silently runs (or fails as) an old version after a
    // deploy. Hashed assets are immutable by construction, so cache them hard.
    const isHtml = file.endsWith('.html');
    res.writeHead(200, {
      'content-type': MIME[file.split('.').pop()] || 'application/octet-stream',
      'cache-control': isHtml ? 'no-store, must-revalidate' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
    return true;
  } catch { return false; }
}

// The table is exact-path; the few routes with an id in the path are matched here.
const PARAM_ROUTES = [
  { rx: MAILBOX_UID_ROUTE, handler: handleMailboxUid },
  {
    rx: /^\/api\/admin\/app-passwords\/(\d+)$/,
    handler: async (req, res, _raw, match) => {
      if (req.method !== 'DELETE') return json(res, 405, { error: 'use DELETE', code: 'bad_method' });
      if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
      return store.deleteAppPassword(Number(match[1]))
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: 'no such app password', code: 'not_found' });
    },
  },
];

const handle = async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const handler = routes[`${req.method} ${pathname}`];
  let param = null;
  if (!handler) {
    for (const r of PARAM_ROUTES) {
      const m = r.rx.exec(pathname);
      if (m) { param = { handler: r.handler, match: m }; break; }
    }
  }
  if (!handler && !param) {
    if (serveUi(req, res)) return;
    return json(res, 404, { error: 'not found' });
  }
  try {
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    if (param) await param.handler(req, res, raw, param.match);
    else await handler(req, res, raw);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};

// Native TLS (optional): set TLS_CERT + TLS_KEY to serve HTTPS directly — no reverse
// proxy needed for a single-box install.
const TLS_CERT = process.env.TLS_CERT, TLS_KEY = process.env.TLS_KEY;
let server, scheme;
if (TLS_CERT && TLS_KEY) {
  const { createServer: createHttps } = await import('node:https');
  const { readFileSync: rf } = await import('node:fs');
  server = createHttps({ cert: rf(TLS_CERT), key: rf(TLS_KEY) }, handle);
  scheme = 'https';
} else {
  server = createServer(handle);
  scheme = 'http';
}

// Retry scanner for webhook deliveries that didn't land on the first try.
startScanner(store, Number(process.env.WEBHOOK_SCAN_MS || 30_000));

server.listen(PORT, HOST, () => {
  console.log(`api-local listening on ${scheme}://${HOST}:${PORT} (data: ${DATA_DIR})`);
  if (unclaimed()) {
    console.log('setup: no admin configured — the first email entered on the web console claims this install (recover with: cli.mjs reset-admin <email>)');
  } else if (setupOwed()) {
    console.log('setup: sign-in method not chosen yet — finish setup in the web console (docs/auth-setup.md)');
  } else {
    console.log(`sign-in: ${effectiveAuth().method} (${effectiveAuth().source})`);
  }
});
