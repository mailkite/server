'use strict';

// mailkite_ingest — the entire business logic of the MX edge.
//
// On Haraka's `queue` hook, stream the accepted message's raw RFC822 bytes and POST
// them (HMAC-signed) to the MailKite Worker's `POST /api/ingest`. Everything else —
// MIME parsing, storage (D1+R2), route matching, webhook signing/delivery — lives in
// the Worker (api/), so this edge stays a dumb SMTP→HTTP pipe.
//
// On any non-2xx or network error we return DENYSOFT: the sender retries later and
// Haraka holds the message, so a brief ingest outage never loses mail.
//
// Config (config/mailkite.ini, with env overrides so secrets never touch disk):
//   [main]
//   ingest_url = https://api.mailkite.dev/api/ingest
//   hmac_secret = ...            ; prefer env MAILKITE_HMAC_SECRET
//   timeout_ms = 10000
// Env overrides: MAILKITE_INGEST_URL, MAILKITE_HMAC_SECRET, MAILKITE_INGEST_TIMEOUT_MS

const crypto = require('crypto');
const { Writable } = require('stream');

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
  if (!this.ingest_url) this.logerror('mailkite_ingest: no ingest_url configured');
  if (!this.hmac_secret) this.logerror('mailkite_ingest: no hmac_secret configured');
};

exports.hook_queue = function (next, connection) {
  const plugin = this;
  const txn = connection && connection.transaction;
  if (!txn) return next(DENYSOFT, 'no transaction');
  if (!plugin.ingest_url || !plugin.hmac_secret) {
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
  return v;
};

exports.post_to_ingest = function (connection, txn, raw, next) {
  const plugin = this;
  const ts = Math.floor(Date.now() / 1000);
  // HMAC-SHA256(secret, `${ts}.` ++ raw) — matches verifyIngestSignature() in api/.
  const sig = crypto.createHmac('sha256', plugin.hmac_secret)
    .update(`${ts}.`)
    .update(raw)
    .digest('hex');

  // Haraka Address: .address may be a method or a string depending on version.
  const addrStr = (a) => {
    if (!a) return '';
    if (typeof a.address === 'function') return a.address();
    if (typeof a.address === 'string') return a.address;
    return String(a);
  };
  const rcpts = (txn.rcpt_to || []).map(addrStr).join(',');
  const mailfrom = addrStr(txn.mail_from);

  const headers = {
    'content-type': 'message/rfc822',
    'x-mailkite-signature': `t=${ts},v1=${sig}`,
    'x-mailkite-rcpt': rcpts,
    'x-mailkite-mailfrom': mailfrom,
  };
  // Attach edge verdicts when present (the Worker reads these into the message row).
  const v = plugin.read_verdicts(connection, txn);
  if (v.spf) headers['x-mailkite-spf'] = v.spf;
  if (v.dkim) headers['x-mailkite-dkim'] = v.dkim;
  if (v.dmarc) headers['x-mailkite-dmarc'] = v.dmarc;
  if (v.spam) headers['x-mailkite-spam'] = v.spam;
  if (v.spamVerdict) headers['x-mailkite-spam-verdict'] = v.spamVerdict;

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

  fetch(plugin.ingest_url, { method: 'POST', headers, body: raw })
    .then((res) => {
      if (res.ok) {
        plugin.loginfo(`mailkite_ingest: accepted ${rcpts} (${raw.length}b) → ${res.status}`);
        return finish(OK); // Haraka marks the message delivered
      }
      plugin.logerror(`mailkite_ingest: ingest ${res.status} for ${rcpts}`);
      return finish(DENYSOFT, 'temporary ingest failure, please retry');
    })
    .catch((e) => {
      plugin.logerror(`mailkite_ingest: ${e.message}`);
      return finish(DENYSOFT, 'temporary ingest failure, please retry');
    });
};
