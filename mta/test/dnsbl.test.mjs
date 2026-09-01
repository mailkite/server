// Unit tests for lib/dnsbl.js — zero-dep (no Haraka, no live resolver).
// The classification table and the canary are the whole safety argument of this module,
// so they are tested directly rather than through DNS.
// Run: node --test 'test/*.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dnsbl from '../lib/dnsbl.js';

const { Dnsbl, classify, classifyDomain, isQueryableDomain, reverseIp, isIpv4 } = dnsbl;

test('classify: listing return codes are `listed`', () => {
  assert.equal(classify(['127.0.0.2'], null), 'listed');   // zen
  assert.equal(classify(['127.0.1.2'], null), 'listed');   // dbl
  assert.equal(classify(['127.0.2.5'], null), 'listed');   // zrd
  assert.equal(classify(['127.0.0.4', '127.0.0.11'], null), 'listed');
});

test('classify: 127.255.255.x is a control code, NOT a listing and NOT clean', () => {
  // This is the exact answer Spamhaus gives a public resolver. Reading it as "not listed"
  // is the bug this whole module exists to make impossible.
  assert.equal(classify(['127.255.255.254'], null), 'unknown');
  assert.equal(classify(['127.255.255.252'], null), 'unknown');
});

test('classify: NXDOMAIN / ENODATA are the only paths to `clean`', () => {
  assert.equal(classify(null, { code: 'ENOTFOUND' }), 'clean');
  assert.equal(classify(null, { code: 'ENODATA' }), 'clean');
  assert.equal(classify([], null), 'clean');
});

test('classify: every other failure is `unknown`, never `clean`', () => {
  assert.equal(classify(null, { code: 'SERVFAIL' }), 'unknown');
  assert.equal(classify(null, { code: 'ETIMEOUT' }), 'unknown');
  assert.equal(classify(null, { code: 'ECONNREFUSED' }), 'unknown');
  assert.equal(classify(null, new Error('boom')), 'unknown');
});

test('classify: an answer outside both ranges means DNS is being intercepted', () => {
  assert.equal(classify(['10.0.0.1'], null), 'unknown');
  assert.equal(classify(['1.2.3.4'], null), 'unknown');
});

test('reverseIp / isIpv4', () => {
  assert.equal(reverseIp('1.2.3.4'), '4.3.2.1');
  assert.equal(isIpv4('198.23.244.195'), true);
  assert.equal(isIpv4('2001:db8::1'), false);
  assert.equal(isIpv4(''), false);
  assert.equal(isIpv4(undefined), false);
});

// A fake resolver: canary points answer correctly, and `listedIps` are listed.
const fakeLookup = (listedIps = [], { breakCanary = false } = {}) => {
  const calls = [];
  const fn = async (name) => {
    calls.push(name);
    if (name === '2.0.0.127.zen.spamhaus.org') return breakCanary ? 'unknown' : 'listed';
    if (name === '1.0.0.127.zen.spamhaus.org') return 'clean';
    const ip = name.replace('.zen.spamhaus.org', '').split('.').reverse().join('.');
    return listedIps.includes(ip) ? 'listed' : 'clean';
  };
  fn.calls = calls;
  return fn;
};

test('check: a listed IP reports listed, with the zone and a passing canary', async () => {
  const bl = new Dnsbl({ lookup: fakeLookup(['1.2.3.4']) });
  assert.deepEqual(await bl.check('1.2.3.4'), { verdict: 'listed', zone: 'zen.spamhaus.org', canary: true });
});

test('check: a clean IP reports clean', async () => {
  const bl = new Dnsbl({ lookup: fakeLookup(['1.2.3.4']) });
  assert.deepEqual(await bl.check('9.9.9.9'), { verdict: 'clean', zone: 'zen.spamhaus.org', canary: true });
});

test('check: a FAILED CANARY collapses a listed IP to unknown', async () => {
  // The resolver would have said "listed", but it can't be trusted, so we must not say so.
  const bl = new Dnsbl({ lookup: fakeLookup(['1.2.3.4'], { breakCanary: true }) });
  const res = await bl.check('1.2.3.4');
  assert.equal(res.verdict, 'unknown');
  assert.equal(res.canary, false);
});

test('check: IPv6 and garbage are unknown, never clean', async () => {
  const bl = new Dnsbl({ lookup: fakeLookup() });
  assert.equal((await bl.check('2001:db8::1')).verdict, 'unknown');
  assert.equal((await bl.check(undefined)).verdict, 'unknown');
});

test('check: a throwing resolver fails OPEN to unknown', async () => {
  const bl = new Dnsbl({ lookup: async () => { throw new Error('resolver exploded'); } });
  assert.equal((await bl.check('1.2.3.4')).verdict, 'unknown');
});

test('check: definitive verdicts are cached; the canary is not re-probed per connect', async () => {
  const lookup = fakeLookup(['1.2.3.4']);
  const bl = new Dnsbl({ lookup });
  await bl.check('1.2.3.4');
  const afterFirst = lookup.calls.length; // 2 canary probes + 1 lookup
  assert.equal(afterFirst, 3);
  await bl.check('1.2.3.4');
  assert.equal(lookup.calls.length, afterFirst, 'second check for the same IP hit the cache');
});

test('check: an `unknown` verdict is NEVER cached', async () => {
  // Caching an unknown would pin a wrong answer for the process's life.
  let mode = 'unknown';
  const lookup = async (name) => {
    if (name === '2.0.0.127.zen.spamhaus.org') return 'listed';
    if (name === '1.0.0.127.zen.spamhaus.org') return 'clean';
    return mode;
  };
  const bl = new Dnsbl({ lookup });
  assert.equal((await bl.check('5.5.5.5')).verdict, 'unknown');
  mode = 'listed';
  assert.equal((await bl.check('5.5.5.5')).verdict, 'listed', 're-queried instead of serving a cached unknown');
});

test('cache and canary expire together on the TTL', async () => {
  let clock = 0;
  const lookup = fakeLookup(['1.2.3.4']);
  const bl = new Dnsbl({ lookup, cacheTtlMs: 1000, now: () => clock });
  await bl.check('1.2.3.4');
  const first = lookup.calls.length;
  clock = 2000;
  await bl.check('1.2.3.4');
  assert.ok(lookup.calls.length > first, 'expired entries are re-queried');
});

// ---- Domain zone (DBL) -------------------------------------------------------------------
// Separate list, separate return codes. Reusing the IP classifier here is a live false positive,
// which is what most of these pin.

test('classifyDomain: the dedicated spam/phish/malware/botnet codes are listed', () => {
  for (const a of ['127.0.1.2', '127.0.1.4', '127.0.1.5', '127.0.1.6']) {
    assert.equal(classifyDomain([a], null), 'listed', a);
  }
});

test('classifyDomain: "abused legit" codes are listed too (we flag, we never block)', () => {
  for (const a of ['127.0.1.102', '127.0.1.103', '127.0.1.104', '127.0.1.105', '127.0.1.106']) {
    assert.equal(classifyDomain([a], null), 'listed', a);
  }
});

test('classifyDomain: 127.0.1.255 is an ERROR, not a listing', () => {
  // "IP queries prohibited" — what dbl answers when asked about 8.8.8.8. The IP-zone classifier
  // reads this as listed (it matches 127.0.[012].x), which would flag a message as spam on the
  // strength of an error message. This is the whole reason the two classifiers are separate.
  assert.equal(classifyDomain(['127.0.1.255'], null), 'unknown');
  assert.equal(classify(['127.0.1.255'], null), 'listed'); // the bug, pinned so it can't come back
});

test('classifyDomain: NXDOMAIN is clean, everything else is unknown', () => {
  assert.equal(classifyDomain(null, { code: 'ENOTFOUND' }), 'clean');
  assert.equal(classifyDomain([], null), 'clean');
  assert.equal(classifyDomain(null, { code: 'SERVFAIL' }), 'unknown');
  assert.equal(classifyDomain(['127.255.255.254'], null), 'unknown');
  assert.equal(classifyDomain(['10.0.0.1'], null), 'unknown');
});

test('isQueryableDomain rejects what the domain zone cannot answer', () => {
  assert.equal(isQueryableDomain('evil.example.com'), true);
  assert.equal(isQueryableDomain('thiswater.top'), true);
  assert.equal(isQueryableDomain('8.8.8.8'), false); // → the 127.0.1.255 error above
  assert.equal(isQueryableDomain('localhost'), false); // no dot
  assert.equal(isQueryableDomain(''), false);
  assert.equal(isQueryableDomain(undefined), false);
});

const fakeDomainLookup = (listed = [], { breakCanary = false } = {}) => async (name) => {
  if (name === 'dbltest.com.dbl.spamhaus.org') return breakCanary ? 'unknown' : 'listed';
  const d = name.replace('.dbl.spamhaus.org', '');
  return listed.includes(d) ? 'listed' : 'clean';
};

test('checkDomain: a listed sender domain reports listed', async () => {
  const bl = new Dnsbl({ lookupDomain: fakeDomainLookup(['thiswater.top']) });
  assert.deepEqual(await bl.checkDomain('thiswater.top'), { verdict: 'listed', zone: 'dbl.spamhaus.org', canary: true });
  assert.equal((await bl.checkDomain('gmail.com')).verdict, 'clean');
});

test('checkDomain: case and stray punctuation are normalised', async () => {
  const bl = new Dnsbl({ lookupDomain: fakeDomainLookup(['thiswater.top']) });
  assert.equal((await bl.checkDomain('  ThisWater.TOP ')).verdict, 'listed');
});

test('checkDomain: a failed domain canary collapses a listing to unknown', async () => {
  const bl = new Dnsbl({ lookupDomain: fakeDomainLookup(['thiswater.top'], { breakCanary: true }) });
  assert.equal((await bl.checkDomain('thiswater.top')).verdict, 'unknown');
});

test('checkDomain: an unqueryable name never reaches the resolver', async () => {
  let called = 0;
  const bl = new Dnsbl({ lookupDomain: async () => { called++; return 'listed'; } });
  for (const bad of ['8.8.8.8', 'localhost', '', null]) {
    assert.equal((await bl.checkDomain(bad)).verdict, 'unknown');
  }
  assert.equal(called, 0);
});

test('the two zones are independent — a broken DBL leaves the IP check working', async () => {
  // One refused zone should cost one signal, not both.
  const bl = new Dnsbl({
    lookup: fakeLookup(['1.2.3.4']),
    lookupDomain: fakeDomainLookup(['evil.com'], { breakCanary: true }),
  });
  assert.equal((await bl.check('1.2.3.4')).verdict, 'listed');
  assert.equal((await bl.checkDomain('evil.com')).verdict, 'unknown');
});
