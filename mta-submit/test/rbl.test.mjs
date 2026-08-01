// Docs: docs/architecture/anti-spam.md §3
// The DNSBL return-code classifier — the exact spot the original outage lived.
//
// The Worker used to query Spamhaus through a PUBLIC resolver. Spamhaus refuses those and
// answers `127.255.255.254` ("query via public resolver") to EVERY name, including its own test
// points. The old check was `addr.startsWith('127.0.0.')`, so a refusal fell through to "not
// listed" and the whole layer silently reported clean for weeks.
//
// These run with the Node built-in test runner (no dependency): `npm test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Safe to require standalone: the plugin's top-level requires are all Node core, and
// haraka_require() is only reached inside register(), which we never call.
const { classify_rbl, reverse_ip } = require('../plugins/mailkite_http_inject.js');

describe('classify_rbl', () => {
  test('a zen listing is listed', () => {
    assert.equal(classify_rbl(['127.0.0.2'], null), 'listed');
    assert.equal(classify_rbl(['127.0.0.10'], null), 'listed');
  });

  test('a dbl listing is listed', () => {
    assert.equal(classify_rbl(['127.0.1.2'], null), 'listed');
  });

  test('a zrd listing is listed', () => {
    assert.equal(classify_rbl(['127.0.2.3'], null), 'listed');
  });

  // THE REGRESSION. Every one of these was read as "not listed" by the old code.
  test('a 127.255.255.x control code is UNKNOWN, never clean and never listed', () => {
    assert.equal(classify_rbl(['127.255.255.254'], null), 'unknown'); // public resolver refused
    assert.equal(classify_rbl(['127.255.255.252'], null), 'unknown'); // query prohibited
    assert.equal(classify_rbl(['127.255.255.255'], null), 'unknown'); // over quota
  });

  test('NXDOMAIN is clean — the only way to earn a clean verdict', () => {
    assert.equal(classify_rbl(null, { code: 'ENOTFOUND' }), 'clean');
    assert.equal(classify_rbl(null, { code: 'ENODATA' }), 'clean');
    assert.equal(classify_rbl([], null), 'clean');
  });

  test('a resolver failure is unknown, not clean', () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']) {
      assert.equal(classify_rbl(null, { code }), 'unknown', `${code} must be unknown`);
    }
  });

  test('an answer outside both ranges is unknown — something is intercepting DNS', () => {
    // A captive portal or wildcard resolver answering 1.2.3.4 must not read as a listing OR
    // as clean; both would be fabricated confidence.
    assert.equal(classify_rbl(['1.2.3.4'], null), 'unknown');
    assert.equal(classify_rbl(['0.0.0.0'], null), 'unknown');
  });

  test('a control code mixed with a listing still reads unknown', () => {
    // Defensive: if any part of the answer says "we refused you", trust none of it.
    assert.equal(classify_rbl(['127.0.0.2', '127.255.255.254'], null), 'unknown');
  });
});

describe('reverse_ip', () => {
  test('reverses the octets for DNSBL query form', () => {
    assert.equal(reverse_ip('203.0.113.63'), '63.113.0.203');
    assert.equal(reverse_ip('127.0.0.2'), '2.0.0.127');
  });
});
