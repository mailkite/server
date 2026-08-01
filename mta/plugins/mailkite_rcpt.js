'use strict';

// mailkite_rcpt — live anti-open-relay RCPT check.
//
// Replaces the static config/host_list (+ periodic sync) with a live lookup against the
// Worker's `GET /api/mx/accepted-domains`. We keep an in-memory cache of accepted domains
// with a short TTL so the common path adds zero network latency, and we re-check live on
// a cache MISS so a freshly-verified domain is accepted on its very first message — no
// sync, no cron, no restart.
//
// Resilience:
//   - On a fetch failure we keep serving the last-known set (never wipe on a blip).
//   - Cold start seeds from the committed config/host_list, so the edge works before the
//     first successful fetch (and if the API is unreachable at boot).
//   - If we have truly never obtained a list, we DENYSOFT (tempfail) so the sender retries
//     rather than us open-relaying or hard-bouncing.
//   - Cache misses trigger at most one live refresh per `min_miss_interval_ms`, so a flood
//     of unknown recipients can't hammer the API.
//
// Config (env preferred; falls back to config/mailkite.ini [main]):
//   MAILKITE_API_URL              base URL, e.g. https://api.mailkite.dev
//   MAILKITE_HMAC_SECRET          shared INGEST_SECRET, sent as Bearer
//   MAILKITE_ACCEPT_TTL_MS        positive-cache TTL (default 30000)
//   MAILKITE_ACCEPT_TIMEOUT_MS    fetch timeout (default 5000)

exports.register = function () {
  this.load_cfg();
  if (typeof fetch !== 'function') {
    throw new Error('global fetch unavailable — Node 18+ required for mailkite_rcpt');
  }
  this.accepted = new Set();   // currently-accepted domains (lowercased)
  this.fetched_at = 0;         // ms of last SUCCESSFUL fetch (0 = never)
  this.last_attempt = 0;       // ms of last fetch attempt (success or fail)
  this.refreshing = null;      // in-flight refresh promise (dedupes concurrent RCPTs)
  this.min_miss_interval_ms = 2000;
  this.seed_from_file();       // cold-start fallback
  this.refresh().catch(() => {}); // best-effort warm-up
  this.register_hook('rcpt', 'check_rcpt');
};

exports.load_cfg = function () {
  const cfg = this.config.get('mailkite.ini', () => this.load_cfg());
  const main = cfg.main || {};
  const base = process.env.MAILKITE_API_URL || main.api_url;
  this.accept_url = base ? base.replace(/\/+$/, '') + '/api/mx/accepted-domains' : null;
  this.secret = process.env.MAILKITE_HMAC_SECRET || main.hmac_secret;
  this.ttl_ms = Number(process.env.MAILKITE_ACCEPT_TTL_MS || main.accept_ttl_ms) || 30000;
  this.timeout_ms = Number(process.env.MAILKITE_ACCEPT_TIMEOUT_MS || main.accept_timeout_ms) || 5000;
  if (!this.accept_url) this.logerror('mailkite_rcpt: no api_url configured (MAILKITE_API_URL)');
  if (!this.secret) this.logerror('mailkite_rcpt: no hmac_secret configured (MAILKITE_HMAC_SECRET)');
};

// Seed the accepted set from the committed host_list so a cold start (before the first
// successful fetch) still accepts the known domains.
exports.seed_from_file = function () {
  try {
    const list = this.config.get('host_list', 'list') || [];
    for (const d of list) if (d) this.accepted.add(String(d).toLowerCase());
  } catch { /* best-effort */ }
};

// Fetch the accepted-domains list and atomically swap the cache on success. Never throws.
exports.refresh = function () {
  const plugin = this;
  if (plugin.refreshing) return plugin.refreshing; // coalesce concurrent callers
  if (!plugin.accept_url || !plugin.secret) return Promise.resolve(false);
  plugin.last_attempt = Date.now();
  plugin.refreshing = (async () => {
    let timer;
    try {
      // Timeout guard without AbortController (not reliably exposed in Haraka's plugin VM).
      const fetchP = fetch(plugin.accept_url, { headers: { authorization: `Bearer ${plugin.secret}` } });
      const timeoutP = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), plugin.timeout_ms); });
      const res = await Promise.race([fetchP, timeoutP]);
      if (!res || !res.ok) throw new Error(`status ${res && res.status}`);
      const body = await res.json();
      const domains = Array.isArray(body && body.domains) ? body.domains : [];
      plugin.accepted = new Set(domains.map((d) => String(d).toLowerCase()).filter(Boolean));
      plugin.fetched_at = Date.now();
      plugin.loginfo(`mailkite_rcpt: refreshed ${plugin.accepted.size} accepted domain(s)`);
      return true;
    } catch (e) {
      plugin.logerror(`mailkite_rcpt: refresh failed (${e.message}) — keeping ${plugin.accepted.size} cached`);
      return false;
    } finally {
      clearTimeout(timer);
      plugin.refreshing = null;
    }
  })();
  return plugin.refreshing;
};

exports.check_rcpt = function (next, connection, params) {
  const plugin = this;
  const rcpt = params && params[0];
  const domain = rcpt && rcpt.host ? String(rcpt.host).toLowerCase() : '';
  if (!domain) return next(DENY, 'malformed recipient');

  const now = Date.now();
  const fresh = (now - plugin.fetched_at) < plugin.ttl_ms;
  const recently_attempted = (now - plugin.last_attempt) < plugin.min_miss_interval_ms;

  // Fast path: known and fresh → accept with no network.
  if (plugin.accepted.has(domain) && fresh) return next(OK);
  // Known but stale, and we just attempted a refresh → don't block, accept on the cache.
  if (plugin.accepted.has(domain) && recently_attempted) return next(OK);

  const decide = () => {
    if (plugin.accepted.has(domain)) return next(OK);
    // Never obtained any list (cold start + API unreachable) → tempfail, do not open-relay.
    if (plugin.fetched_at === 0 && plugin.accepted.size === 0) {
      return next(DENYSOFT, 'recipient verification temporarily unavailable, please retry');
    }
    const who = rcpt && typeof rcpt.address === 'function' ? rcpt.address() : domain;
    return next(DENY, `I cannot deliver mail for <${who}>`);
  };

  // A refresh happened moments ago — trust the current cache, skip another fetch.
  if (recently_attempted) return decide();
  // Cache stale or domain unknown → live re-check before deciding (this is what lets a
  // just-verified domain be accepted on its first message).
  plugin.refresh().then(decide).catch(decide);
};
