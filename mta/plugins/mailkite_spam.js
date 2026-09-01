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
//   MAILKITE_DNSBL_RESOLVERS  comma-separated resolver IPs; blank = /etc/resolv.conf
//   MAILKITE_DNSBL_ENABLED    "0" to disable the lookup entirely

const path = require('path');
const { Dnsbl, UNKNOWN } = require(path.join(__dirname, '..', 'lib', 'dnsbl.js'));

exports.register = function () {
  this.load_cfg();
  this.register_hook('connect', 'check_dnsbl');
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
    canaryListedIp: d.canary_listed_ip,
    canaryCleanIp: d.canary_clean_ip,
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
