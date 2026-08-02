'use strict';

// haraka-plugin-mailkite — bolt an existing Haraka install onto any MailKite-contract
// backend (MailKite Cloud or a self-hosted api-local) without adopting the whole
// mailkite/server repo. Contract: https://github.com/mailkite/server/blob/main/docs/contract.md
//
// One plugin, role-selected via config/mailkite.ini:
//
//   [main]
//   role = mx        ; inbound MX: anti-open-relay RCPT check + queue → POST /api/ingest
//   role = submit    ; submission: SMTP AUTH via /api/smtp/auth + queue → POST /api/relay
//
// (MX and submission belong on separate Haraka instances — different trust models.)
//
// The files under plugins/ and lib/ are verbatim copies of the canonical sources in the
// repo's mta/ and mta-submit/ directories; scripts/sync.mjs keeps them identical and
// `npm test` / `prepack` / CI fail on drift. Report bugs against the canonical files.

const path = require('path');

const load = (f) => require(path.join(__dirname, 'plugins', f));

exports.register = function () {
  const cfg = this.config.get('mailkite.ini') || {};
  const role = ((cfg.main && cfg.main.role) || process.env.MAILKITE_ROLE || 'mx').toLowerCase();
  if (role === 'mx') return this.register_mx();
  if (role === 'submit' || role === 'submission') return this.register_submit();
  throw new Error(`haraka-plugin-mailkite: unknown role "${role}" (use mx or submit)`);
};

// MX role. The two canonical plugins export disjoint method names, so both graft
// directly onto this plugin instance; each canonical register() then wires its own
// config and hooks. Haraka's post-register() hook scan picks up the grafted
// hook_queue; mailkite_rcpt registers its rcpt hook explicitly.
exports.register_mx = function () {
  const rcpt = load('mailkite_rcpt.js');
  const ingest = load('mailkite_ingest.js');
  for (const mod of [rcpt, ingest]) {
    for (const [k, v] of Object.entries(mod)) {
      if (k !== 'register') this[k] = v;
    }
  }
  rcpt.register.call(this);
  ingest.register.call(this);
};

// Submission role. auth_mailkite grafts onto this instance — inherits('auth/auth_base')
// must land auth_base's hook methods on the real plugin object so Haraka's hook scan
// sees them. mailkite_relay runs on an isolated delegate object instead, because both
// canonical plugins define load_cfg and timeout_ms and would clobber each other.
exports.register_submit = function () {
  const auth = load('auth_mailkite.js');
  for (const [k, v] of Object.entries(auth)) {
    if (k !== 'register') this[k] = v;
  }
  auth.register.call(this);

  const relayMod = load('mailkite_relay.js');
  const relay = Object.assign(Object.create(null), relayMod);
  relay.name = `${this.name || 'mailkite'}/relay`;
  relay.config = this.config;
  for (const lf of ['logdebug', 'loginfo', 'lognotice', 'logwarn', 'logerror', 'logcrit']) {
    relay[lf] = (...args) => (typeof this[lf] === 'function' ? this[lf](...args) : undefined);
  }
  relay.register_hook = () => {}; // delegate hooks are registered on the plugin below
  relayMod.register.call(relay);

  this.mailkite_relay_queue = function (next, connection) {
    return relay.hook_queue.call(relay, next, connection);
  };
  this.register_hook('queue', 'mailkite_relay_queue');
  this.register_hook('queue_outbound', 'mailkite_relay_queue');
};
