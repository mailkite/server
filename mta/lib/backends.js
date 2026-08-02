'use strict';

// Multi-backend routing for the MX edge — docs/multi-backend.md is the spec.
//
// Pure module: no Haraka imports, fetch + logger injected, so the routing logic is
// unit-testable without installing Haraka (see test/backends.test.mjs). Both plugins
// (mailkite_rcpt, mailkite_ingest) require this same module instance, so the router
// built by mailkite_rcpt is shared with mailkite_ingest via set/getSharedRouter().
//
// Semantics ported unchanged from the single-backend mailkite_rcpt cache:
//   - per-backend positive cache with TTL (fresh → zero network on the fast path)
//   - keep-last-known on refresh failure (a blip never wipes a domain list)
//   - coalesced concurrent refreshes; at most one attempt per min_miss_interval_ms
//   - cold start may be seeded (config/host_list) so the edge works before the API answers

/**
 * Parse config/backends.json content into an ordered backend list.
 * Order is priority: the earlier entry wins a domain conflict.
 * Backends with a missing/empty secret env var are skipped loudly (never silently).
 *
 * @param {object|null} cfg    parsed backends.json ({backends: [{name,url,secretEnv}]})
 * @param {object} env         process.env (injected for tests)
 * @param {object} log         {info, warn, error}
 * @returns {Array<{name:string,url:string,secret:string,ingestUrl:string}>}
 */
function parseBackendsConfig(cfg, env, log) {
  const out = [];
  const list = cfg && Array.isArray(cfg.backends) ? cfg.backends : [];
  for (const b of list) {
    if (!b || !b.name || !b.url || !b.secretEnv) {
      log.error(`backends: entry ${JSON.stringify(b)} missing name/url/secretEnv — skipped`);
      continue;
    }
    const secret = env[b.secretEnv];
    if (!secret) {
      log.error(`backends: ${b.name}: env ${b.secretEnv} is unset/empty — backend skipped`);
      continue;
    }
    const url = String(b.url).replace(/\/+$/, '');
    out.push({ name: String(b.name), url, secret, ingestUrl: `${url}/api/ingest` });
  }
  return out;
}

class BackendRouter {
  /**
   * @param {Array<{name,url,secret,ingestUrl}>} backends ordered by priority
   * @param {object} opts {ttl_ms, timeout_ms, min_miss_interval_ms, fetch, logger}
   */
  constructor(backends, opts = {}) {
    this.backends = backends;
    this.ttl_ms = opts.ttl_ms || 30000;
    this.timeout_ms = opts.timeout_ms || 5000;
    this.min_miss_interval_ms = opts.min_miss_interval_ms || 2000;
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.log = opts.logger || { info() {}, warn() {}, error() {} };
    /** @type {Map<string, {accepted:Set<string>, fetched_at:number, last_attempt:number, refreshing:Promise|null}>} */
    this.state = new Map(backends.map((b) => [b.name, {
      accepted: new Set(), fetched_at: 0, last_attempt: 0, refreshing: null,
    }]));
    this.warnedConflicts = new Set();
  }

  /** Seed a backend's accepted set (cold-start fallback, e.g. config/host_list). */
  seed(name, domains) {
    const st = this.state.get(name);
    if (!st) return;
    for (const d of domains || []) if (d) st.accepted.add(String(d).toLowerCase());
  }

  /** Refresh one backend's accepted-domains; coalesced; never throws; keeps last-known on failure. */
  refreshBackend(backend) {
    const st = this.state.get(backend.name);
    if (!st) return Promise.resolve(false);
    if (st.refreshing) return st.refreshing;
    st.last_attempt = Date.now();
    st.refreshing = (async () => {
      let timer;
      try {
        const fetchP = this.fetch(`${backend.url}/api/mx/accepted-domains`, {
          headers: { authorization: `Bearer ${backend.secret}` },
        });
        const timeoutP = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), this.timeout_ms);
        });
        const res = await Promise.race([fetchP, timeoutP]);
        if (!res || !res.ok) throw new Error(`status ${res && res.status}`);
        const body = await res.json();
        const domains = Array.isArray(body && body.domains) ? body.domains : [];
        st.accepted = new Set(domains.map((d) => String(d).toLowerCase()).filter(Boolean));
        st.fetched_at = Date.now();
        this.log.info(`backends: ${backend.name}: refreshed ${st.accepted.size} accepted domain(s)`);
        return true;
      } catch (e) {
        this.log.error(`backends: ${backend.name}: refresh failed (${e.message}) — keeping ${st.accepted.size} cached`);
        return false;
      } finally {
        clearTimeout(timer);
        st.refreshing = null;
      }
    })();
    return st.refreshing;
  }

  /** Refresh every backend (settled — one failing backend never blocks the others). */
  refreshAll() {
    return Promise.allSettled(this.backends.map((b) => this.refreshBackend(b)));
  }

  /**
   * Which backend owns this domain? First-configured wins; a conflict is warned once
   * per domain, not per message. Returns the backend object or null.
   */
  ownerOf(domain) {
    const d = String(domain || '').toLowerCase();
    if (!d) return null;
    let owner = null;
    let claimers = 0;
    for (const b of this.backends) {
      if (this.state.get(b.name).accepted.has(d)) {
        claimers++;
        if (!owner) owner = b;
      }
    }
    if (claimers > 1 && !this.warnedConflicts.has(d)) {
      this.warnedConflicts.add(d);
      this.log.warn(`backends: CONFLICT — ${claimers} backends claim ${d}; using "${owner.name}" (first configured wins)`);
    }
    return owner;
  }

  /** Is `name`'s cache fresh (successful fetch within TTL)? */
  isFresh(name) {
    const st = this.state.get(name);
    return !!st && (Date.now() - st.fetched_at) < this.ttl_ms;
  }

  /** Did `name` attempt a refresh within min_miss_interval_ms? */
  recentlyAttempted(name) {
    const st = this.state.get(name);
    return !!st && (Date.now() - st.last_attempt) < this.min_miss_interval_ms;
  }

  /** True when every backend has produced (or been seeded with) some data. */
  hasFullCoverage() {
    for (const st of this.state.values()) {
      if (st.fetched_at === 0 && st.accepted.size === 0) return false;
    }
    return this.state.size > 0;
  }

  /**
   * Group recipient addresses by owning backend.
   * @param {Array<string>} rcpts e.g. ['a@x.com', 'b@y.org']
   * @returns {{groups: Map<object, string[]>, unmatched: string[]}}
   */
  groupRcpts(rcpts) {
    const groups = new Map();
    const unmatched = [];
    for (const addr of rcpts || []) {
      const domain = String(addr).split('@')[1] || '';
      const owner = this.ownerOf(domain);
      if (!owner) { unmatched.push(addr); continue; }
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(addr);
    }
    return { groups, unmatched };
  }
}

// Shared instance: mailkite_rcpt builds the router at register(); mailkite_ingest reads
// it for fallback lookups. Same require() cache → same module state in one Haraka process.
let shared = null;
function setSharedRouter(router) { shared = router; }
function getSharedRouter() { return shared; }

module.exports = { parseBackendsConfig, BackendRouter, setSharedRouter, getSharedRouter };
