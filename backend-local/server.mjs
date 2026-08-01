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
import { createHmac, timingSafeEqual } from 'node:crypto';
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
    for (const rcpt of rcpts) {
      const userId = store.userForDomain(rcpt.split('@')[1] || '');
      if (userId == null) continue; // not ours; RCPT gating should have caught it
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
    return json(res, 200, { ok: true, stored });
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

const server = createServer(async (req, res) => {
  const handler = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    await handler(req, res, raw);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`backend-local listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`));
