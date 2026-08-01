// Admin API tests — the surface ui/'s `local` provider driver consumes.
// backend-local only (not part of the cross-backend contract suite).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'admin-test-secret';
const PORT = 18788;
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
  assert.equal(o.capabilities.outboundInternet, false, 'v1 must not claim internet outbound');
  assert.equal(o.capabilities.webhooks, false);
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
  assert.ok(password.startsWith('mk_imap_'));

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
