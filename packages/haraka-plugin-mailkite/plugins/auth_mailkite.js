'use strict';

// Docs: docs/architecture/smtp-relay.md
//
// SMTP AUTH for the MailKite submission edge. Extends Haraka's core auth_base, which:
//   - only advertises AUTH on an encrypted (TLS) session, and
//   - flips connection.relaying = true on a successful auth (this is what permits relaying).
//
// We override the single credential-check seam (check_plain_passwd, used for both PLAIN and
// LOGIN) and validate the supplied credential against the Worker's POST /api/smtp/auth — the
// API key (mk_live_…) is the password (the Resend/SendGrid convention). On success we stash the
// key on the connection so mailkite_relay can present it as Bearer to /api/relay.
//
// Config (env first, then config/mailkite.ini [main]):
//   MAILKITE_API_URL          base URL of the Worker (we append /api/smtp/auth)
//   MAILKITE_HMAC_SECRET      shared INGEST_SECRET, sent as Bearer (proves we're the edge)
//   MAILKITE_AUTH_TIMEOUT_MS  validation fetch timeout (default 5000)

exports.register = function () {
  this.inherits('auth/auth_base');
  this.load_cfg();
  // fetch is global on Node 18+ (the box runs Node 22); fail fast if absent.
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for auth_mailkite');
  }
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const main = cfg.main || {};
  const base = process.env.MAILKITE_API_URL || main.api_url;
  this.auth_url = base ? base.replace(/\/+$/, '') + '/api/smtp/auth' : null;
  this.secret = process.env.MAILKITE_HMAC_SECRET || main.hmac_secret;
  this.timeout_ms = Number(process.env.MAILKITE_AUTH_TIMEOUT_MS || main.auth_timeout_ms) || 5000;
  // Don't let auth_base keep the API key in notes.auth_passwd — we hold our own copy.
  this.blankout_password = true;
  if (!this.auth_url) this.logerror('auth_mailkite: no api_url configured (MAILKITE_API_URL)');
  if (!this.secret) this.logerror('auth_mailkite: no hmac_secret configured (MAILKITE_HMAC_SECRET)');
};

// Advertise only PLAIN + LOGIN (never CRAM-MD5 — that needs the plaintext secret server-side,
// which we deliberately never hold), and only over TLS so the API key is never sent in clear.
exports.hook_capabilities = function (next, connection) {
  if (!connection.tls || !connection.tls.enabled) return next();
  const methods = ['PLAIN', 'LOGIN'];
  connection.capabilities.push('AUTH ' + methods.join(' '));
  connection.notes.allowed_auth_methods = methods;
  return next();
};

// The override point auth_base calls for PLAIN and LOGIN. cb(true) authenticates (auth_base then
// sets connection.relaying = true and responds 235); cb(false) → 535.
exports.check_plain_passwd = function (connection, user, passwd, cb) {
  const plugin = this;
  if (!plugin.auth_url || !plugin.secret) return cb(false);

  // The API key is conventionally the password, but be liberal: accept it in either field —
  // whichever looks like an mk_live_ key — so any app's SMTP form (user/pass) maps cleanly.
  const key = [passwd, user].find((v) => typeof v === 'string' && v.startsWith('mk_live_')) || passwd;
  if (!key) return cb(false);

  let settled = false;
  const done = (ok, userId) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (ok) {
      connection.notes.mailkite_key = key;
      connection.notes.mailkite_user_id = userId || null;
    }
    cb(!!ok);
  };
  const timer = setTimeout(() => {
    plugin.logerror('auth_mailkite: validation timeout');
    done(false);
  }, plugin.timeout_ms);

  fetch(plugin.auth_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + plugin.secret },
    body: JSON.stringify({ key }),
  })
    .then(async (res) => {
      if (!res.ok) return done(false);
      const body = await res.json().catch(() => ({}));
      return done(!!body.ok, body.userId);
    })
    .catch((e) => {
      plugin.logerror('auth_mailkite: ' + e.message);
      return done(false);
    });
};
