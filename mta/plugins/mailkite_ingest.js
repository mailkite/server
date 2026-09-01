'use strict';

// mailkite_ingest — the entire business logic of the MX edge.
//
// On Haraka's `queue` hook, stream the accepted message's raw RFC822 bytes and POST
// them (HMAC-signed) to the backend's `POST /api/ingest`. Everything else — MIME
// parsing, storage, route matching, webhook delivery — lives behind the backend
// contract, so this edge stays a dumb SMTP→HTTP pipe.
//
// Multi-backend (config/backends.json, spec: docs/multi-backend.md): recipients are
// grouped by the backend that claimed their domain at RCPT time (mailkite_rcpt records
// it on txn.notes); the raw message is POSTed once per owning backend — that backend's
// secret signs it and x-mailkite-rcpt carries only its recipients. All groups 2xx →
// OK; any failure → DENYSOFT (the sender retries; backends must dedupe on retry — the
// reference backend does). Without backends.json the plugin is byte-identical to the
// original single-backend behavior, including the MAILKITE_INGEST_URL override.
//
// Config (config/mailkite.ini, with env overrides so secrets never touch disk):
//   [main]
//   ingest_url = https://api.mailkite.dev/api/ingest
//   hmac_secret = ...            ; prefer env MAILKITE_HMAC_SECRET
//   timeout_ms = 10000
// Env overrides: MAILKITE_INGEST_URL, MAILKITE_HMAC_SECRET, MAILKITE_INGEST_TIMEOUT_MS

const crypto = require('crypto');
const path = require('path');
const { Writable } = require('stream');
const { parseBackendsConfig, getSharedRouter } = require(path.join(__dirname, '..', 'lib', 'backends.js'));

exports.register = function () {
  this.load_mailkite_ini();
  // fetch is global on Node 18+ (the image is Node 22); fail fast if somehow absent.
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for mailkite_ingest');
  }
};

exports.load_mailkite_ini = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_mailkite_ini());
  const main = cfg.main || {};
  this.ingest_url = process.env.MAILKITE_INGEST_URL || main.ingest_url;
  this.hmac_secret = process.env.MAILKITE_HMAC_SECRET || main.hmac_secret;
  this.timeout_ms = Number(process.env.MAILKITE_INGEST_TIMEOUT_MS || main.timeout_ms) || 10000;
  const plugin = this;
  const log = { info: (m) => plugin.loginfo(m), warn: (m) => plugin.logwarn(m), error: (m) => plugin.logerror(m) };
  const raw = this.config.get('backends.json', () => this.load_mailkite_ini());
  this.backends = parseBackendsConfig(raw, process.env, log);
  if (!this.backends.length && !this.ingest_url) this.logerror('mailkite_ingest: no ingest_url configured');
  if (!this.backends.length && !this.hmac_secret) this.logerror('mailkite_ingest: no hmac_secret configured');
};

exports.hook_queue = function (next, connection) {
  const plugin = this;
  const txn = connection && connection.transaction;
  if (!txn) return next(DENYSOFT, 'no transaction');
  if (!plugin.backends.length && (!plugin.ingest_url || !plugin.hmac_secret)) {
    return next(DENYSOFT, 'ingest not configured');
  }

  // Collect the raw message. message_stream needs a real Writable target (it sets
  // line-ending / dot-stuffing options), so pipe rather than attaching 'data'.
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  sink.once('finish', () => {
    const raw = Buffer.concat(chunks);
    plugin.post_to_ingest(connection, txn, raw, next);
  });
  sink.once('error', (e) => {
    plugin.logerror(`mailkite_ingest: stream error ${e.message}`);
    next(DENYSOFT, 'temporary error, retry');
  });
  txn.message_stream.pipe(sink, {});
};

// Read SPF/DKIM/DMARC/spam verdicts the upstream plugins (haraka-plugin-spf,
// haraka-plugin-dkim, haraka-plugin-rspamd) left on the connection/transaction.
// Defensive: any plugin may be disabled or change shape — only return what's present.
exports.read_verdicts = function (connection, txn) {
  const v = {};
  try {
    // SPF: the MAIL FROM result is stashed on txn.notes by haraka-plugin-spf.
    const spf = txn?.notes?.spf_mail_result ?? connection?.notes?.spf_helo;
    if (spf) v.spf = String(spf).toLowerCase();
  } catch { /* ignore */ }
  try {
    // DKIM: ResultStore entry has .pass (domain) or .fail.
    const dkim = txn?.results?.get?.('dkim');
    if (dkim) {
      if (Array.isArray(dkim.pass) ? dkim.pass.length : dkim.pass) v.dkim = 'pass';
      else if (Array.isArray(dkim.fail) ? dkim.fail.length : dkim.fail) v.dkim = 'fail';
    }
  } catch { /* ignore */ }
  try {
    const dmarc = txn?.results?.get?.('dmarc');
    if (dmarc?.result) v.dmarc = String(dmarc.result).toLowerCase();
  } catch { /* ignore */ }
  try {
    // rspamd: score + action (e.g. "no action", "add header", "reject").
    const rspamd = txn?.results?.get?.('rspamd');
    if (rspamd) {
      if (rspamd.score !== undefined && rspamd.score !== null) v.spam = String(rspamd.score);
      if (rspamd.action) v.spamVerdict = String(rspamd.action);
    }
  } catch { /* ignore */ }
  try {
    // DNSBL on the connecting IP, from our own mailkite_spam plugin (connect hook).
    // Tri-state: listed | clean | unknown, where `unknown` is NEVER `clean` — see
    // lib/dnsbl.js. Only a canary-verified verdict is forwarded; an unproven one is
    // indistinguishable from "we didn't check", which is exactly what the Worker must
    // read it as. The IP rides along so the Worker can record WHAT was scored.
    const bl = connection?.notes?.mailkite_dnsbl;
    if (bl && bl.canary && (bl.verdict === 'listed' || bl.verdict === 'clean')) {
      v.dnsbl = bl.verdict;
      if (bl.zone) v.dnsblZone = bl.zone;
    }
    const ip = connection?.remote?.ip;
    if (ip) v.remoteIp = String(ip);
    // Sender-domain blocklist (mailkite_spam data_post hook). Same canary rule as the IP zone:
    // an unproven verdict is indistinguishable from "we didn't check", so it isn't forwarded.
    const dbl = txn?.notes?.mailkite_dbl;
    if (dbl && dbl.canary && (dbl.verdict === 'listed' || dbl.verdict === 'clean')) {
      v.dbl = dbl.verdict;
    }
  } catch { /* ignore */ }
  return v;
};

// Group envelope recipients into per-backend delivery targets:
//   [{name, url (ingest endpoint), secret, rcpts: [addr,…]}]
// Single-backend mode returns exactly one target using ingest_url/hmac_secret, which
// keeps the request byte-identical to the pre-multi-backend plugin.
exports.delivery_targets = function (txn, rcpts) {
  const plugin = this;
  if (!plugin.backends.length) {
    return [{ name: 'default', url: plugin.ingest_url, secret: plugin.hmac_secret, rcpts }];
  }
  const byName = new Map(plugin.backends.map((b) => [b.name, b]));
  const noted = (txn && txn.notes && txn.notes.mailkite_backend_by_addr) || {};
  const router = getSharedRouter();
  const targets = new Map();
  const add = (backend, addr) => {
    if (!targets.has(backend.name)) {
      targets.set(backend.name, { name: backend.name, url: backend.ingestUrl, secret: backend.secret, rcpts: [] });
    }
    targets.get(backend.name).rcpts.push(addr);
  };
  for (const addr of rcpts) {
    let backend = byName.get(noted[addr]);
    if (!backend && router) backend = router.ownerOf(String(addr).split('@')[1] || '') || undefined;
    if (!backend) {
      // RCPT accepted it but no owner is resolvable now (e.g. cache turnover between
      // RCPT and DATA). Highest-priority backend is the least-wrong home.
      backend = plugin.backends[0];
      plugin.logwarn(`mailkite_ingest: no owner resolved for ${addr} — using "${backend.name}"`);
    }
    add(backend, addr);
  }
  return [...targets.values()];
};

exports.post_to_ingest = function (connection, txn, raw, next) {
  const plugin = this;
  const ts = Math.floor(Date.now() / 1000);

  // Haraka Address: .address may be a method or a string depending on version.
  const addrStr = (a) => {
    if (!a) return '';
    if (typeof a.address === 'function') return a.address();
    if (typeof a.address === 'string') return a.address;
    return String(a);
  };
  const rcpts = (txn.rcpt_to || []).map(addrStr).filter(Boolean);
  const mailfrom = addrStr(txn.mail_from);
  const verdicts = plugin.read_verdicts(connection, txn);

  const targets = plugin.delivery_targets(txn, rcpts);

  // Timeout via a settled-guard (AbortController isn't exposed in Haraka's plugin VM).
  let settled = false;
  const finish = (retval, msg) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    next(retval, msg);
  };
  const timer = setTimeout(() => {
    plugin.logerror(`mailkite_ingest: timeout after ${plugin.timeout_ms}ms`);
    finish(DENYSOFT, 'temporary ingest failure, please retry');
  }, plugin.timeout_ms);

  const postOne = (t) => {
    // HMAC-SHA256(secret, `${ts}.` ++ raw) — matches verifyIngestSignature() in the backend.
    const sig = crypto.createHmac('sha256', t.secret)
      .update(`${ts}.`)
      .update(raw)
      .digest('hex');
    const headers = {
      'content-type': 'message/rfc822',
      'x-mailkite-signature': `t=${ts},v1=${sig}`,
      'x-mailkite-rcpt': t.rcpts.join(','),
      'x-mailkite-mailfrom': mailfrom,
    };
    if (verdicts.spf) headers['x-mailkite-spf'] = verdicts.spf;
    if (verdicts.dkim) headers['x-mailkite-dkim'] = verdicts.dkim;
    if (verdicts.dmarc) headers['x-mailkite-dmarc'] = verdicts.dmarc;
    if (verdicts.spam) headers['x-mailkite-spam'] = verdicts.spam;
    if (verdicts.spamVerdict) headers['x-mailkite-spam-verdict'] = verdicts.spamVerdict;
    // Inbound spam SIGNALS (never a verdict the edge acted on) — the Worker scores them.
    if (verdicts.dnsbl) headers['x-mailkite-dnsbl'] = verdicts.dnsbl;
    if (verdicts.dnsblZone) headers['x-mailkite-dnsbl-zone'] = verdicts.dnsblZone;
    if (verdicts.dbl) headers['x-mailkite-dbl'] = verdicts.dbl;
    if (verdicts.remoteIp) headers['x-mailkite-remote-ip'] = verdicts.remoteIp;

    return fetch(t.url, { method: 'POST', headers, body: raw }).then((res) => {
      if (res.ok) {
        plugin.loginfo(`mailkite_ingest: ${t.name}: accepted ${t.rcpts.join(',')} (${raw.length}b) → ${res.status}`);
        return true;
      }
      plugin.logerror(`mailkite_ingest: ${t.name}: ingest ${res.status} for ${t.rcpts.join(',')}`);
      return false;
    }).catch((e) => {
      plugin.logerror(`mailkite_ingest: ${t.name}: ${e.message}`);
      return false;
    });
  };

  Promise.all(targets.map(postOne))
    .then((oks) => {
      if (oks.every(Boolean)) return finish(OK); // Haraka marks the message delivered
      return finish(DENYSOFT, 'temporary ingest failure, please retry');
    })
    .catch(() => finish(DENYSOFT, 'temporary ingest failure, please retry'));
};
