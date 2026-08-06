// The BYO-key LLM module — pure unit tests, no network and no server.
//
// The security-relevant behaviour here is parseDecision: it turns whatever a model felt
// like emitting into one of three actions, and anything it can't understand must become
// `none`. A wrong answer is a mail that shouldn't have been sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, PROVIDER_IDS, parseDecision, resolveProvider } from '../lib/ai.mjs';

test('every provider resolves to a usable call shape', () => {
  for (const id of PROVIDER_IDS) {
    const spec = PROVIDERS[id];
    // `custom` is the one that deliberately carries no defaults — the operator supplies them.
    const r = resolveProvider(id === 'custom'
      ? { provider: id, baseUrl: 'http://localhost:11434/v1', model: 'llama3' }
      : { provider: id });
    assert.equal(r.error, undefined, `${id}: ${r.error}`);
    assert.ok(r.model, `${id} resolves a model`);
    if (spec.wire === 'openai') assert.match(r.baseUrl, /^https?:\/\//, `${id} resolves a base URL`);
  }
});

test('an unknown provider is refused, and says what is valid', () => {
  const r = resolveProvider({ provider: 'gpt5-turbo-max' });
  assert.match(r.error, /unknown AI provider/);
  assert.match(r.error, /openrouter/, 'lists the valid ids');
});

test('custom needs a base URL; overrides win over defaults', () => {
  assert.match(resolveProvider({ provider: 'custom', model: 'x' }).error, /needs a base URL/);
  const r = resolveProvider({ provider: 'openai', baseUrl: 'https://proxy.internal/v1/', model: 'gpt-4o' });
  assert.equal(r.baseUrl, 'https://proxy.internal/v1', 'trailing slash trimmed');
  assert.equal(r.model, 'gpt-4o');
});

test('parseDecision reads a bare object', () => {
  const d = parseDecision('{"action":"reply","subject":"Hi","body":"Thanks!"}');
  assert.deepEqual(d, { action: 'reply', to: null, subject: 'Hi', body: 'Thanks!' });
});

test('parseDecision digs the object out of prose and code fences', () => {
  const wrapped = 'Sure! Here is my decision:\n```json\n{"action":"forward","to":"a@b.co","body":"fyi"}\n```\nHope that helps.';
  assert.equal(parseDecision(wrapped).action, 'forward');
  assert.equal(parseDecision(wrapped).to, 'a@b.co');
});

test('parseDecision survives nested objects and braces inside strings', () => {
  const d = parseDecision('{"action":"reply","body":"use {curly} braces \\" like this","subject":"x"}');
  assert.equal(d.action, 'reply');
  assert.equal(d.body, 'use {curly} braces " like this');
});

test('anything unparseable or unknown becomes `none` — never an accidental send', () => {
  for (const junk of ['', null, undefined, 'I think you should reply to this!', '{', '{"action":', 'null',
                      '{"action":"delete_everything"}', '{"action":"REPLY"}', '{}']) {
    assert.equal(parseDecision(junk).action, 'none', JSON.stringify(junk));
  }
});

test('non-string fields are dropped rather than passed through to the mailer', () => {
  const d = parseDecision('{"action":"forward","to":["a@b.co"],"subject":42,"body":{"x":1}}');
  assert.equal(d.action, 'forward');
  assert.equal(d.to, null, 'an array is not an address');
  assert.equal(d.subject, null);
  assert.equal(d.body, '', 'body always ends up a string');
});
