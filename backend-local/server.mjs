// backend-local — reference implementation of the backend contract (docs/contract.md).
// Node >= 22.5 (node:sqlite), zero npm dependencies.
//
// Implements: /api/ingest, /api/mx/accepted-domains, /api/smtp/auth, /api/relay,
// /api/imap/{auth,status,list,flags,raw}.
//
// Outbound scope (v1): /api/relay stores to Sent and loop-delivers to local domains.
// It does NOT deliver to the open internet — wire a smarthost or MailKite Cloud for
// real outbound (see README).
//
// Env: HMAC_SECRET (required), PORT (8787), HOST (127.0.0.1), DATA_DIR (./data)

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './lib/db.mjs';
import { headers, firstAddress, subject } from './lib/rfc822.mjs';

const SECRET = process.env.HMAC_SECRET || '';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
const MAX_BODY = 30 * 1024 * 1024; // a hair above the edges' 25 MB databytes
const DRIFT_S = 5 * 60;

if (!SECRET) { console.error('backend-local: HMAC_SECRET is required'); process.exit(1); }

const store = new Store(DATA_DIR);

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
// First boot with neither ADMIN_EMAIL nor any admin on record prints a one-time
// /setup URL to the log (the WordPress-install pattern: possession of the server
// log/console is the root credential).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const SEND_KEY = process.env.MAILKITE_SEND_KEY || '';
const MAGIC_FROM = process.env.MAGIC_LINK_FROM || '';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
if (ADMIN_EMAIL) store.addAdminUser(ADMIN_EMAIL);
let setupToken = (!ADMIN_EMAIL && store.adminUserCount() === 0)
  ? 'mk_setup_' + randomBytes(24).toString('base64url')
  : null;

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

async function deliverLink(email, url) {
  if (!SEND_KEY) {
    console.log(`magic-link: ${url}`); // greppable fallback: journalctl … | grep magic-link
    return;
  }
  const from = MAGIC_FROM || `no-reply@${store.domains()[0] || 'localhost'}`;
  try {
    const r = await fetch('https://api.mailkite.dev/v1/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${SEND_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: email,
        subject: 'Sign in to MailKite Server',
        text: `Click to sign in to your MailKite Server console:\n\n${url}\n\nThe link works once and expires in 15 minutes. If you didn't request it, ignore this email.`,
      }),
    });
    if (!r.ok) console.error(`magic-link: send failed (${r.status}) — falling back to log\nmagic-link: ${url}`);
  } catch (e) {
    console.error(`magic-link: send error (${e.message}) — falling back to log\nmagic-link: ${url}`);
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

const routes = {
  // ---- inbound ---------------------------------------------------------------
  'POST /api/ingest': async (req, res, raw) => {
    if (!verifyIngestSignature(req, raw)) return json(res, 401, { error: 'bad signature', code: 'bad_signature' });
    const rcpts = String(req.headers['x-mailkite-rcpt'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!rcpts.length) return json(res, 400, { error: 'no recipients', code: 'no_rcpt' });
    let stored = 0;
    let deduped = 0;
    // Idempotent by (recipient, mailbox, content hash): a multi-backend edge tempfailing
    // on a sibling backend makes the sender retry — the re-delivery must not duplicate.
    const blobSha = Store.hashRaw(raw);
    for (const rcpt of rcpts) {
      const userId = store.userForDomain(rcpt.split('@')[1] || '');
      if (userId == null) continue; // not ours; RCPT gating should have caught it
      if (store.messageExists(userId, 'INBOX', blobSha, rcpt)) { deduped++; continue; }
      store.storeMessage(userId, 'INBOX', raw, metaFrom(raw, {
        to_addr: rcpt,
        mailfrom: req.headers['x-mailkite-mailfrom'] || '',
        rcpt: rcpt,
        spf: req.headers['x-mailkite-spf'], dkim: req.headers['x-mailkite-dkim'],
        dmarc: req.headers['x-mailkite-dmarc'], spam: req.headers['x-mailkite-spam'],
        spam_verdict: req.headers['x-mailkite-spam-verdict'],
      }));
      stored++;
    }
    return json(res, 200, { ok: true, stored, deduped });
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
    let local = 0;
    for (const rcpt of rcpts) {
      const rcptUser = store.userForDomain(rcpt.split('@')[1] || '');
      if (rcptUser != null) { store.storeMessage(rcptUser, 'INBOX', raw, metaFrom(raw, { to_addr: rcpt, mailfrom: meta.from_addr, rcpt })); local++; }
    }
    const external = rcpts.length - local;
    if (external > 0) console.warn(`relay: ${external} external recipient(s) NOT delivered (no smarthost in v1)`);
    return json(res, 200, { ok: true, localDelivered: local, externalSkipped: external });
  },

  // ---- IMAP read API -----------------------------------------------------------
  'POST /api/imap/auth': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { username, password, ip } = JSON.parse(raw.toString() || '{}');
    if (store.lockedOut(ip)) return json(res, 429, { ok: false, code: 'locked_out' });
    const hit = username && password ? store.checkAppPassword(username, password) : null;
    if (!hit) { store.authFail(ip); return json(res, 200, { ok: false, code: 'bad_credentials' }); }
    store.authOk(ip);
    return json(res, 200, { ok: true, userId: hit.userId, domain: hit.domain, mailboxId: hit.mailboxId });
  },

  'POST /api/imap/status': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox } = JSON.parse(raw.toString() || '{}');
    return json(res, 200, store.status(userId, mailbox));
  },

  'POST /api/imap/list': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox } = JSON.parse(raw.toString() || '{}');
    return json(res, 200, { messages: store.list(userId, mailbox) });
  },

  'POST /api/imap/raw': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, uid } = JSON.parse(raw.toString() || '{}');
    const bytes = store.raw(userId, mailbox, uid);
    if (!bytes) return json(res, 404, { error: 'raw unavailable', code: 'no_raw' });
    res.writeHead(200, { 'content-type': 'message/rfc822' });
    return res.end(bytes);
  },

  'POST /api/imap/flags': async (req, res, raw) => {
    if (!edgeAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { userId, mailbox, uid, flags } = JSON.parse(raw.toString() || '{}');
    store.setFlags(userId, mailbox, uid, String(flags || ''));
    return json(res, 200, { ok: true });
  },
};

// ---- console auth endpoints ------------------------------------------------------
Object.assign(routes, {
  // Always {ok:true} — no account enumeration. Rate-limited per IP (5 / 15 min).
  'POST /api/auth/request-link': async (req, res, raw) => {
    const ip = 'link:' + clientIp(req);
    if (store.lockedOut(ip, 5)) return json(res, 200, { ok: true });
    store.authFail(ip);
    const { email } = JSON.parse(raw.toString() || '{}');
    if (typeof email === 'string' && store.isAdminUser(email)) {
      const token = store.createLoginToken(email);
      await deliverLink(email.toLowerCase(), `${scheme}://${req.headers.host}/login#token=${token}`);
    }
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
  // First-boot only: consumes the one-time token printed to the server log.
  'POST /api/auth/setup': async (req, res, raw) => {
    const { token, email } = JSON.parse(raw.toString() || '{}');
    if (!setupToken || !token || !constEq(token, setupToken) || store.adminUserCount() > 0) {
      return json(res, 400, { error: 'Setup is not available — an admin already exists.', code: 'no_setup' });
    }
    if (!EMAIL_RE.test(email || '')) return json(res, 400, { error: 'Enter a valid email address.', code: 'bad_email' });
    setupToken = null;
    store.addAdminUser(email);
    setSessionCookie(res, store.createSession(email));
    return json(res, 200, { ok: true, email: email.toLowerCase() });
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
      inbox: store.status(u, 'INBOX'),
      sent: store.status(u, 'Sent'),
      capabilities: { inbound: true, imap: true, outboundLocal: true, outboundInternet: false, webhooks: false, routes: false },
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
  'GET /api/admin/credentials': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const u = store.defaultUser();
    return json(res, 200, { apiKeys: store.apiKeys(u), appPasswords: store.appPasswordUsers(u) });
  },
  'POST /api/admin/keys': async (req, res) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { key: store.addApiKey(store.defaultUser()) });
  },
  'POST /api/admin/app-passwords': async (req, res, raw) => {
    if (!adminAuthed(req)) return json(res, 401, { error: 'unauthorized' });
    const { username } = JSON.parse(raw.toString() || '{}');
    const domain = (username || '').split('@')[1] || '';
    if (!store.domains().includes(domain.toLowerCase())) {
      return json(res, 400, { error: `domain not hosted here: ${domain || '(none)'}`, code: 'bad_domain' });
    }
    return json(res, 200, { username, password: store.addAppPassword(username, store.defaultUser()) });
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
    res.writeHead(200, { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream' });
    res.end(body);
    return true;
  } catch { return false; }
}

const handle = async (req, res) => {
  const handler = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!handler) {
    if (serveUi(req, res)) return;
    return json(res, 404, { error: 'not found' });
  }
  try {
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    await handler(req, res, raw);
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

server.listen(PORT, HOST, () => {
  console.log(`backend-local listening on ${scheme}://${HOST}:${PORT} (data: ${DATA_DIR})`);
  if (setupToken) {
    const host = HOST === '::' || HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`setup: no admin configured — visit ${scheme}://${host}:${PORT}/setup#token=${setupToken} to claim this server (one-time link)`);
  }
});
