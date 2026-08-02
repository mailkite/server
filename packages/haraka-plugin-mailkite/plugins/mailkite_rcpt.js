'use strict';

// mailkite_rcpt — live anti-open-relay RCPT check, now multi-backend capable.
//
// Single-backend mode (no config/backends.json): behavior identical to the original
// plugin — one accepted-domains source (MAILKITE_API_URL), cache seeded from
// config/host_list, live re-check on a cache miss so a freshly-verified domain is
// accepted on its very first message.
//
// Multi-backend mode (config/backends.json present): each backend keeps its own cached
// accepted-domains set; a recipient is accepted iff some backend claims its domain, and
// the owning backend is recorded on the transaction for mailkite_ingest to route the
// POST. Order in backends.json is priority — first configured wins a conflict.
// Spec: docs/multi-backend.md. Routing logic lives in ../lib/backends.js (unit-tested
// without Haraka).
//
// Config (env preferred; falls back to config/mailkite.ini [main]):
//   MAILKITE_API_URL              default backend base URL
//   MAILKITE_HMAC_SECRET          default backend secret (Bearer)
//   MAILKITE_ACCEPT_TTL_MS        positive-cache TTL (default 30000)
//   MAILKITE_ACCEPT_TIMEOUT_MS    fetch timeout (default 5000)

const path = require('path');
const { parseBackendsConfig, BackendRouter, setSharedRouter } = require(path.join(__dirname, '..', 'lib', 'backends.js'));

exports.register = function () {
  this.load_cfg();
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for mailkite_rcpt');
  }
  this.build_router();
  this.seed_from_file();          // cold-start fallback (default backend only)
  this.router.refreshAll().catch(() => {}); // best-effort warm-up
  this.register_hook('rcpt', 'check_rcpt');
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const main = cfg.main || {};
  const base = process.env.MAILKITE_API_URL || main.api_url;
  this.default_url = base ? base.replace(/\/+$/, '') : null;
  this.secret = process.env.MAILKITE_HMAC_SECRET || main.hmac_secret;
  this.ttl_ms = Number(process.env.MAILKITE_ACCEPT_TTL_MS || main.accept_ttl_ms) || 30000;
  this.timeout_ms = Number(process.env.MAILKITE_ACCEPT_TIMEOUT_MS || main.accept_timeout_ms) || 5000;
  if (!this.default_url) this.logerror('mailkite_rcpt: no api_url configured (MAILKITE_API_URL)');
  if (!this.secret) this.logerror('mailkite_rcpt: no hmac_secret configured (MAILKITE_HMAC_SECRET)');
};

exports.build_router = function () {
  const plugin = this;
  const log = {
    info: (m) => plugin.loginfo(m),
    warn: (m) => plugin.logwarn(m),
    error: (m) => plugin.logerror(m),
  };
  // config/backends.json is optional; without it, construct the single default backend
  // from the same env/ini values the original plugin used.
  const raw = this.config.get('backends.json', () => this.build_router());
  let backends = parseBackendsConfig(raw, process.env, log);
  if (!backends.length) {
    backends = (this.default_url && this.secret)
      ? [{ name: 'default', url: this.default_url, secret: this.secret, ingestUrl: `${this.default_url}/api/ingest` }]
      : [];
  }
  this.router = new BackendRouter(backends, {
    ttl_ms: this.ttl_ms, timeout_ms: this.timeout_ms, logger: log,
  });
  setSharedRouter(this.router);
  if (backends.length > 1) {
    this.loginfo(`mailkite_rcpt: multi-backend mode — ${backends.map((b) => b.name).join(' > ')}`);
  }
};

// Seed the highest-priority backend from the committed host_list so a cold start
// (before the first successful fetch) still accepts the known domains.
exports.seed_from_file = function () {
  try {
    const list = this.config.get('host_list', 'list') || [];
    const first = this.router.backends[0];
    if (first) this.router.seed(first.name, list);
  } catch { /* best-effort */ }
};

exports.check_rcpt = function (next, connection, params) {
  const plugin = this;
  const rcpt = params && params[0];
  const domain = rcpt && rcpt.host ? String(rcpt.host).toLowerCase() : '';
  if (!domain) return next(DENY, 'malformed recipient');
  const router = plugin.router;

  const addrStr = () => (rcpt && typeof rcpt.address === 'function' ? rcpt.address() : `${rcpt.user}@${domain}`);
  const record = (backend) => {
    const txn = connection.transaction;
    if (txn) {
      txn.notes.mailkite_backend_by_addr = txn.notes.mailkite_backend_by_addr || {};
      txn.notes.mailkite_backend_by_addr[addrStr()] = backend.name;
    }
    return next(OK);
  };

  const owner = router.ownerOf(domain);
  // Fast path: known and its owner's cache is fresh → accept with no network.
  if (owner && router.isFresh(owner.name)) return record(owner);
  // Known but stale, and that backend was just re-attempted → accept on the cache.
  if (owner && router.recentlyAttempted(owner.name)) return record(owner);

  const decide = () => {
    const o = router.ownerOf(domain);
    if (o) return record(o);
    // Some backend has never produced any list (cold start + API unreachable) →
    // tempfail rather than bounce a domain that backend might own.
    if (!router.hasFullCoverage()) {
      return next(DENYSOFT, 'recipient verification temporarily unavailable, please retry');
    }
    return next(DENY, `I cannot deliver mail for <${addrStr()}>`);
  };

  // Every backend attempted moments ago — trust current caches, skip another fetch.
  if (router.backends.every((b) => router.recentlyAttempted(b.name))) return decide();
  // Cache stale or domain unknown → live re-check before deciding (this is what lets a
  // just-verified domain be accepted on its first message).
  router.refreshAll().then(decide).catch(decide);
};
