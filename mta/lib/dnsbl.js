'use strict';

// DNSBL lookups for the MX edge — docs/architecture/inbound-spam.md §3 (Layer 2).
//
// Pure module: no Haraka imports, resolver injected, so the classification logic is
// unit-testable without a live DNS server (see test/dnsbl.test.mjs). Mirrors lib/backends.js.
//
// WHY THIS EXISTS SEPARATELY FROM mta-submit's /rbl ENDPOINT
// ---------------------------------------------------------
// `mta-submit` (the SUBMISSION edge, a different deployable on a different box) exposes
// POST /rbl so the Worker can resolve blocklist queries from a resolver we control. That
// endpoint answers questions about OUTBOUND senders. This module answers a question only
// the INBOUND edge can ask: what is the reputation of the IP currently connected to :25?
// By the time a message reaches the Worker the TCP peer is our own edge, so the connecting
// IP has to be captured here. Each deployable owns its code (AGENTS.md §8), so the logic is
// re-stated rather than reached across for — but the SEMANTICS below are ported verbatim,
// because they encode a bug we already paid for once.
//
// THE TRI-STATE, AND WHY `unknown` IS NEVER `clean`
// ------------------------------------------------
// The outbound path originally queried Spamhaus over PUBLIC DoH. Spamhaus REFUSES public
// resolvers: every answer came back 127.255.255.254 ("query via public resolver"), and a
// `startsWith('127.0.0.')` test read that as NOT LISTED. Every lookup silently said "clean"
// — including for IPs we knew were listed — and nothing surfaced the failure for weeks.
// So classification is by RETURN CODE, never by "did we get an answer":
//
//   127.0.0.x / 127.0.1.x / 127.0.2.x   → listed   (zen / dbl / zrd)
//   127.255.255.x                       → unknown  (refused, prohibited, over quota)
//   NXDOMAIN / ENODATA                  → clean
//   SERVFAIL / timeout / anything else   → unknown
//
// And a CANARY proves the resolver is actually being answered before any verdict is
// trusted: two probes with known-opposite expected results. If the always-listed point
// doesn't come back listed, or the never-listed point does, our queries are being refused
// or intercepted and every verdict in that batch collapses to `unknown`.

const dns = require('dns');

/** One target's blocklist state. `unknown` means "we did not get a usable answer". */
const LISTED = 'listed';
const CLEAN = 'clean';
const UNKNOWN = 'unknown';

/**
 * Map a set of A answers (or a resolver error) to listed | clean | unknown.
 *
 * @param {string[]|null} addrs  A records returned for the query name
 * @param {Error|null} err       resolver error, if the lookup threw
 * @returns {'listed'|'clean'|'unknown'}
 */
function classify(addrs, err) {
  if (err) {
    // NXDOMAIN / no A record for the query name = not on the list.
    if (err.code === dns.NOTFOUND || err.code === 'ENOTFOUND' || err.code === 'ENODATA') return CLEAN;
    return UNKNOWN; // SERVFAIL, timeout, refused, network — never "clean"
  }
  if (!addrs || !addrs.length) return CLEAN;
  // Any 127.255.255.x is a control code from the list operator, NOT a listing.
  if (addrs.some((a) => a.startsWith('127.255.255.'))) return UNKNOWN;
  if (addrs.some((a) => /^127\.0\.[012]\./.test(a))) return LISTED;
  // An answer outside both ranges means something is intercepting DNS (captive portal,
  // wildcard resolver). Treat as unknown rather than guessing.
  return UNKNOWN;
}

/**
 * Map a DOMAIN-zone (DBL) answer to listed | clean | unknown.
 *
 * The domain zone does NOT share the IP zone's return codes, and reusing `classify` here is a live
 * false-positive bug: `8.8.8.8.dbl.spamhaus.org` answers **127.0.1.255** — "IP queries prohibited",
 * an error — which `classify` reads as a listing because it matches 127.0.[012].x. A From domain
 * that is an IP literal would then be flagged as spam on the strength of an error message.
 *
 *   127.0.1.2/4/5/6      → listed  (spam / phish / malware / botnet C&C domain)
 *   127.0.1.10x          → listed  (ABUSED LEGIT domain — see below)
 *   127.0.1.255          → unknown (we asked the wrong kind of question)
 *   127.255.255.x        → unknown (refused, prohibited, over quota)
 *   NXDOMAIN / ENODATA   → clean
 *
 * WHY "abused legit" (127.0.1.102–106) counts as listed: those are real domains that have been
 * compromised and are currently serving spam/phishing. Spamhaus warns against BLOCKING on them,
 * because the domain itself is legitimate — but we never block. We flag, into a folder the reader
 * can overrule in one click, and mail from a domain that is right now being used to phish is
 * exactly what that folder is for. If that trade ever needs revisiting, this is the one place.
 */
function classifyDomain(addrs, err) {
  if (err) {
    if (err.code === dns.NOTFOUND || err.code === 'ENOTFOUND' || err.code === 'ENODATA') return CLEAN;
    return UNKNOWN;
  }
  if (!addrs || !addrs.length) return CLEAN;
  if (addrs.some((a) => a.startsWith('127.255.255.'))) return UNKNOWN;
  // 127.0.1.255 is an ERROR ("IP queries prohibited"), never a listing. Checked before the
  // listing test below, which would otherwise swallow it.
  if (addrs.some((a) => a === '127.0.1.255')) return UNKNOWN;
  if (addrs.some((a) => /^127\.0\.1\.(?:[2456]|10[23456])$/.test(a))) return LISTED;
  // Any other answer is a code we don't know, or DNS interception. Not a guess either way.
  return UNKNOWN;
}

/** Is this something the domain zone can be asked about? Bare TLDs, IP literals and empty strings
 *  are not — and an IP literal is exactly what earns the 127.0.1.255 error above. */
function isQueryableDomain(d) {
  const v = String(d || '').trim().toLowerCase();
  if (!v || v.length > 253 || !v.includes('.')) return false;
  if (isIpv4(v)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v);
}

/** Reverse an IPv4 for DNSBL query form: 1.2.3.4 → 4.3.2.1 */
function reverseIp(ip) {
  return String(ip).split('.').reverse().join('.');
}

/** IPv4 dotted-quad only. DNSBL query form differs for IPv6 and most zones don't carry it,
 *  so a v6 peer is `unknown` (not `clean`) rather than a malformed query. */
function isIpv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip || ''));
}

/** Build a real DNS resolver bound to the configured servers/timeout. */
function makeResolver(opts) {
  const map = opts.classify || classify;
  return async (name) => {
    const resolver = new dns.promises.Resolver({ timeout: opts.timeoutMs, tries: 1 });
    if (opts.resolvers && opts.resolvers.length) resolver.setServers(opts.resolvers);
    try {
      return map(await resolver.resolve4(name), null);
    } catch (e) {
      return map(null, e);
    }
  };
}

/**
 * A configured DNSBL checker.
 *
 * PROMISES: `check(ip)` resolves to {verdict, zone, canary} and NEVER throws and NEVER
 * rejects — every failure path returns `unknown`, because this sits in front of mail
 * acceptance and must fail open.
 * REQUIRES: `opts.zoneIp` (the IP blocklist zone) and a resolver; `lookup` may be injected
 * to test without DNS.
 * INVARIANT: a verdict is only ever `listed` or `clean` when the canary passed.
 */
class Dnsbl {
  /**
   * @param {object} opts
   * @param {string} opts.zoneIp            IP blocklist zone (e.g. zen.spamhaus.org)
   * @param {string} [opts.canaryListedIp]  test point that MUST be listed
   * @param {string} [opts.canaryCleanIp]   test point that MUST be clean
   * @param {string[]} [opts.resolvers]     resolver IPs; empty = inherit /etc/resolv.conf
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.cacheTtlMs]      how long a definitive verdict is reused
   * @param {function} [opts.lookup]        injected `(name) => Promise<verdict>` for tests
   * @param {function} [opts.now]           injected clock for tests
   */
  constructor(opts = {}) {
    this.zoneIp = opts.zoneIp || 'zen.spamhaus.org';
    this.canaryListedIp = opts.canaryListedIp || '127.0.0.2'; // always listed in zen
    this.canaryCleanIp = opts.canaryCleanIp || '127.0.0.1';   // never listed in zen
    // The DOMAIN zone is a separate list with separate return codes and its own canary point.
    // Kept separate from the IP zone throughout so a broken/absent DBL can never disable the IP
    // check, or vice versa — one refused zone should cost us one signal, not both.
    this.zoneDomain = opts.zoneDomain || 'dbl.spamhaus.org';
    this.canaryListedDomain = opts.canaryListedDomain || 'dbltest.com'; // always listed in dbl
    this.timeoutMs = Number(opts.timeoutMs) || 2000;
    this.resolvers = opts.resolvers || [];
    this.cacheTtlMs = Number(opts.cacheTtlMs) || 600000; // 10 min
    // How long a FAILED canary is believed before we re-probe. Deliberately much shorter than
    // cacheTtlMs — see canary().
    this.canaryRetryMs = Number(opts.canaryRetryMs) || 30000; // 30s
    this.now = opts.now || (() => Date.now());
    this.lookup = opts.lookup || makeResolver({ resolvers: this.resolvers, timeoutMs: this.timeoutMs });
    // Separate resolver binding because the two zones classify their answers DIFFERENTLY —
    // sharing `lookup` is how 127.0.1.255 ("IP queries prohibited") would read as a listing.
    this.lookupDomain = opts.lookupDomain
      || makeResolver({ resolvers: this.resolvers, timeoutMs: this.timeoutMs, classify: classifyDomain });
    // ip → {verdict, at}. Only definitive verdicts are stored; caching an `unknown` would
    // pin a wrong answer for the process's life, which is how the original bug persisted.
    this.cache = new Map();
    // The canary is per-batch in the outbound endpoint; here connections arrive one at a
    // time, so it is cached for the same TTL rather than re-probed on every SMTP connect.
    // null, not 0: an injected clock legitimately returns 0, and a falsy check would then read
    // "checked at time 0" as "never checked" and re-probe on every call.
    this.canaryAt = null;
    this.canaryOk = false;
    this.canaryDomainAt = null;
    this.canaryDomainOk = false;
  }

  /**
   * Prove the resolver is actually being answered by this list operator, at most once per
   * cache TTL. Two probes with known-opposite expected verdicts.
   */
  async canary() {
    // A PASS is believed for the full TTL; a FAILURE only briefly. The two are not equally
    // trustworthy and must not share a lifetime.
    //
    // This module already refuses to cache an `unknown` verdict, because caching one pins a wrong
    // answer for the process's life. The canary GATES every one of those verdicts, so caching a
    // failed canary for ten minutes does the same damage wholesale: one transient DNS blip — and
    // one was observed in production on 2026-09-01, with the zone answering correctly seconds
    // either side — turns every IP into `unknown` for ten minutes, silently disabling the
    // heaviest signal we have. Failing open is correct; staying failed open is not.
    const age = this.canaryAt === null ? Infinity : this.now() - this.canaryAt;
    if (age < (this.canaryOk ? this.cacheTtlMs : this.canaryRetryMs)) return this.canaryOk;
    const [listed, clean] = await Promise.all([
      this.lookup(`${reverseIp(this.canaryListedIp)}.${this.zoneIp}`),
      this.lookup(`${reverseIp(this.canaryCleanIp)}.${this.zoneIp}`),
    ]);
    this.canaryOk = listed === LISTED && clean === CLEAN;
    this.canaryAt = this.now();
    return this.canaryOk;
  }

  /**
   * Look one connecting IP up. Never throws.
   * @returns {Promise<{verdict:'listed'|'clean'|'unknown', zone:string, canary:boolean}>}
   */
  async check(ip) {
    const out = (verdict, canary) => ({ verdict, zone: this.zoneIp, canary: !!canary });
    try {
      if (!isIpv4(ip)) return out(UNKNOWN, false);
      const hit = this.cache.get(ip);
      if (hit && this.now() - hit.at < this.cacheTtlMs) return out(hit.verdict, true);

      const ok = await this.canary();
      if (!ok) return out(UNKNOWN, false);

      const verdict = await this.lookup(`${reverseIp(ip)}.${this.zoneIp}`);
      // Cache only definitive verdicts.
      if (verdict === LISTED || verdict === CLEAN) this.cache.set(ip, { verdict, at: this.now() });
      return out(verdict, true);
    } catch {
      return out(UNKNOWN, false); // fail open — a blocklist must never break mail acceptance
    }
  }

  /**
   * Prove the DOMAIN zone is answering us. One probe: a test point that MUST be listed. There is
   * no documented never-listed domain to pair it with (any name we picked could get listed
   * tomorrow and turn the canary into a false alarm), so this arm is one-sided by necessity —
   * which is fine, because the failure it has to catch is "we are being refused", and a refusal
   * makes the listed probe come back not-listed.
   */
  async canaryDomain() {
    // Same asymmetry as canary(): believe a pass for the TTL, re-probe a failure quickly.
    const age = this.canaryDomainAt === null ? Infinity : this.now() - this.canaryDomainAt;
    if (age < (this.canaryDomainOk ? this.cacheTtlMs : this.canaryRetryMs)) return this.canaryDomainOk;
    const listed = await this.lookupDomain(`${this.canaryListedDomain}.${this.zoneDomain}`);
    this.canaryDomainOk = listed === LISTED;
    this.canaryDomainAt = this.now();
    return this.canaryDomainOk;
  }

  /**
   * Look one SENDER DOMAIN up in the domain zone. Never throws.
   *
   * This is the signal an IP lookup can't give us after the fact: the connecting IP lives only in
   * the SMTP session, but the domain is IN the message — so the same check runs live at the edge
   * and retroactively over stored mail, and the two can't drift.
   *
   * @returns {Promise<{verdict:'listed'|'clean'|'unknown', zone:string, canary:boolean}>}
   */
  async checkDomain(domain) {
    const out = (verdict, canary) => ({ verdict, zone: this.zoneDomain, canary: !!canary });
    try {
      const d = String(domain || '').trim().toLowerCase();
      if (!isQueryableDomain(d)) return out(UNKNOWN, false);
      const key = `d:${d}`;
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < this.cacheTtlMs) return out(hit.verdict, true);

      if (!(await this.canaryDomain())) return out(UNKNOWN, false);

      const verdict = await this.lookupDomain(`${d}.${this.zoneDomain}`);
      if (verdict === LISTED || verdict === CLEAN) this.cache.set(key, { verdict, at: this.now() });
      return out(verdict, true);
    } catch {
      return out(UNKNOWN, false);
    }
  }
}

module.exports = { Dnsbl, classify, classifyDomain, isQueryableDomain, reverseIp, isIpv4, LISTED, CLEAN, UNKNOWN };
