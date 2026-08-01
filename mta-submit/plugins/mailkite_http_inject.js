'use strict';

// Docs: docs/architecture/mailkite-provider.md
//
// HTTP→outbound bridge — accepts RFC822 from the CF Worker via HTTP POST and injects
// it into Haraka's outbound queue via outbound.send_email(). The Worker's
// MailKiteEmailProvider.send() calls this endpoint; this plugin DKIM-signs the
// message (relaxed/relaxed, private key on the VPS), then Haraka does MX lookup,
// SMTP delivery, retries, and bounce handling.
//
// DKIM signing lives HERE (not the dkim plugin) because outbound.send_email()
// BYPASSES the queue_outbound hook where haraka-plugin-dkim would normally sign.
// We keep the private key on the VPS and sign directly in sign_dkim(). Key layout
// (haraka-plugin-dkim dir format): config/dkim/<domain>/private + /selector.
//
// ONE FILE, EVERY BOX. This plugin previously existed as two divergent copies — the repo's
// (mailn: parent-signing) and an UNTRACKED fork living only on the mailk box (per-subdomain
// signing, 3-arg sign_dkim). They differed solely in how a free-subdomain pool maps a From
// domain onto a DKIM identity, so that difference is now CONFIG, not code:
//
//   [dkim] pool_base + mode   (see resolve_dkim_identity)
//     mode=parent   every <sub>.<base> signs as d=<base>, one key at config/dkim/<base>/.
//                   No per-sub DKIM record needed. DMARC still aligns (relaxed).
//     mode=per_sub  <sub>.<base> signs as d=<sub>.<base> using the SHARED key at
//                   config/dkim/<base>/, published per-sub at <selector>._domainkey.<sub>.
//                   Each sub gets its own reputation, so one abusive sub can't burn the
//                   whole pool.
//     mode=none     no pool mapping; sign d=<From domain> with its own key dir. (default)
//
// Senders OUTSIDE the configured pool are always signed with their own domain and key dir,
// whatever the mode.
//
// Bump PLUGIN_VERSION on any change and check GET /health on every box — "all boxes run the
// same code" is meant to be verifiable, not assumed.
//
// This plugin runs on the EXISTING mta-submit/ instance alongside the SMTP submission
// plugins (auth_mailkite, mailkite_relay). The two entry points are independent:
//   • SMTP :587/:465 → auth_mailkite → mailkite_relay → Worker /api/relay
//   • HTTP :8080     → mailkite_http_inject → DKIM-sign → outbound.send_email() → delivery
//
// Critical: outbound.send_email() BYPASSES hook_queue plugins, so mailkite_relay
// never fires on the HTTP inject path. No loop is possible.
//
// Config (config/mailkite.ini, with env overrides):
//   [http_inject]
//   listen=127.0.0.1          bind address (loopback only — never expose publicly)
//   port=8080                 HTTP port
//   timeout_ms=5000           HMAC verification timeout
//
//   [main]
//   hmac_secret=              prefer env MAILKITE_HMAC_SECRET

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Bump on every change. Exposed at GET /health so box drift is visible, not inferred. */
const PLUGIN_VERSION = '2026.07.30-1';
exports.PLUGIN_VERSION = PLUGIN_VERSION;

let outbound;

exports.register = function () {
  outbound = this.haraka_require('outbound');
  this.dkim_keys = {}; // domain → { selector, private_key }
  this.load_cfg();
};

// Start the HTTP server ONLY in the master process. Haraka forks worker processes
// that also load plugins — if we start the server in register(), the worker tries
// to bind the same port and gets EADDRINUSE.
exports.hook_init_master = function (next) {
  this.start_http_server();
  next();
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const main = cfg.main || {};
  const inject = cfg.http_inject || {};
  this.hmac_secret = process.env.MAILKITE_HMAC_SECRET || main.hmac_secret;
  this.listen = inject.listen || '127.0.0.1';
  this.port = Number(inject.port) || 8080;
  this.timeout_ms = Number(inject.timeout_ms) || 5000;
  if (!this.hmac_secret) this.logerror('mailkite_http_inject: no hmac_secret configured');

  // Free-subdomain pool → DKIM identity mapping. This is the ONLY thing that used to differ
  // between the mailn copy and the mailk fork; see the header comment.
  const dkimCfg = cfg.dkim || {};
  this.pool_base = (dkimCfg.pool_base || '').trim().toLowerCase() || null;
  this.dkim_mode = (dkimCfg.mode || 'none').trim().toLowerCase();
  if (!['parent', 'per_sub', 'none'].includes(this.dkim_mode)) {
    this.logerror(`mailkite_http_inject: unknown [dkim] mode "${this.dkim_mode}" — falling back to "none"`);
    this.dkim_mode = 'none';
  }
  // A pool box with no mode configured would silently sign every sub with its own (missing)
  // key dir and send unsigned. Say so loudly at startup rather than per message.
  if (this.pool_base && this.dkim_mode === 'none') {
    this.logerror(`mailkite_http_inject: [dkim] pool_base=${this.pool_base} but mode=none — pool senders will look for a per-domain key dir and may send UNSIGNED`);
  }
  this.loginfo(`mailkite_http_inject: v${PLUGIN_VERSION} dkim mode=${this.dkim_mode} pool_base=${this.pool_base || '(none)'}`);

  // DNSBL lookups for the Worker (POST /rbl). Zones and test points are configurable so
  // swapping Spamhaus for another operator (Abusix etc.) is config, not code.
  const rbl = cfg.rbl || {};
  this.rbl_zone_ip = rbl.zone_ip || 'zen.spamhaus.org';
  this.rbl_zone_domain = rbl.zone_domain || 'dbl.spamhaus.org';
  this.rbl_canary_listed_ip = rbl.canary_listed_ip || '127.0.0.2';   // always listed in zen
  this.rbl_canary_clean_ip = rbl.canary_clean_ip || '127.0.0.1';     // never listed in zen
  // Spamhaus's DOCUMENTED dbl test point is `dbltest.com` (→ 127.0.1.2). Do NOT use
  // `dbl.spamhaus.org` here: it returns NXDOMAIN, so the canary would fail permanently and
  // collapse every verdict to unknown. Verified live against the zone on 2026-07-30.
  this.rbl_canary_listed_domain = rbl.canary_listed_domain === '' ? null
    : (rbl.canary_listed_domain || 'dbltest.com');
  // Empty → inherit the system resolver from /etc/resolv.conf. Set to 127.0.0.1 when a
  // local unbound is installed; a PUBLIC resolver here gets us refused (see §/rbl below).
  this.rbl_resolvers = String(rbl.resolvers || '').split(',').map((s) => s.trim()).filter(Boolean);
  this.rbl_timeout_ms = Number(rbl.timeout_ms) || 2000;
  this.rbl_max_targets = Number(rbl.max_targets) || 24;
  this.rbl_concurrency = Number(rbl.concurrency) || 8;
};

// ---- DKIM signing (relaxed/relaxed) ------------------------------------------------
// The dkim plugin signs in the `queue_outbound` hook, which outbound.send_email()
// BYPASSES — so we sign here, directly, keeping the private key on the VPS.
// Key layout (haraka-plugin-dkim dir format): config/dkim/<domain>/private + /selector

exports.load_dkim_key = function (domain) {
  if (this.dkim_keys[domain]) return this.dkim_keys[domain];
  const dir = path.join(__dirname, '..', 'config', 'dkim', domain);
  try {
    const private_key = fs.readFileSync(path.join(dir, 'private'), 'utf8');
    const selector = fs.readFileSync(path.join(dir, 'selector'), 'utf8').trim();
    if (!private_key || !selector) throw new Error('incomplete');
    this.dkim_keys[domain] = { private_key, selector };
  } catch (e) {
    this.logerror(`mailkite_http_inject: dkim load error for ${domain}: ${e.message}`);
    this.dkim_keys[domain] = null; // negative cache
  }
  return this.dkim_keys[domain];
};

function relaxed_body_hash(bodyStr, sep) {
  let lines = bodyStr.split(sep);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const canon = lines
    .map((l) => l.replace(/\s+$/, '').replace(/\s+/g, ' '))
    .join('\r\n');
  const to_hash = canon === '' ? '' : canon + '\r\n';
  return crypto.createHash('sha256').update(to_hash).digest('base64');
}

function relaxed_header(name, value, sep) {
  const v = value.replace(new RegExp(sep, 'g'), '').replace(/\s+/g, ' ').trim();
  return name.toLowerCase() + ':' + v;
}

/**
 * Map a From domain onto the DKIM identity to sign with.
 *
 * Returns `{ signDomain, keyDomain }` — the `d=` tag and the key directory to load, which are
 * NOT always the same. That split is the whole reason the two box variants existed:
 *
 *   parent   sub.pool-b.example → d=pool-b.example,     key=pool-b.example     (one identity for the pool)
 *   per_sub  sub.pool-a.example  → d=sub.pool-a.example,  key=pool-a.example      (own identity, shared key)
 *   none     anything      → d=<from>,        key=<from>
 *
 * Pure and exported so both modes are unit-tested without a live Haraka.
 */
exports.resolve_dkim_identity = function (fromDomain) {
  const from = (fromDomain || '').toLowerCase();
  const base = this.pool_base;
  const inPool = !!base && (from === base || from.endsWith(`.${base}`));
  if (!inPool) return { signDomain: from, keyDomain: from };
  if (this.dkim_mode === 'parent') return { signDomain: base, keyDomain: base };
  if (this.dkim_mode === 'per_sub') return { signDomain: from, keyDomain: base };
  return { signDomain: from, keyDomain: from };
};

// Returns the DKIM-Signature header (without CRLF) or null if no key for the domain.
// `domain` is the d= tag; `keyDomain` is the key dir to load it from (defaults to `domain`).
exports.sign_dkim = function (raw, domain, keyDomain) {
  const key = this.load_dkim_key(keyDomain || domain);
  if (!key) return null;

  // Detect line ending (Worker sends CRLF; be tolerant of bare LF).
  const sep = raw.includes('\r\n\r\n') ? '\r\n' : '\n';
  const idx = raw.indexOf(sep + sep);
  if (idx === -1) {
    this.logerror(`mailkite_http_inject: no header/body separator in message for ${domain}`);
    return null;
  }
  const header_block = raw.slice(0, idx);
  const body = raw.slice(idx + sep.length * 2);

  const bh = relaxed_body_hash(body, sep);

  // Parse headers (case-insensitive) preserving order.
  const header_lines = header_block.split(sep);
  const header_map = {};
  for (const line of header_lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) header_map[m[1].toLowerCase()] = m[2];
  }

  // Signed headers — From is mandatory. Order matters for `h=`.
  const want = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type'];
  const signed = want.filter((h) => header_map[h] !== undefined);
  if (!signed.includes('from')) return null;

  const header_canon = signed.map((h) => relaxed_header(h, header_map[h], sep)).join('\r\n');

  const dkim_hdr =
    `v=1;a=rsa-sha256;c=relaxed/relaxed;d=${domain};s=${key.selector};` +
    `h=${signed.join(':')};bh=${bh};b=`;

  const signable = `${header_canon}\r\n${relaxed_header('dkim-signature', dkim_hdr, sep)}`;
  const sig = crypto.createSign('RSA-SHA256').update(signable).sign(key.private_key, 'base64');

  return `DKIM-Signature: ${dkim_hdr}${sig}`;
};

exports.start_http_server = function () {
  const plugin = this;
  const server = http.createServer((req, res) => plugin.handle_request(req, res));
  server.listen(this.port, this.listen, () => {
    plugin.loginfo(`mailkite_http_inject: listening on ${plugin.listen}:${plugin.port}`);
  });
  server.on('error', (e) => {
    plugin.logerror(`mailkite_http_inject: server error ${e.message}`);
  });
};

exports.handle_request = function (req, res) {
  const plugin = this;

  // Health check. Reports the running version + the DKIM mode so a box that has drifted from
  // the repo (which is how an untracked fork lived on mailk for months) is visible from
  // outside, without SSH.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      version: PLUGIN_VERSION,
      dkim: { mode: plugin.dkim_mode, poolBase: plugin.pool_base },
      rbl: { zoneIp: plugin.rbl_zone_ip, zoneDomain: plugin.rbl_zone_domain, resolvers: plugin.rbl_resolvers },
    }));
  }

  // Only accept POST /send and POST /rbl.
  const route = req.method === 'POST' && (req.url === '/send' || req.url === '/rbl') ? req.url : null;
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  // Collect body.
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.once('end', () => {
    const raw = Buffer.concat(chunks);
    if (route === '/rbl') return plugin.process_rbl(req, res, raw);
    return plugin.process_send(req, res, raw);
  });
  req.once('error', (e) => {
    plugin.logerror(`mailkite_http_inject: body read error ${e.message}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'body read error' }));
  });
};

// Verify the Worker's HMAC over `${ts}.${rawBody}`. Returns null when the request is
// authentic, else { code, error } for the caller to write back. Shared by /send and /rbl
// so there is exactly one implementation of the constant-time compare and replay window.
//
// The Worker sends the ts in a header (x-mailkite-ts) and the digest in Authorization,
// because the digest alone doesn't carry the ts we need to recompute it.
exports.verify_hmac = function (req, raw) {
  if (!this.hmac_secret) return { code: 503, error: 'hmac_secret not configured' };

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { code: 401, error: 'missing authorization' };

  const ts = Number(req.headers['x-mailkite-ts']);
  if (!Number.isFinite(ts)) return { code: 401, error: 'missing or invalid x-mailkite-ts header' };

  // Replay protection.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 300) return { code: 401, error: 'timestamp expired' };

  const expected = crypto.createHmac('sha256', this.hmac_secret)
    .update(`${ts}.`)
    .update(raw)
    .digest('hex');

  // Constant-time compare.
  if (expected.length !== token.length) return { code: 401, error: 'invalid signature' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  if (diff !== 0) return { code: 401, error: 'invalid signature' };

  return null;
};

exports.process_send = async function (req, res, raw) {
  const plugin = this;

  const bad = plugin.verify_hmac(req, raw);
  if (bad) {
    res.writeHead(bad.code, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: bad.error }));
  }

  // Extract envelope from headers.
  const from = req.headers['x-mailkite-mailfrom'] || '';
  const rcptHeader = req.headers['x-mailkite-rcpt'] || '';
  const rcpts = rcptHeader.split(',').map((s) => s.trim()).filter(Boolean);

  if (!from) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing x-mailkite-mailfrom header' }));
  }
  if (!rcpts.length) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing x-mailkite-rcpt header' }));
  }

  // Determine the DKIM-signing domain from the From header in the RFC822.
  // Extract the email from the From HEADER LINE only — handle both
  // `From: Name <addr>` and `From: addr`. (Must not cross into later headers:
  // a greedy `[^<]*` would swallow the From address and everything up to the
  // first `<` in the message — e.g. the `<` in `Message-ID: <uuid@…>` — and
  // capture the wrong domain. That signed DKIM as the Message-ID domain.)
  const rawStr = raw.toString('utf8');
  const fromLine = rawStr.match(/(?:^|\r\n)From:\s*[^\r\n]*/i);
  let fromDomain = null;
  if (fromLine) {
    const fl = fromLine[0];
    const angle = fl.match(/<([^>]+)>/);
    const addr = angle ? angle[1] : fl.replace(/^.*?From:\s*/i, '').trim();
    const m = addr.match(/([^@\s]+@[^\s>]+)/);
    fromDomain = m ? m[1].split('@')[1].toLowerCase() : null;
  }
  if (!fromDomain) plugin.logerror('mailkite_http_inject: could not parse From domain — skipping DKIM');

  // Sign DKIM (relaxed/relaxed) — keeps the private key on the VPS. The pool mapping (parent
  // vs per-subdomain identity) is config, see resolve_dkim_identity.
  let signedRaw = rawStr;
  if (fromDomain) {
    const { signDomain, keyDomain } = plugin.resolve_dkim_identity(fromDomain);
    const dkimHeader = plugin.sign_dkim(rawStr, signDomain, keyDomain);
    if (dkimHeader) {
      signedRaw = dkimHeader + '\r\n' + rawStr;
      plugin.loginfo(`mailkite_http_inject: DKIM-signed d=${signDomain} (key=${keyDomain})`);
    } else {
      plugin.logerror(`mailkite_http_inject: no DKIM key for ${keyDomain} — sending unsigned`);
    }
  }

  // Return 202 immediately — don't wait for delivery.
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, queued: true }));

  // Inject into outbound queue (fire-and-forget).
  outbound.send_email(from, rcpts, signedRaw, (code, msg) => {
    if (code === 906) { // constants.OK
      plugin.loginfo(`mailkite_http_inject: queued ${rcpts.join(',')} (${raw.length}b)`);
    } else {
      plugin.logerror(`mailkite_http_inject: queue failed code=${code} msg=${msg}`);
    }
  });
};

// ---- DNSBL lookups on behalf of the Worker (POST /rbl) -------------------------------
// Docs: docs/architecture/anti-spam.md §3 (Tier 1).
//
// WHY THIS LIVES ON THE BOX: Workers have no raw DNS, so the Worker previously queried
// Spamhaus over PUBLIC DoH (cloudflare-dns.com). Spamhaus REFUSES public/open resolvers —
// every answer came back 127.255.255.254 ("query via public resolver"), which the Worker's
// `startsWith('127.0.0.')` test read as NOT LISTED. Every lookup silently said "clean",
// including for an IP we knew was listed. This endpoint moves the query to a resolver we
// control, and returns a TRI-STATE so an unanswered query can never read as clean.
//
// Classification is by return code, not by "did we get an answer":
//   127.0.0.x / 127.0.1.x / 127.0.2.x  → listed (zen / dbl / zrd)
//   127.255.255.x                      → UNKNOWN — refused, prohibited, or over quota
//   NXDOMAIN / ENODATA                 → clean
//   SERVFAIL / timeout / anything else  → UNKNOWN
//
// The resolver this uses matters: if the box's /etc/resolv.conf points at a public
// resolver we get refused exactly as before. Set `[rbl] resolvers=127.0.0.1` with a local
// unbound, or leave unset to inherit the system resolver. Either way the CANARY tells us
// which situation we're in instead of leaving it to be inferred from suspiciously clean
// verdicts — a listed test point that reads clean fails the canary and forces every
// result in the response to `unknown`.

const dns = require('dns');

/** Map a set of A answers (or a resolver error) to listed | clean | unknown. */
function classify_rbl(addrs, err) {
  if (err) {
    // NXDOMAIN / no A record for the query name = not on the list.
    if (err.code === dns.NOTFOUND || err.code === 'ENOTFOUND' || err.code === 'ENODATA') return 'clean';
    return 'unknown'; // SERVFAIL, timeout, refused, network — never "clean"
  }
  if (!addrs || !addrs.length) return 'clean';
  // Any 127.255.255.x is a control code from the list operator, NOT a listing.
  if (addrs.some((a) => a.startsWith('127.255.255.'))) return 'unknown';
  if (addrs.some((a) => /^127\.0\.[012]\./.test(a))) return 'listed';
  // An answer outside both ranges means something is intercepting DNS (captive portal,
  // wildcard resolver). Treat as unknown rather than guessing.
  return 'unknown';
}

/** Reverse an IPv4 for DNSBL query form: 1.2.3.4 → 4.3.2.1 */
function reverse_ip(ip) {
  return ip.split('.').reverse().join('.');
}

// Exported for test/rbl.test.mjs — these two are the whole safety argument of this endpoint,
// so they are tested directly rather than through a live resolver.
exports.classify_rbl = classify_rbl;
exports.reverse_ip = reverse_ip;

exports.rbl_lookup = async function (name) {
  const resolver = new dns.promises.Resolver({ timeout: this.rbl_timeout_ms, tries: 1 });
  if (this.rbl_resolvers.length) resolver.setServers(this.rbl_resolvers);
  try {
    const addrs = await resolver.resolve4(name);
    return classify_rbl(addrs, null);
  } catch (e) {
    return classify_rbl(null, e);
  }
};

// Run `fn` over `items` with at most `limit` in flight.
async function map_limited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Prove the resolver is actually being answered by this list operator.
 *
 * Two probes with known-opposite expected verdicts: a test point that MUST be listed and
 * one that MUST be clean. If they don't come back that way, our queries are being refused
 * or intercepted and every other verdict in this response is meaningless.
 */
exports.rbl_canary = async function () {
  const [listed, clean, domainListed] = await Promise.all([
    this.rbl_lookup(`${reverse_ip(this.rbl_canary_listed_ip)}.${this.rbl_zone_ip}`),
    this.rbl_lookup(`${reverse_ip(this.rbl_canary_clean_ip)}.${this.rbl_zone_ip}`),
    this.rbl_canary_listed_domain
      ? this.rbl_lookup(`${this.rbl_canary_listed_domain}.${this.rbl_zone_domain}`)
      : Promise.resolve('listed'),
  ]);
  const ok = listed === 'listed' && clean === 'clean' && domainListed === 'listed';
  return { ok, probes: { listed, clean, domainListed } };
};

exports.process_rbl = async function (req, res, raw) {
  const plugin = this;

  const bad = plugin.verify_hmac(req, raw);
  if (bad) {
    res.writeHead(bad.code, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: bad.error }));
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'body is not valid JSON' }));
  }

  const hosts = (Array.isArray(body.hosts) ? body.hosts : [])
    .filter((h) => typeof h === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h))
    .map((h) => h.toLowerCase())
    .slice(0, plugin.rbl_max_targets);
  const ips = (Array.isArray(body.ips) ? body.ips : [])
    .filter((ip) => typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
    .slice(0, plugin.rbl_max_targets);

  const started = Date.now();
  const [canary, hostVerdicts, ipVerdicts] = await Promise.all([
    plugin.rbl_canary(),
    map_limited(hosts, plugin.rbl_concurrency, (h) => plugin.rbl_lookup(`${h}.${plugin.rbl_zone_domain}`)),
    map_limited(ips, plugin.rbl_concurrency, (ip) => plugin.rbl_lookup(`${reverse_ip(ip)}.${plugin.rbl_zone_ip}`)),
  ]);

  // A failed canary invalidates the whole batch — report unknown rather than a verdict we
  // have no reason to trust.
  const collapse = (v) => (canary.ok ? v : 'unknown');
  const result = {
    canary: canary.ok ? 'ok' : 'failed',
    canaryProbes: canary.probes,
    hosts: Object.fromEntries(hosts.map((h, i) => [h, collapse(hostVerdicts[i])])),
    ips: Object.fromEntries(ips.map((ip, i) => [ip, collapse(ipVerdicts[i])])),
    zones: { ip: plugin.rbl_zone_ip, domain: plugin.rbl_zone_domain },
    tookMs: Date.now() - started,
  };

  if (!canary.ok) {
    plugin.logerror(
      `mailkite_http_inject: RBL canary FAILED (${JSON.stringify(canary.probes)}) — ` +
      `resolver ${plugin.rbl_resolvers.join(',') || 'system'} is not being answered by ` +
      `${plugin.rbl_zone_ip}; all verdicts downgraded to unknown`
    );
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
};
