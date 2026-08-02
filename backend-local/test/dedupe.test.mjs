// Ingest idempotency: the same signed message re-delivered for the same recipient must
// not duplicate (multi-backend edges DENYSOFT when a sibling backend fails, so senders
// legitimately re-deliver to backends that already stored the message).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'dedupe-test-secret';
const PORT = 18789;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;
let proc, dataDir, apiKey;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-dedupe-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-user', 'd'], { env });
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-domain', 'dd.example', 'd'], { env });
  apiKey = execFileSync('node', [join(dir, 'cli.mjs'), 'add-key', 'd'], { env }).toString().trim();
  proc = spawn('node', [join(dir, 'server.mjs')],
    { env: { ...env, HMAC_SECRET: SECRET, PORT: String(PORT) }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

const ingest = (raw) => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(raw).digest('hex');
  return fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: { 'x-mailkite-signature': `t=${ts},v1=${sig}`, 'x-mailkite-rcpt': 'in@dd.example' },
    body: raw,
  });
};

test('re-delivering the same message to the same recipient dedupes', async () => {
  const raw = Buffer.from('From: x@y.example\r\nTo: in@dd.example\r\nSubject: once\r\n\r\nonly once\r\n');

  const first = await (await ingest(raw)).json();
  assert.deepEqual({ stored: first.stored, deduped: first.deduped }, { stored: 1, deduped: 0 });

  const second = await (await ingest(raw)).json();
  assert.deepEqual({ stored: second.stored, deduped: second.deduped }, { stored: 0, deduped: 1 });

  // Count through the contract API (the admin API is bound to the implicit 'default'
  // account; this test's domain belongs to CLI user 'd').
  const { userId } = await (await fetch(BASE + '/api/smtp/auth', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ key: apiKey }),
  })).json();
  const list = await (await fetch(BASE + '/api/imap/list', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ userId, mailboxId: null, mailbox: 'INBOX' }),
  })).json();
  assert.equal(list.messages.length, 1, 'INBOX holds exactly one copy');

  // A different message for the same recipient still stores.
  const other = Buffer.from('From: x@y.example\r\nTo: in@dd.example\r\nSubject: two\r\n\r\ndifferent\r\n');
  const third = await (await ingest(other)).json();
  assert.deepEqual({ stored: third.stored, deduped: third.deduped }, { stored: 1, deduped: 0 });
});
