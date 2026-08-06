// Route matching + the agent action's containment rules (docs/routes.md §5.1).
//
// The dispatch path runs unattended on mail from strangers, so most of what's asserted
// here is what the agent CANNOT be talked into: forwarding somewhere the owner didn't
// nominate, or choosing its own reply recipient. A model stub stands in for the provider
// — these tests are about the code around the model, which is where the boundary lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/db.mjs';
import { forwardAllowed, forwardAllowlist, matchRoutes, runAgentRoute, agentSystemPrompt } from '../lib/routing.mjs';

// Sealing the AI key needs HMAC_SECRET; the store reads it at call time.
process.env.HMAC_SECRET = process.env.HMAC_SECRET || 'routing-test-secret';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mk-routing-'));
  const store = new Store(dir);
  const userId = store.addUser('routing-test');
  store.addDomain('example.com', userId);
  return { store, userId, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const agentRoute = (store, userId, over = {}) => store.addRoute({
  userId, domain: 'example.com', matchPattern: 'support', action: 'agent',
  agentPrompt: 'Answer politely.', aiProvider: 'openai', aiApiKey: 'sk-test-key', ...over,
});

const inbound = (over = {}) => ({
  from: 'stranger@elsewhere.test', to: 'support@example.com',
  subject: 'Help', body: 'My widget broke.', messageId: '<abc@elsewhere.test>', ...over,
});

// Records what would have been sent instead of sending it.
const recorder = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); } }; };

test('matching fans out to every active route for the address', () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const a = store.addRoute({ userId, domain: 'example.com', matchPattern: '*', action: 'webhook', destination: 'https://a.test/hook' });
    const b = store.addRoute({ userId, domain: 'example.com', matchPattern: 'support', action: 'forward', destination: 'human@example.com' });
    const off = store.addRoute({ userId, domain: 'example.com', matchPattern: '*', action: 'webhook', destination: 'https://off.test/hook' });
    store.updateRoute(off.id, { active: false });

    const matched = matchRoutes(store, 'support@example.com', 'example.com', userId);
    assert.deepEqual(matched.map((r) => r.id).sort(), [a.id, b.id].sort(), 'both match, inactive excluded');

    assert.equal(matchRoutes(store, 'other@example.com', 'example.com', userId).length, 1, 'only the wildcard');
    assert.equal(matchRoutes(store, 'support@example.com', 'example.com', userId + 999).length, 0,
      'a route never captures another account\'s mail');
  } finally { cleanup(); }
});

test('the forward allowlist covers owned domains and the route list, nothing else', () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId, { agentForwardTo: ['escalation@partner.test'] });
    const allow = forwardAllowlist(store, route);

    assert.ok(forwardAllowed('anyone@example.com', allow), 'any address on an owned domain');
    assert.ok(forwardAllowed('escalation@partner.test', allow), 'explicitly nominated');
    assert.ok(forwardAllowed('  Escalation@Partner.TEST ', allow), 'case and space insensitive');

    for (const bad of ['attacker@evil.test', '', null, 'not-an-address', 'a@evil.test']) {
      assert.ok(!forwardAllowed(bad, allow), `refused: ${JSON.stringify(bad)}`);
    }
  } finally { cleanup(); }
});

test('a reply goes to the sender, from the receiving address — the model does not choose', async () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId);
    const { sent, send } = recorder();
    // The model tries to redirect the reply; `to` is not a field it controls for a reply.
    const completeImpl = async () => '{"action":"reply","to":"attacker@evil.test","subject":"Re: Help","body":"Here you go"}';
    const r = await runAgentRoute(store, route, inbound(), { send, completeImpl });

    assert.deepEqual({ ok: r.ok, action: r.action }, { ok: true, action: 'reply' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'stranger@elsewhere.test', 'pinned to the original sender');
    assert.equal(sent[0].from, 'support@example.com', 'pinned to the receiving address');
    assert.equal(sent[0].inReplyTo, '<abc@elsewhere.test>', 'threads onto the original');
  } finally { cleanup(); }
});

test('a forward to an address the owner never nominated is refused, and nothing is sent', async () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId, { agentForwardTo: ['ok@partner.test'] });
    const { sent, send } = recorder();
    const completeImpl = async () => '{"action":"forward","to":"attacker@evil.test","body":"exfil"}';
    const r = await runAgentRoute(store, route, inbound(), { send, completeImpl });

    assert.equal(r.ok, false);
    assert.match(r.error, /refused forward/);
    assert.equal(sent.length, 0, 'the refusal is enforced before sending, not after');
  } finally { cleanup(); }
});

test('an allowed forward carries the original message', async () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId, { agentForwardTo: ['ok@partner.test'] });
    const { sent, send } = recorder();
    const completeImpl = async () => '{"action":"forward","to":"ok@partner.test","body":"escalating"}';
    const r = await runAgentRoute(store, route, inbound(), { send, completeImpl });

    assert.equal(r.action, 'forward');
    assert.equal(sent[0].to, 'ok@partner.test');
    assert.match(sent[0].text, /My widget broke/, 'the original body travels with it');
    assert.match(sent[0].text, /stranger@elsewhere\.test/, 'and who it came from');
  } finally { cleanup(); }
});

test('a provider failure or junk reply sends nothing and never throws', async () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId);
    const { sent, send } = recorder();

    const boom = await runAgentRoute(store, route, inbound(), {
      send, completeImpl: async () => { throw new Error('402 payment required'); },
    });
    assert.equal(boom.ok, false);
    assert.match(boom.error, /402/);

    const junk = await runAgentRoute(store, route, inbound(), { send, completeImpl: async () => 'I would reply, probably.' });
    assert.deepEqual({ ok: junk.ok, action: junk.action }, { ok: true, action: 'none' });
    assert.equal(sent.length, 0, 'neither case sends mail');
  } finally { cleanup(); }
});

test('a route whose key cannot be unsealed does nothing rather than calling out unauthenticated', async () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId);
    // What a rotated HMAC_SECRET looks like from here: the sealed value no longer opens.
    store.db.prepare('UPDATE routes SET ai_api_key_enc = ? WHERE id = ?').run('not.a.sealed.value', route.id);
    const { sent, send } = recorder();
    let called = false;
    const r = await runAgentRoute(store, store.route(route.id), inbound(), {
      send, completeImpl: async () => { called = true; return '{"action":"reply","body":"hi"}'; },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /HMAC_SECRET rotated/);
    assert.equal(called, false, 'the provider is never called without a key');
    assert.equal(sent.length, 0);
  } finally { cleanup(); }
});

test('the AI key is never readable through the public route shape', () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId);
    assert.equal(route.hasAiKey, true, 'the console can tell it is configured');
    assert.equal(JSON.stringify(route).includes('sk-test-key'), false, 'but never sees the value');
    assert.equal(store.routeAiKey(route.id), 'sk-test-key', 'the runner still gets it');
  } finally { cleanup(); }
});

test('the system prompt names the allowed destinations and frames the mail as untrusted', () => {
  const { store, userId, cleanup } = freshStore();
  try {
    const route = agentRoute(store, userId, { agentForwardTo: ['ok@partner.test'] });
    const prompt = agentSystemPrompt(route, ['ok@partner.test']);
    assert.match(prompt, /ok@partner\.test/, 'so the model picks a destination that will be accepted');
    assert.match(prompt, /UNTRUSTED/);
    assert.match(prompt, /Answer politely\./, "the owner's instructions are included");

    const noForward = agentSystemPrompt(route, []);
    assert.match(noForward, /forward is unavailable/, 'no allowed addresses means no forward offer');
  } finally { cleanup(); }
});
