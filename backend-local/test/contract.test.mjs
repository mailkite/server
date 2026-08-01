// Conformance suite for docs/contract.md. By default it boots backend-local on an
// ephemeral port with a temp DATA_DIR and exercises every endpoint the edges call.
// Point it at another backend with BACKEND_URL (+ HMAC_SECRET, and pre-provisioned
// fixtures) to test contract parity.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTERNAL = !!process.env.BACKEND_URL;
const SECRET = process.env.HMAC_SECRET || 'test-secret';
const PORT = 18787;
let BASE = process.env.BACKEND_URL || `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;

let proc, dataDir, apiKey, appPassword;
const RAW = Buffer.from(
  'From: Alice <alice@sender.example>\r\nTo: bob@local.example\r\n' +
  'Subject: =?utf-8?q?hello_=E2=9C=93?=\r\nDate: Fri, 01 Aug 2026 00:00:00 +0000\r\n\r\nhi there\r\n');

const edge = (path, body, extra = {}) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json', ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  if (EXTERNAL) { apiKey = process.env.API_KEY; appPassword = process.env.APP_PASSWORD; return; }
  dataDir = mkdtempSync(join(tmpdir(), 'mk-backend-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-user', 'tester'], { env });
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-domain', 'local.example', 'tester'], { env });
  apiKey = execFileSync('node', [join(dir, 'cli.mjs'), 'add-key', 'tester'], { env }).toString().trim();
  appPassword = execFileSync('node', [join(dir, 'cli.mjs'), 'add-app-password', 'bob@local.example'], { env }).toString().trim();
  proc = spawn('node', [join(dir, 'server.mjs')], { env: { ...env, HMAC_SECRET: SECRET, PORT: String(PORT) }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => { if (proc) proc.kill(); if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });

const signed = (raw, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => {
  const sig = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  return `t=${ts},v1=${sig}`;
};

test('accepted-domains: requires edge auth, returns hosted domains', async () => {
  const bad = await fetch(BASE + '/api/mx/accepted-domains');
  assert.equal(bad.status, 401);
  const res = await edge('/api/mx/accepted-domains');
  assert.equal(res.status, 200);
  const { domains } = await res.json();
  assert.ok(domains.includes('local.example'));
});

test('ingest: rejects bad signature, accepts valid HMAC + stores to INBOX', async () => {
  const reject = await fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: { 'x-mailkite-signature': signed(RAW, 'wrong-secret'), 'x-mailkite-rcpt': 'bob@local.example' },
    body: RAW,
  });
  assert.equal(reject.status, 401);

  const stale = await fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: { 'x-mailkite-signature': signed(RAW, SECRET, Math.floor(Date.now() / 1000) - 3600), 'x-mailkite-rcpt': 'bob@local.example' },
    body: RAW,
  });
  assert.equal(stale.status, 401, 'stale timestamp must be rejected');

  const ok = await fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: {
      'x-mailkite-signature': signed(RAW),
      'x-mailkite-rcpt': 'bob@local.example',
      'x-mailkite-mailfrom': 'alice@sender.example',
      'x-mailkite-spf': 'pass',
    },
    body: RAW,
  });
  assert.equal(ok.status, 200);
});

test('smtp auth: valid key → {ok,userId}; bogus → {ok:false}', async () => {
  const good = await (await edge('/api/smtp/auth', { key: apiKey })).json();
  assert.equal(good.ok, true);
  assert.notEqual(good.userId, undefined);
  const bad = await (await edge('/api/smtp/auth', { key: 'mk_local_bogus' })).json();
  assert.equal(bad.ok, false);
});

test('relay: bad key 401, foreign From 4xx, valid send stores Sent + loops local INBOX', async () => {
  const post = (key, raw) => fetch(BASE + '/api/relay', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'message/rfc822', 'x-mailkite-rcpt': 'bob@local.example' },
    body: raw,
  });
  assert.equal((await post('mk_local_bogus', RAW)).status, 401);

  const foreign = await post(apiKey, RAW); // From: alice@sender.example — not our domain
  assert.ok(foreign.status >= 400 && foreign.status < 500, 'unowned From domain must 4xx');

  const ours = Buffer.from('From: bob@local.example\r\nTo: bob@local.example\r\nSubject: loop\r\n\r\nself\r\n');
  const ok = await post(apiKey, ours);
  assert.equal(ok.status, 200);
});

test('imap auth: bad creds {ok:false}, good creds return account', async () => {
  const bad = await (await edge('/api/imap/auth', { username: 'bob@local.example', password: 'nope', ip: '203.0.113.9' })).json();
  assert.equal(bad.ok, false);
  const good = await (await edge('/api/imap/auth', { username: 'bob@local.example', password: appPassword, ip: '203.0.113.9' })).json();
  assert.equal(good.ok, true);
  assert.equal(good.domain, 'local.example');
  assert.ok('mailboxId' in good);
});

test('imap status/list/raw/flags round-trip', async () => {
  const { userId } = await (await edge('/api/imap/auth', { username: 'bob@local.example', password: appPassword, ip: '' })).json();

  const st = await (await edge('/api/imap/status', { userId, mailboxId: null, mailbox: 'INBOX' })).json();
  assert.ok(st.total >= 1, 'ingested message visible');
  assert.ok(st.uidvalidity > 0 && st.uidnext > st.total - 1);
  assert.ok(st.unseen >= 1);

  const { messages } = await (await edge('/api/imap/list', { userId, mailboxId: null, mailbox: 'INBOX' })).json();
  assert.equal(messages.length, st.total);
  const m = messages[0];
  assert.equal(m.from_addr, 'alice@sender.example');
  assert.equal(m.to_addr, 'bob@local.example');
  assert.equal(m.subject, 'hello ✓', 'RFC2047 subject decoded');
  assert.ok(!m.flags.includes('\\'), 'flags are backslash-less');

  const rawRes = await edge('/api/imap/raw', { userId, mailboxId: null, mailbox: 'INBOX', uid: m.uid });
  assert.equal(rawRes.status, 200);
  assert.deepEqual(Buffer.from(await rawRes.arrayBuffer()), RAW, 'raw bytes stored verbatim');

  const missing = await edge('/api/imap/raw', { userId, mailboxId: null, mailbox: 'INBOX', uid: 999999 });
  assert.ok(missing.status >= 400, 'missing raw is non-2xx');

  assert.equal((await edge('/api/imap/flags', { userId, mailboxId: null, mailbox: 'INBOX', uid: m.uid, flags: 'Seen Flagged' })).status, 200);
  const after = await (await edge('/api/imap/list', { userId, mailboxId: null, mailbox: 'INBOX' })).json();
  assert.equal(after.messages.find((x) => x.uid === m.uid).flags, 'Seen Flagged');
  const st2 = await (await edge('/api/imap/status', { userId, mailboxId: null, mailbox: 'INBOX' })).json();
  assert.equal(st2.unseen, st.unseen - 1);
});

test('relay Sent mailbox is visible over the IMAP read API', async () => {
  const { userId } = await (await edge('/api/imap/auth', { username: 'bob@local.example', password: appPassword, ip: '' })).json();
  const { messages } = await (await edge('/api/imap/list', { userId, mailboxId: null, mailbox: 'Sent' })).json();
  assert.ok(messages.length >= 1);
  assert.equal(messages[0].subject, 'loop');
  assert.ok(messages[0].flags.includes('Seen'), 'sent mail starts Seen');
});

test('imap auth lockout: repeated failures from one IP get locked out', async () => {
  if (EXTERNAL) return; // lockout thresholds are implementation detail; only assert on ours
  const ip = '198.51.100.7';
  for (let i = 0; i < 20; i++) {
    await edge('/api/imap/auth', { username: 'bob@local.example', password: 'wrong', ip });
  }
  const res = await edge('/api/imap/auth', { username: 'bob@local.example', password: appPassword, ip });
  assert.equal(res.status, 429, 'locked-out IP is refused even with valid creds');
});
