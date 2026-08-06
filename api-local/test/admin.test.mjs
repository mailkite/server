// Admin API tests — the surface ui/'s `local` provider driver consumes.
// api-local only (not part of the cross-backend contract suite).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'admin-test-secret';
const PORT = 20000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;
let proc, dataDir;

const admin = (path, body) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-admin-'));
  proc = spawn('node', [join(dir, 'server.mjs')],
    { env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(PORT) }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/admin/overview'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('admin endpoints require the edge bearer', async () => {
  for (const p of ['/api/admin/overview', '/api/admin/domains', '/api/admin/credentials', '/api/admin/messages']) {
    assert.equal((await fetch(BASE + p)).status, 401, p);
  }
});

test('overview reports capabilities honestly', async () => {
  const o = await (await admin('/api/admin/overview')).json();
  assert.equal(o.capabilities.inbound, true);
  assert.equal(o.capabilities.webhooks, true, 'webhook dispatch ships in api-local');
  // This instance runs without SMARTHOST, so it must not claim internet outbound.
  assert.equal(o.capabilities.outboundInternet, false);
  assert.equal(o.capabilities.routes, true, 'per-address routes ship in api-local (docs/routes.md)');
});

test('domain add/list, validation, and credential issuance', async () => {
  assert.equal((await admin('/api/admin/domains', { domain: 'not a domain' })).status, 400);
  assert.equal((await admin('/api/admin/domains', { domain: 'Apps.Example' })).status, 200);
  const { domains } = await (await admin('/api/admin/domains')).json();
  assert.ok(domains.includes('apps.example'), 'lowercased');

  const { key } = await (await admin('/api/admin/keys', {})).json();
  assert.ok(key.startsWith('mk_local_'));

  const badPw = await admin('/api/admin/app-passwords', { username: 'x@elsewhere.example' });
  assert.equal(badPw.status, 400, 'app-password only for hosted domains');
  const { password } = await (await admin('/api/admin/app-passwords', { username: 'inbox@apps.example' })).json();
  assert.ok(password.startsWith('mk_pw_'), 'new app passwords use the universal prefix');

  const creds = await (await admin('/api/admin/credentials')).json();
  assert.deepEqual(creds.apiKeys, [key]);
  assert.deepEqual(creds.appPasswords, ['inbox@apps.example']);
});

test('paged messages + raw view', async () => {
  // Ingest 3 signed messages the way the MX edge does.
  for (let i = 1; i <= 3; i++) {
    const raw = Buffer.from(`From: a@b.example\r\nTo: inbox@apps.example\r\nSubject: msg ${i}\r\n\r\nbody ${i}\r\n`);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(raw).digest('hex');
    const r = await fetch(BASE + '/api/ingest', {
      method: 'POST',
      headers: { 'x-mailkite-signature': `t=${ts},v1=${sig}`, 'x-mailkite-rcpt': 'inbox@apps.example' },
      body: raw,
    });
    assert.equal(r.status, 200);
  }
  const page1 = await (await admin('/api/admin/messages?mailbox=INBOX&limit=2')).json();
  assert.equal(page1.messages.length, 2);
  assert.equal(page1.messages[0].subject, 'msg 3', 'newest first');
  assert.ok(page1.nextBefore, 'cursor for next page');
  const page2 = await (await admin(`/api/admin/messages?mailbox=INBOX&limit=2&before=${page1.nextBefore}`)).json();
  assert.equal(page2.messages[0].subject, 'msg 1');
  assert.equal(page2.nextBefore, null);

  const raw = await admin(`/api/admin/raw?mailbox=INBOX&uid=${page1.messages[0].uid}`);
  assert.equal(raw.status, 200);
  assert.match(await raw.text(), /Subject: msg 3/);
});

// Routes (docs/routes.md). The API-shaped half; lib/routing.test.mjs covers dispatch.
const patch = (path, body) => fetch(BASE + path, {
  method: 'PATCH',
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('routes: create, validate, and list', async () => {
  const bad = async (body, code) => {
    const r = await admin('/api/admin/routes', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).code, code, JSON.stringify(body));
  };
  await bad({ domain: 'nothosted.example', matchPattern: '*', action: 'webhook', destination: 'https://x.test' }, 'bad_domain');
  await bad({ domain: 'apps.example', matchPattern: 'a b', action: 'webhook', destination: 'https://x.test' }, 'bad_pattern');
  await bad({ domain: 'apps.example', matchPattern: '*', action: 'teleport' }, 'bad_action');
  await bad({ domain: 'apps.example', matchPattern: '*', action: 'webhook', destination: 'ftp://x.test' }, 'bad_url');
  await bad({ domain: 'apps.example', matchPattern: '*', action: 'forward', destination: 'not-an-address' }, 'bad_destination');
  // An agent route must be runnable the moment it exists: prompt, provider, and key.
  await bad({ domain: 'apps.example', matchPattern: 'ai', action: 'agent', aiProvider: 'openai', aiApiKey: 'sk-x' }, 'bad_prompt');
  await bad({ domain: 'apps.example', matchPattern: 'ai', action: 'agent', agentPrompt: 'Help.', aiProvider: 'nope', aiApiKey: 'sk-x' }, 'bad_provider');
  await bad({ domain: 'apps.example', matchPattern: 'ai', action: 'agent', agentPrompt: 'Help.', aiProvider: 'openai' }, 'no_api_key');
  await bad({ domain: 'apps.example', matchPattern: 'ai', action: 'agent', agentPrompt: 'Help.', aiProvider: 'custom', aiApiKey: 'sk-x' }, 'bad_provider');

  const hook = await (await admin('/api/admin/routes', {
    domain: 'Apps.Example', matchPattern: 'Support@Apps.Example', action: 'webhook', destination: 'https://x.test/hook',
  })).json();
  assert.equal(hook.match_pattern, 'support', 'full-address form is normalized to the local part');
  assert.ok(hook.webhook_secret.startsWith('whsec_'), 'a webhook route signs with its own secret');

  const agent = await (await admin('/api/admin/routes', {
    domain: 'apps.example', matchPattern: 'ai', action: 'agent', agentPrompt: 'Answer politely.',
    aiProvider: 'openrouter', aiApiKey: 'sk-secret-value', agentForwardTo: ['human@apps.example'],
  })).json();
  assert.equal(agent.hasAiKey, true);
  assert.equal(JSON.stringify(agent).includes('sk-secret-value'), false, 'the key is never echoed back');

  const { routes, providers } = await (await admin('/api/admin/routes')).json();
  assert.equal(routes.length, 2);
  assert.ok(providers.some((p) => p.id === 'openrouter'), 'the console renders its dropdown from this');
  assert.equal(JSON.stringify(routes).includes('sk-secret-value'), false, 'nor in the listing');
});

test('routes: edit, immutability, rotate, delete', async () => {
  const { routes } = await (await admin('/api/admin/routes')).json();
  const hook = routes.find((r) => r.action === 'webhook');
  const agent = routes.find((r) => r.action === 'agent');

  assert.equal((await patch(`/api/admin/routes/${hook.id}`, { domain: 'other.example' })).status, 400);
  assert.equal((await patch(`/api/admin/routes/${hook.id}`, { action: 'agent' })).status, 400);
  assert.equal((await patch('/api/admin/routes/999999', { destination: 'https://y.test' })).status, 404);

  const edited = await (await patch(`/api/admin/routes/${hook.id}`, { destination: 'https://y.test/hook', active: false })).json();
  assert.equal(edited.destination, 'https://y.test/hook');
  assert.equal(edited.active, false);

  // An edit that doesn't mention the key keeps it — re-entering a secret to rename a route
  // is how keys end up in chat logs.
  const kept = await (await patch(`/api/admin/routes/${agent.id}`, { agentPrompt: 'Answer briefly.' })).json();
  assert.equal(kept.hasAiKey, true);
  assert.equal(kept.agent_prompt, 'Answer briefly.');
  // But it must still be a valid agent route afterwards.
  assert.equal((await patch(`/api/admin/routes/${agent.id}`, { agentPrompt: '   ' })).status, 400);
  assert.equal((await patch(`/api/admin/routes/${agent.id}`, { agentForwardTo: ['nope'] })).status, 400);

  const rotated = await (await admin(`/api/admin/routes/${hook.id}/rotate`, {})).json();
  assert.ok(rotated.secret.startsWith('whsec_'));
  assert.notEqual(rotated.secret, hook.webhook_secret, 'the old secret stops verifying');
  assert.equal((await admin(`/api/admin/routes/${agent.id}/rotate`, {})).status, 404, 'only webhook routes have one');

  const del = await fetch(BASE + `/api/admin/routes/${hook.id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + SECRET } });
  assert.equal(del.status, 200);
  const after = await (await admin('/api/admin/routes')).json();
  assert.equal(after.routes.length, 1);
});

test('routes: a matching webhook route queues its own delivery', async () => {
  const { routes } = await (await admin('/api/admin/routes')).json();
  for (const r of routes) {
    await fetch(BASE + `/api/admin/routes/${r.id}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + SECRET } });
  }
  await admin('/api/admin/routes', {
    domain: 'apps.example', matchPattern: 'routed', action: 'webhook', destination: 'http://127.0.0.1:1/unreachable',
  });

  const raw = Buffer.from('From: a@b.example\r\nTo: routed@apps.example\r\nSubject: routed\r\n\r\nhi\r\n');
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(raw).digest('hex');
  const r = await fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: { 'x-mailkite-signature': `t=${ts},v1=${sig}`, 'x-mailkite-rcpt': 'routed@apps.example' },
    body: raw,
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).webhooksQueued, 1, 'the route queued one, with no domain webhook set');

  const status = await (await admin('/api/admin/domains/webhook-status?domain=apps.example')).json();
  assert.ok(status.recent.some((d) => d.url === 'http://127.0.0.1:1/unreachable'), 'queued against the shared retry queue');
});
