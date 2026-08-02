'use strict';

// Docs: docs/architecture/smtp-relay.md
//
// Outbound submission bridge — the business logic of the submission edge. On Haraka's `queue`
// hook (post-DATA, after auth_mailkite set connection.relaying), stream the raw RFC822 and POST
// it to the Worker's POST /api/relay with the authenticated user's API key as Bearer. The Worker
// parses the MIME and runs it through the same send pipeline as POST /v1/send — so this edge
// stays a dumb SMTP→HTTP pipe, exactly like mailkite_ingest on the MX side.
//
// Result mapping (so SMTP clients get sane feedback):
//   2xx        → OK        (250 queued)
//   4xx        → DENY      (permanent — bad creds/From-domain/recipient; surface it to the client)
//   5xx / net  → DENYSOFT  (transient — client retries; no lost mail)
//
// Config (env first, then config/mailkite.ini [main]):
//   MAILKITE_API_URL / relay_url     base URL (+/api/relay) or explicit relay endpoint
//   MAILKITE_RELAY_TIMEOUT_MS        POST timeout (default 15000)

const { Writable } = require('stream');

exports.register = function () {
  this.load_cfg();
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for mailkite_relay');
  }
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const main = cfg.main || {};
  const base = process.env.MAILKITE_API_URL || main.api_url;
  this.relay_url = process.env.MAILKITE_RELAY_URL || main.relay_url ||
    (base ? base.replace(/\/+$/, '') + '/api/relay' : null);
  this.timeout_ms = Number(process.env.MAILKITE_RELAY_TIMEOUT_MS || main.relay_timeout_ms) || 15000;
  if (!this.relay_url) this.logerror('mailkite_relay: no relay_url configured');
};

exports.hook_queue = function (next, connection) {
  const plugin = this;
  const txn = connection && connection.transaction;
  if (!txn) return next(DENYSOFT, 'no transaction');
  // Defense in depth: never relay an unauthenticated submission (auth_mailkite sets both).
  if (!connection.relaying || !connection.notes.mailkite_key) {
    return next(DENY, 'authentication required');
  }
  if (!plugin.relay_url) return next(DENYSOFT, 'relay not configured');

  // message_stream needs a real Writable target (it sets line-ending / dot-stuffing options),
  // so pipe rather than attaching 'data'.
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  sink.once('finish', () => plugin.post_to_relay(connection, txn, Buffer.concat(chunks), next));
  sink.once('error', (e) => {
    plugin.logerror('mailkite_relay: stream error ' + e.message);
    next(DENYSOFT, 'temporary error, retry');
  });
  txn.message_stream.pipe(sink, {});
};

// CRITICAL: authenticated submissions are *relaying*, so Haraka fires `queue_outbound`
// (NOT `queue`). Without this, the plugin never runs and Haraka delivers the message
// itself, straight to the recipient's MX — which fails DMARC for the customer's domain
// (the VPS IP isn't an authorized sender) and bounces. Routing queue_outbound through the
// same handler makes us POST to /api/relay (DKIM-aligned send via Cloudflare) and return
// OK, which suppresses Haraka's own outbound delivery. Same handler, both hooks.
exports.hook_queue_outbound = exports.hook_queue;

exports.post_to_relay = function (connection, txn, raw, next) {
  const plugin = this;

  // Haraka Address: .address may be a method or a string depending on version.
  const addrStr = (a) => {
    if (!a) return '';
    if (typeof a.address === 'function') return a.address();
    if (typeof a.address === 'string') return a.address;
    return String(a);
  };
  // The full envelope RCPT TO list — the Worker derives Bcc from any recipient not named in
  // the visible To/Cc headers.
  const rcpts = (txn.rcpt_to || []).map(addrStr).join(',');

  let settled = false;
  const finish = (retval, msg) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    next(retval, msg);
  };
  const timer = setTimeout(() => {
    plugin.logerror('mailkite_relay: timeout after ' + plugin.timeout_ms + 'ms');
    finish(DENYSOFT, 'temporary relay failure, please retry');
  }, plugin.timeout_ms);

  fetch(plugin.relay_url, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      authorization: 'Bearer ' + connection.notes.mailkite_key,
      'x-mailkite-rcpt': rcpts,
    },
    body: raw,
  })
    .then(async (res) => {
      // ALWAYS drain the response body before returning. If we leave it unconsumed, undici
      // resets the connection on cleanup, which Cloudflare reads as a client abort and cancels
      // the Worker's waitUntil() background writes (the message + timeline persist) — even
      // though the awaited send already succeeded. Draining lets the request complete cleanly.
      const body = await res.text().catch(() => '');
      if (res.ok) {
        plugin.loginfo('mailkite_relay: sent ' + rcpts + ' (' + raw.length + 'b) → ' + res.status);
        return finish(OK);
      }
      // 4xx is the user's problem (unverified From-domain, suppressed/unverified recipient, bad
      // MIME) — reject permanently so the client surfaces it rather than retrying forever.
      if (res.status >= 400 && res.status < 500) {
        plugin.logerror('mailkite_relay: reject ' + res.status + ' ' + body);
        return finish(DENY, 'rejected: ' + (extractError(body) || res.status));
      }
      plugin.logerror('mailkite_relay: relay ' + res.status + ' ' + body);
      return finish(DENYSOFT, 'temporary relay failure, please retry');
    })
    .catch((e) => {
      plugin.logerror('mailkite_relay: ' + e.message);
      return finish(DENYSOFT, 'temporary relay failure, please retry');
    });
};

// Pull the human-readable message out of the Worker's JSON error body, if present.
function extractError(body) {
  try {
    const j = JSON.parse(body);
    return j && (j.error || j.code) ? String(j.error || j.code) : '';
  } catch {
    return '';
  }
}
