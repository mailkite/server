// Address pattern matcher — pure unit tests, no server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAddress, normalizePattern, splitAddress } from '../lib/patterns.mjs';

const D = 'example.com';

test('splitAddress lowercases and rejects non-addresses', () => {
  assert.deepEqual(splitAddress('Hello@Example.com'), { local: 'hello', domain: 'example.com' });
  assert.deepEqual(splitAddress('  a@b.co  '), { local: 'a', domain: 'b.co' });
  for (const bad of ['', null, undefined, 'nope', '@example.com', 'hello@', 'hello']) {
    assert.deepEqual(splitAddress(bad), { local: null, domain: null }, String(bad));
  }
  // Only the last @ separates — quoted locals may contain one.
  assert.deepEqual(splitAddress('a@b@example.com'), { local: 'a@b', domain: 'example.com' });
});

test('`*` matches every address on the domain, and nothing off it', () => {
  assert.ok(matchesAddress('*', 'anyone@example.com', D));
  assert.ok(matchesAddress('*', 'first.last+tag@example.com', D));
  assert.ok(!matchesAddress('*', 'anyone@other.com', D), 'no cross-domain match');
  assert.ok(!matchesAddress('*', '@example.com', D), 'empty local part is not an address');
  assert.ok(!matchesAddress('*', 'novalidaddress', D));
});

test('exact patterns are case-insensitive on the local part only', () => {
  assert.ok(matchesAddress('hello', 'hello@example.com', D));
  assert.ok(matchesAddress('Hello', 'HELLO@example.com', D));
  assert.ok(matchesAddress('first.last', 'First.Last@example.com', D), 'dots are literal');
  assert.ok(!matchesAddress('hello', 'hello2@example.com', D));
  assert.ok(!matchesAddress('hello', 'ahello@example.com', D));
  assert.ok(!matchesAddress('hello', 'hello@example.com.evil.com', D));
});

test('prefix, suffix and infix globs', () => {
  assert.ok(matchesAddress('support-*', 'support-billing@example.com', D));
  assert.ok(matchesAddress('support-*', 'support-@example.com', D), '* may match nothing');
  assert.ok(!matchesAddress('support-*', 'support@example.com', D));
  assert.ok(!matchesAddress('support-*', 'x-support-y@example.com', D), 'anchored at the start');

  assert.ok(matchesAddress('*-agent', 'billing-agent@example.com', D));
  assert.ok(!matchesAddress('*-agent', 'agent-billing@example.com', D));

  assert.ok(matchesAddress('ticket+*', 'ticket+123@example.com', D), 'plus-addressing');
  assert.ok(matchesAddress('*bot*', 'my-bot-9@example.com', D));
});

test('a glob never escapes the local part or the domain', () => {
  assert.ok(!matchesAddress('*', 'user@sub.example.com', D));
  assert.ok(!matchesAddress('a*', 'a@example.com.attacker.com', D));
  // Regex metacharacters in a pattern are literal, not operators.
  assert.ok(!matchesAddress('a.c', 'abc@example.com', D));
  assert.ok(matchesAddress('a.c', 'a.c@example.com', D));
});

test('full-address patterns work and are domain-pinned', () => {
  assert.ok(matchesAddress('*@example.com', 'anyone@example.com', D));
  assert.ok(matchesAddress('hello@example.com', 'hello@example.com', D));
  assert.ok(!matchesAddress('*@other.com', 'anyone@example.com', D), 'pattern domain must equal scope');
  assert.ok(!matchesAddress('@example.com', 'anyone@example.com', D), 'empty local pattern');
});

test('empty/blank inputs never match', () => {
  for (const p of ['', '   ', null, undefined]) {
    assert.ok(!matchesAddress(p, 'hello@example.com', D), `pattern ${JSON.stringify(p)}`);
  }
  assert.ok(!matchesAddress('*', 'hello@example.com', ''), 'no scope domain');
});

test('normalizePattern reduces to a storable local-part form', () => {
  assert.equal(normalizePattern('*', D), '*');
  assert.equal(normalizePattern('  Hello  ', D), 'hello');
  assert.equal(normalizePattern('*@example.com', D), '*');
  assert.equal(normalizePattern('hello@EXAMPLE.com', D), 'hello');
  assert.equal(normalizePattern('hello@other.com', D), null, 'other domain is not storable');
  assert.equal(normalizePattern('', D), null);
  assert.equal(normalizePattern('has space', D), null);
  assert.equal(normalizePattern('@example.com', D), null);
});
