'use strict';

// Docs: docs/architecture/imap-access.md  (Phase 2 — the imap-core daemon)
//
// A thin IMAP server: imap-core handles the protocol (parsing, sequence→UID, SEARCH trees,
// IDLE), and these handlers fetch from the MailKite Worker read API (/api/imap/*). No mailbox
// store lives here — D1/R2 (via the Worker) is the source of truth. Read-mostly v1: LOGIN,
// LIST, SELECT/EXAMINE, STATUS, FETCH, SEARCH, STORE(flags); mutating folder ops are refused.
//
// Auth: the IMAP password is a scoped mk_imap_ app-password. onAuth POSTs it to
// /api/imap/auth (HMAC-Bearer = INGEST_SECRET); the Worker validates it + the domain gate and
// returns the account. The read endpoints are HMAC-trusted (the daemon passes the account it
// authenticated), mirroring the SMTP relay's edge-trust model.
//
// Config (env): MAILKITE_API_URL, MAILKITE_HMAC_SECRET (== the Worker's INGEST_SECRET),
// IMAP_PORT (993), IMAP_HOST (::), TLS_CERT / TLS_KEY (PEM paths).

const fs = require('fs');
const { IMAPServer, MemoryNotifier } = require('imap-core');

const API_URL = (process.env.MAILKITE_API_URL || 'https://api.mailkite.dev').replace(/\/+$/, '');
const HMAC = process.env.MAILKITE_HMAC_SECRET || '';
const PORT = Number(process.env.IMAP_PORT || 993);
const HOST = process.env.IMAP_HOST || '::';
// Hardening (open-issues): reap idle sockets, and cap concurrent connections per client IP.
const SOCKET_TIMEOUT = Number(process.env.IMAP_SOCKET_TIMEOUT_MS || 30 * 60 * 1000); // 30m idle → drop
const MAX_PER_IP = Number(process.env.IMAP_MAX_PER_IP || 10);
// Auth failures are appended here (ISO-timestamped) for fail2ban to tail. A dedicated file is more
// robust than fail2ban's systemd-journal reader (which doesn't reliably match this unit on Ubuntu).
const AUTH_LOG = process.env.IMAP_AUTH_LOG || `${__dirname}/auth-fail.log`;
function authFailLog(ip, user) {
  if (!ip) return; // no usable client IP → nothing for fail2ban to ban
  fs.appendFile(AUTH_LOG, `${new Date().toISOString()} imap auth failed user=${user} ip=${ip}\n`, () => {});
}
const TLS_CERT = process.env.TLS_CERT || `${__dirname}/config/tls/tls_cert.pem`;
const TLS_KEY = process.env.TLS_KEY || `${__dirname}/config/tls/tls_key.pem`;

if (!HMAC) { console.error('mailkite-imap: MAILKITE_HMAC_SECRET is required'); process.exit(1); }
if (typeof fetch !== 'function') { console.error('mailkite-imap: Node 18+ (global fetch) required'); process.exit(1); }

// v1 mailbox set. INBOX = inbound, Sent = outbound.
const MAILBOXES = ['INBOX', 'Sent'];

const logger = {
  info() {},
  debug() {},
  error: (...a) => console.error('[imap]', ...a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x)))),
};

// POST to the Worker read API with the edge HMAC. Returns the Response.
function api(path, body) {
  return fetch(API_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + HMAC },
    body: JSON.stringify(body),
  });
}

// IMAP flags are stored backslash-less ("Seen Flagged"); imap-core wants "\Seen".
const toImapFlags = (s) => (s || '').split(' ').filter(Boolean).map((f) => '\\' + f);
const fromImapFlags = (arr) => arr.map((f) => f.replace(/^\\/, '')).join(' ');

// Collect a stream into a Buffer. imap-core returns body/RFC822 FETCH literals as
// { type:'stream', value:<PassThrough>, expectedLength } — but our composer serializes with the
// SYNCHRONOUS compiler, which can't stream a literal (it emits "{undefined}[object Object]"). So we
// buffer each streamed literal and hand formatResponse a Buffer, which serializes as a proper {N}.
const streamToBuffer = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

// Build imap-core message objects (uid, flags[], date, modseq, [raw Buffer]) for a mailbox,
// optionally filtered to a UID set, optionally fetching the raw RFC822 (needed for FETCH/SEARCH
// of bodies/envelopes).
async function loadMessages(session, mailbox, uidSet, needRaw) {
  const res = await api('/api/imap/list', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox });
  if (!res.ok) throw new Error('list failed: ' + res.status);
  const { messages } = await res.json();
  const out = [];
  for (const m of messages) {
    if (uidSet && !uidSet.has(m.uid)) continue;
    // imap-core reads `internaldate` (not `date`) for the INTERNALDATE fetch item + Date formatting.
    const msg = { uid: m.uid, flags: toImapFlags(m.flags), internaldate: new Date(m.internaldate), modseq: m.uid };
    if (needRaw) {
      const rr = await api('/api/imap/raw', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox, uid: m.uid });
      msg.raw = rr.ok
        ? Buffer.from(await rr.arrayBuffer())
        // Pre-raw-storage message (received before raw was kept): synthesize a minimal envelope so
        // the client still shows the message rather than erroring.
        : Buffer.from(`From: ${m.from_addr}\r\nTo: ${m.to_addr}\r\nSubject: ${m.subject || ''}\r\nDate: ${new Date(m.internaldate).toUTCString()}\r\n\r\n`);
    }
    out.push(msg);
  }
  return out;
}

const server = new IMAPServer({
  secure: true,
  key: fs.readFileSync(TLS_KEY),
  cert: fs.readFileSync(TLS_CERT),
  id: { name: 'MailKite', vendor: 'MailKite' },
  socketTimeout: SOCKET_TIMEOUT, // imap-core reaps a socket idle this long (dead-connection hygiene)
  logger,
});
// Single-process notifier (no redis server needed). IDLE push of brand-new mail is limited in v1;
// clients re-fetch on NOOP/reconnect.
server.notifier = new MemoryNotifier({ folders: new Map() });

// Per-IP connection cap: imap-core adds each connection to server.connections (its own
// secureConnection handler runs first), so by the time this listener fires we can count existing
// connections from the same IP and drop the excess. A cheap tenant-isolation / abuse guard that
// complements the Worker-side auth lockout + VPS fail2ban.
server.server.on('secureConnection', (socket) => {
  const ip = socket.remoteAddress;
  // Stash the post-handshake IP on the socket — imap-core copies remoteAddress at construction and
  // it can be empty at onAuth time, so we read this stash instead.
  socket.__mkIp = (ip || '').replace(/^::ffff:/, '');
  let n = 0;
  for (const conn of server.connections) if (conn._socket && conn._socket.remoteAddress === ip) n++;
  if (n > MAX_PER_IP) {
    console.error(`[imap] conn cap: ${socket.__mkIp} has ${n} connections > ${MAX_PER_IP} — dropping`);
    socket.destroy();
  }
});

server.onAuth = function (login, session, cb) {
  // Use the IP stashed on the socket at handshake time (imap-core's own remoteAddress can be empty
  // here); fall back to the session fields, and strip the IPv4-mapped-IPv6 prefix.
  const ip =
    (session.socket && session.socket.__mkIp) ||
    (((session.socket && session.socket.remoteAddress) || session.remoteAddress || '')).replace(/^::ffff:/, '');
  // Forward the client IP so the Worker can lock out a brute-forcing IP (not the username → no
  // victim-DoS). On failure, emit a stable, parseable line for fail2ban to ban the IP at the network
  // layer: `imap auth failed ... ip=<ip>`.
  api('/api/imap/auth', { username: login.username, password: login.password, ip })
    .then(async (res) => {
      if (!res.ok) { console.error(`[imap] auth failed user=${login.username} ip=${ip} status=${res.status}`); authFailLog(ip, login.username); return cb(); }
      const j = await res.json().catch(() => ({}));
      if (!j.ok) { console.error(`[imap] auth failed user=${login.username} ip=${ip} code=${j.code || 'bad_credentials'}`); authFailLog(ip, login.username); return cb(); }
      // mailboxId scopes this session to one mailbox (API migration 0086). null = account-wide.
      // Echoed on every read/write call below so the API filters to that mailbox.
      cb(null, { user: { username: login.username, userId: j.userId, domain: j.domain, mailboxId: j.mailboxId ?? null } });
    })
    .catch((e) => { logger.error('auth', e.message); cb(); });
};

server.onList = function (query, session, cb) {
  cb(null, MAILBOXES.map((path) => ({ path, specialUse: path === 'Sent' ? '\\Sent' : undefined })));
};
server.onLsub = function (query, session, cb) { server.onList(query, session, cb); };
server.onSubscribe = (m, s, cb) => cb(null, true);
server.onUnsubscribe = (m, s, cb) => cb(null, true);

// SELECT / EXAMINE
server.onOpen = function (mailbox, session, cb) {
  if (!MAILBOXES.includes(mailbox)) return cb(null, 'NONEXISTENT');
  api('/api/imap/status', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox })
    .then(async (res) => {
      if (!res.ok) throw new Error('status failed: ' + res.status);
      const st = await res.json();
      const lr = await api('/api/imap/list', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox });
      const { messages } = await lr.json();
      cb(null, { specialUse: mailbox === 'Sent' ? '\\Sent' : undefined, uidValidity: st.uidvalidity, uidNext: st.uidnext, modifyIndex: 0, uidList: messages.map((m) => m.uid) });
    })
    .catch((e) => { logger.error('open', e.message); cb(e); });
};

server.onStatus = function (mailbox, session, cb) {
  if (!MAILBOXES.includes(mailbox)) return cb(null, 'NONEXISTENT');
  api('/api/imap/status', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox })
    .then(async (res) => {
      if (!res.ok) throw new Error('status failed: ' + res.status);
      const st = await res.json();
      cb(null, { messages: st.total, uidNext: st.uidnext, uidValidity: st.uidvalidity, unseen: st.unseen });
    })
    .catch((e) => { logger.error('status', e.message); cb(e); });
};

server.onFetch = function (mailbox, options, session, cb) {
  if (!MAILBOXES.includes(mailbox)) return cb(null, 'NONEXISTENT');
  loadMessages(session, mailbox, new Set(options.messages), true)
    .then(async (messages) => {
      if (options.markAsSeen) {
        for (const m of messages) {
          if (!m.flags.includes('\\Seen')) {
            m.flags.unshift('\\Seen');
            await api('/api/imap/flags', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox, uid: m.uid, flags: fromImapFlags(m.flags) });
          }
        }
      }
      for (const message of messages) {
        const values = session.getQueryResponse(options.query, message);
        // Resolve streamed literals (BODY[…]/RFC822) to Buffers so the synchronous composer emits a
        // valid {N} literal instead of "{undefined}[object Object]". Non-stream values pass through.
        const resolved = await Promise.all(values.map((v) => (v && v.type === 'stream' ? streamToBuffer(v.value) : v)));
        session.writeStream.write(session.formatResponse('FETCH', message.uid, {
          query: options.query,
          values: resolved,
        }));
      }
      cb(null, true);
    })
    .catch((e) => { logger.error('fetch', e.message); cb(e); });
};

server.onSearch = function (mailbox, options, session, cb) {
  if (!MAILBOXES.includes(mailbox)) return cb(null, 'NONEXISTENT');
  loadMessages(session, mailbox, null, true)
    .then((messages) => {
      const uidList = messages.filter((m) => session.matchSearchQuery(m, options.query)).map((m) => m.uid);
      cb(null, { uidList, highestModseq: 0 });
    })
    .catch((e) => { logger.error('search', e.message); cb(e); });
};

// STORE / UID STORE — flag updates.
server.onUpdate = function (mailbox, update, session, cb) {
  if (!MAILBOXES.includes(mailbox)) return cb(null, 'NONEXISTENT');
  loadMessages(session, mailbox, new Set(update.messages), false)
    .then(async (messages) => {
      for (const m of messages) {
        let flags = new Set(m.flags);
        if (update.action === 'set') flags = new Set(update.value);
        else if (update.action === 'add') update.value.forEach((f) => flags.add(f));
        else if (update.action === 'remove') update.value.forEach((f) => flags.delete(f));
        await api('/api/imap/flags', { userId: session.user.userId, mailboxId: session.user.mailboxId, mailbox, uid: m.uid, flags: fromImapFlags([...flags]) });
        if (!update.silent) {
          session.writeStream.write(session.formatResponse('FETCH', m.uid, { uid: update.isUid ? m.uid : false, flags: [...flags] }));
        }
      }
      cb(null, true);
    })
    .catch((e) => { logger.error('update', e.message); cb(e); });
};

// Read-mostly v1: refuse mutations of the mailbox structure / contents.
server.onCreate = (m, s, cb) => cb(null, 'CANNOT');
server.onRename = (m, n, s, cb) => cb(null, 'CANNOT');
server.onDelete = (m, s, cb) => cb(null, 'CANNOT');
server.onAppend = (m, f, d, r, s, cb) => cb(null, 'CANNOT');
server.onCopy = (m, u, s, cb) => cb(null, 'CANNOT');
server.onExpunge = (m, u, s, cb) => cb(null, true); // no-op: we don't delete

server.on('error', (e) => logger.error('server', e.message));
process.on('SIGINT', () => server.close(() => process.exit()));
process.on('SIGTERM', () => server.close(() => process.exit()));

server.listen(PORT, HOST, () => console.log(`mailkite-imap listening on [${HOST}]:${PORT}`));
