// Docs: docs/architecture/anti-spam.md, docs/architecture/mailk-provider.md
// DKIM identity resolution + signing parity.
//
// This plugin used to exist as TWO divergent copies: the repo's (mailn, parent-signing) and an
// untracked fork on the mailk box (per-subdomain signing, 3-arg sign_dkim). They were merged
// into one config-driven file. These tests are the safety net for that merge, because getting
// it wrong doesn't throw — it silently sends mail UNSIGNED or under the wrong identity, and the
// first symptom is a deliverability cliff.
//
// The signing parity tests generate their own RSA key; no secrets involved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const plugin = require('../plugins/mailkite_http_inject.js');

/** Minimal stand-in for the Haraka plugin instance. */
function inst(pool_base, mode, keyDir) {
  return {
    pool_base, dkim_mode: mode,
    dkim_keys: {},
    loginfo() {}, logerror() {},
    resolve_dkim_identity: plugin.resolve_dkim_identity,
    sign_dkim: plugin.sign_dkim,
    load_dkim_key: keyDir
      ? function (domain) {
          if (this.dkim_keys[domain] !== undefined) return this.dkim_keys[domain];
          try {
            const dir = join(keyDir, domain);
            this.dkim_keys[domain] = {
              private_key: require('node:fs').readFileSync(join(dir, 'private'), 'utf8'),
              selector: require('node:fs').readFileSync(join(dir, 'selector'), 'utf8').trim(),
            };
          } catch { this.dkim_keys[domain] = null; }
          return this.dkim_keys[domain];
        }
      : undefined,
  };
}

const id = (pool, mode, from) => plugin.resolve_dkim_identity.call(inst(pool, mode), from);

describe('resolve_dkim_identity — parent mode (pool-b.example behaviour)', () => {
  test('collapses a pool subdomain to the apex for BOTH d= and the key dir', () => {
    assert.deepEqual(id('pool-b.example', 'parent', 'pluckyumbra.pool-b.example'),
      { signDomain: 'pool-b.example', keyDomain: 'pool-b.example' });
  });

  test('the apex itself is unchanged', () => {
    assert.deepEqual(id('pool-b.example', 'parent', 'pool-b.example'),
      { signDomain: 'pool-b.example', keyDomain: 'pool-b.example' });
  });

  test('a customer domain is untouched', () => {
    assert.deepEqual(id('pool-b.example', 'parent', 'shop.example.com'),
      { signDomain: 'shop.example.com', keyDomain: 'shop.example.com' });
  });
});

describe('resolve_dkim_identity — per_sub mode (pool-a.example behaviour)', () => {
  test('signs as the SUBDOMAIN but loads the shared pool key', () => {
    // The distinction that makes per-sub reputation isolation work. Collapsing this to the
    // apex (or looking for a per-sub key dir) is the exact bug that would send unsigned mail.
    assert.deepEqual(id('pool-a.example', 'per_sub', 'evil.pool-a.example'),
      { signDomain: 'evil.pool-a.example', keyDomain: 'pool-a.example' });
  });

  test('a deep subdomain still uses the pool key', () => {
    assert.deepEqual(id('pool-a.example', 'per_sub', 'a.b.pool-a.example'),
      { signDomain: 'a.b.pool-a.example', keyDomain: 'pool-a.example' });
  });

  test('the apex signs as itself', () => {
    assert.deepEqual(id('pool-a.example', 'per_sub', 'pool-a.example'),
      { signDomain: 'pool-a.example', keyDomain: 'pool-a.example' });
  });

  test('a customer domain is untouched', () => {
    assert.deepEqual(id('pool-a.example', 'per_sub', 'shop.example.com'),
      { signDomain: 'shop.example.com', keyDomain: 'shop.example.com' });
  });

  test('a lookalike domain is NOT treated as in-pool', () => {
    // `notpool-a.example` must not match pool base `pool-a.example` — a suffix check without the dot
    // boundary would hand an attacker our pool key.
    assert.deepEqual(id('pool-a.example', 'per_sub', 'notpool-a.example'),
      { signDomain: 'notpool-a.example', keyDomain: 'notpool-a.example' });
  });
});

describe('resolve_dkim_identity — none mode + hygiene', () => {
  test('no pool configured: every domain signs as itself', () => {
    assert.deepEqual(id(null, 'none', 'sub.pool-a.example'),
      { signDomain: 'sub.pool-a.example', keyDomain: 'sub.pool-a.example' });
  });

  test('case is normalised', () => {
    assert.deepEqual(id('pool-a.example', 'per_sub', 'Evil.Pool-A.Example'),
      { signDomain: 'evil.pool-a.example', keyDomain: 'pool-a.example' });
  });
});

describe('sign_dkim — produces the identity the mode selected', () => {
  // One shared key dir at the pool base, exactly like production.
  const keyDir = mkdtempSync(join(tmpdir(), 'dkim-'));
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  for (const base of ['pool-a.example', 'pool-b.example']) {
    mkdirSync(join(keyDir, base), { recursive: true });
    writeFileSync(join(keyDir, base, 'private'), privateKey);
    writeFileSync(join(keyDir, base, 'selector'), 'haraka\n');
  }

  const msg = (from) => [
    `From: Sender <${from}>`, 'To: rcpt@example.org', 'Subject: hi',
    'Date: Thu, 30 Jul 2026 00:00:00 +0000', 'Message-ID: <abc@x>', '', 'body text', '',
  ].join('\r\n');

  function signFor(pool, mode, fromDomain) {
    const i = inst(pool, mode, keyDir);
    const { signDomain, keyDomain } = i.resolve_dkim_identity(fromDomain);
    return i.sign_dkim.call(i, msg(`user@${fromDomain}`), signDomain, keyDomain);
  }

  test('per_sub signs d=<sub> using the pool key — not d=<pool>', () => {
    const hdr = signFor('pool-a.example', 'per_sub', 'evil.pool-a.example');
    assert.match(hdr, /d=evil\.mailk\.us;/);
    assert.match(hdr, /s=haraka;/);
    assert.doesNotMatch(hdr, /d=mailk\.us;/);
  });

  test('parent signs d=<pool> for the same input shape', () => {
    const hdr = signFor('pool-b.example', 'parent', 'sub.pool-b.example');
    assert.match(hdr, /d=mailn\.app;/);
    assert.doesNotMatch(hdr, /d=sub\.mailn\.app;/);
  });

  test('a signature is actually produced and carries a body hash', () => {
    const hdr = signFor('pool-a.example', 'per_sub', 'evil.pool-a.example');
    assert.match(hdr, /^DKIM-Signature: v=1;a=rsa-sha256;c=relaxed\/relaxed;/);
    assert.match(hdr, /bh=[A-Za-z0-9+/=]+;/);
    assert.match(hdr, /b=[A-Za-z0-9+/=]+$/);
  });

  test('a missing key dir yields null (caller sends unsigned and logs) rather than throwing', () => {
    assert.equal(signFor('pool-a.example', 'none', 'nokey.example.com'), null);
  });
});

describe('PLUGIN_VERSION', () => {
  test('is exported so /health can report it', () => {
    assert.match(plugin.PLUGIN_VERSION, /^\d{4}\.\d{2}\.\d{2}-\d+$/);
  });
});
