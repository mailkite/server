'use strict';

// mailkite_spam — inbound spam SIGNAL collection at the MX edge.
// Docs: docs/architecture/inbound-spam.md §3 (Layer 2).
//
// Looks the connecting IP up in a DNSBL on `connect` and stashes the tri-state verdict on
// connection.notes for mailkite_ingest to emit as `x-mailkite-dnsbl`. That is the one spam
// signal the Worker structurally cannot compute for itself: by the time a message reaches
// /api/ingest the TCP peer is our own edge, so the sender's IP has to be captured here.
//
// THIS PLUGIN CANNOT REJECT MAIL. There is no deny path in it — every hook calls `next()`
// with no arguments, on every branch including the error branches. That is deliberate and
// load-bearing, not an oversight:
//
//   Spam is a FLAG, never a gate (inbound-spam.md §1). A 5xx at SMTP time destroys the
//   message; a flag is reversible forever. Our customer is a program, not a person, and it
//   has context we don't — a signup endpoint, a support inbox and an agent triaging leads
//   want three different thresholds, so any threshold we enforce is wrong for two of them.
//   We hand over the verdict and the reasons; the consumer decides.
//
// If you are here to add a reject: don't. Add a weight in api/src/lib/spam-flag.ts instead,
// and let the consumer act on the score.
//
// Fails open in every direction: no config, a dead zone, a refused resolver, or a thrown
// error all yield `unknown` (never `clean`) and mail flows exactly as it did before.
//
// Config — config/mailkite.ini [dnsbl], env wins:
//   MAILKITE_DNSBL_ZONE       IP blocklist zone         (default zen.spamhaus.org)
//   MAILKITE_DBL_ZONE         domain blocklist zone     (default dbl.spamhaus.org)
//   MAILKITE_DNSBL_RESOLVERS  comma-separated resolver IPs; blank = /etc/resolv.conf
//   MAILKITE_DNSBL_ENABLED    "0" to disable the lookup entirely

const path = require('path');
const { Dnsbl, UNKNOWN } = require(path.join(__dirname, '..', 'lib', 'dnsbl.js'));

exports.register = function () {
  this.load_cfg();
  this.register_hook('connect', 'check_dnsbl');
  // data_post, not connect: the From HEADER doesn't exist until the message body has been read.
  this.register_hook('data_post', 'check_sender_domain');
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const d = cfg.dnsbl || {};
  const env = process.env;
  this.enabled = (env.MAILKITE_DNSBL_ENABLED ?? d.enabled ?? '1') !== '0';
  const resolvers = String(env.MAILKITE_DNSBL_RESOLVERS || d.resolvers || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  this.dnsbl = new Dnsbl({
    zoneIp: env.MAILKITE_DNSBL_ZONE || d.zone_ip,
    zoneDomain: env.MAILKITE_DBL_ZONE || d.zone_domain,
    canaryListedIp: d.canary_listed_ip,
    canaryCleanIp: d.canary_clean_ip,
    canaryListedDomain: d.canary_listed_domain,
    resolvers,
    timeoutMs: Number(d.timeout_ms),
    cacheTtlMs: Number(d.cache_ttl_ms),
  });
  if (!this.enabled) this.loginfo('mailkite_spam: dnsbl lookup disabled by config');
};

// `connect` hook. Always continues — see the header. The verdict lands on
// connection.notes.mailkite_dnsbl = { verdict, zone, canary }.
exports.check_dnsbl = function (next, connection) {
  const plugin = this;
  const note = (v) => {
    connection.notes.mailkite_dnsbl = v;
    next(); // unconditional: no DENY, no DENYSOFT, ever
  };
  if (!plugin.enabled) return note({ verdict: UNKNOWN, zone: null, canary: false });

  const ip = connection.remote && connection.remote.ip;
  plugin.dnsbl.check(ip).then((res) => {
    if (res.verdict !== UNKNOWN) {
      plugin.loginfo(`mailkite_spam: ${ip} ${res.verdict} in ${res.zone}`);
    }
    note(res);
  }).catch((e) => {
    plugin.logerror(`mailkite_spam: dnsbl check failed ${e.message}`);
    note({ verdict: UNKNOWN, zone: null, canary: false });
  });
};

// `data_post` hook — the sender DOMAIN from the From header, against the domain blocklist.
//
// WHY A SECOND LOOKUP, when we already check the connecting IP: the IP is the better signal live,
// but it exists only inside the SMTP session. The domain is IN the message, which means the same
// check can run over stored mail — it is the only spam signal we can compute BOTH live and
// retroactively, and running one code path for both is what stops them drifting.
//
// Like check_dnsbl, this CANNOT reject: `next()` on every branch. See the header.
exports.check_sender_domain = function (next, connection) {
  const plugin = this;
  const txn = connection && connection.transaction;
  const note = (v) => {
    if (txn) txn.notes.mailkite_dbl = v;
    next(); // unconditional: no DENY, no DENYSOFT, ever
  };
  if (!plugin.enabled || !txn) return note({ verdict: UNKNOWN, zone: null, canary: false });

  // The HEADER From is what the reader sees and what the stored row keeps, so it is what we score
  // — matching the Worker, which scores `messages.from_addr`. The envelope sender is a machine
  // address (VERP, list bounce paths) and judging a domain by it would score the wrong party.
  let domain = '';
  try {
    domain = exports.sender_domain(txn.header && txn.header.get('from'));
  } catch { /* malformed header — nothing to score, and never a reason to refuse mail */ }
  if (!domain) return note({ verdict: UNKNOWN, zone: null, canary: false });

  plugin.dnsbl.checkDomain(domain).then((res) => {
    if (res.verdict === 'listed') plugin.loginfo(`mailkite_spam: sender domain ${domain} listed in ${res.zone}`);
    note(res);
  }).catch((e) => {
    plugin.logerror(`mailkite_spam: dbl check failed ${e.message}`);
    note({ verdict: UNKNOWN, zone: null, canary: false });
  });
};

/**
 * The domain of a From header's ADDRESS. Exported for test/ingest.test.mjs — it is the whole
 * correctness of the sender-domain check, so it is tested directly rather than through Haraka.
 *
 * The angle brackets are read FIRST, and that is the entire point. A display name may legally
 * contain an @, and the shape that abuses it is the one this check most needs to get right:
 *
 *     From: "sales@paypal.com" <x@evil.ru>
 *
 * Scanning for the first @ scores `paypal.com` — the spoofed name — and reports the message
 * CLEAN on the strength of a domain the sender does not own. The real sender is in the brackets.
 * Reading the last @ of the address matters for the same reason: a quoted local part may contain
 * one (RFC 5322 §3.4.1).
 */
exports.sender_domain = function (headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  // A group/multi-address From is rare and ambiguous; the first address is the sender.
  const angle = raw.match(/<([^>]*)>/);
  const addr = (angle ? angle[1] : raw.split(',')[0]).trim();
  const at = addr.lastIndexOf('@');
  if (at === -1) return '';
  return addr
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/^[<'"\s]+|[>'"\s.;,]+$/g, ''); // stray delimiters either side, and a root-label dot
};
