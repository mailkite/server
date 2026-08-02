#!/usr/bin/env node
// End-to-end smoke: api-local + the real imap/ edge daemon.
//
//   api-local (HTTP contract) ← imap/server.js (imap-core) ← this script (TLS IMAP client)
//
// Boots both processes with a temp data dir + self-signed cert, ingests a signed message
// the same way mta/plugins/mailkite_ingest.js does, then runs a real IMAP session:
// LOGIN → SELECT INBOX → FETCH (ENVELOPE/FLAGS) → UID STORE \Seen → LOGOUT.
//
// Requires: node >= 22.5, `npm ci` done in imap/, openssl on PATH.
// Usage: node scripts/e2e-imap.mjs

import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';

const ROOT = new URL('..', import.meta.url).pathname;
const SECRET = 'e2e-secret';
const API_PORT = 18790, IMAP_PORT = 19993;
const tmp = mkdtempSync(join(tmpdir(), 'mk-e2e-'));
const procs = [];
const cleanup = (code) => { procs.forEach((p) => p.kill()); rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

const fail = (msg) => { console.error('✖ ' + msg); cleanup(1); };
const ok = (msg) => console.log('✔ ' + msg);

// 1. Self-signed cert for the IMAP daemon.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'), '-subj', '/CN=localhost'], { stdio: 'ignore' });

// 2. Seed the backend store and boot both daemons.
const env = { ...process.env, DATA_DIR: join(tmp, 'data') };
execFileSync('node', [join(ROOT, 'api-local/cli.mjs'), 'add-user', 'e2e'], { env });
execFileSync('node', [join(ROOT, 'api-local/cli.mjs'), 'add-domain', 'local.example', 'e2e'], { env });
const appPassword = execFileSync('node', [join(ROOT, 'api-local/cli.mjs'), 'add-app-password', 'bob@local.example'], { env }).toString().trim();

procs.push(spawn('node', [join(ROOT, 'api-local/server.mjs')],
  { env: { ...env, HMAC_SECRET: SECRET, PORT: String(API_PORT) }, stdio: 'inherit' }));
procs.push(spawn('node', [join(ROOT, 'imap/server.js')], {
  env: {
    ...process.env,
    MAILKITE_API_URL: `http://127.0.0.1:${API_PORT}`,
    MAILKITE_HMAC_SECRET: SECRET,
    IMAP_PORT: String(IMAP_PORT),
    IMAP_HOST: '127.0.0.1',
    TLS_CERT: join(tmp, 'cert.pem'),
    TLS_KEY: join(tmp, 'key.pem'),
    IMAP_AUTH_LOG: join(tmp, 'auth-fail.log'),
  },
  stdio: 'inherit',
}));

const waitPort = async (port) => {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const s = connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => { s.destroy(); res(); }); s.on('error', rej); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  fail(`port ${port} never came up`);
};
const waitHttp = async (port) => {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  fail(`http ${port} never came up`);
};

await waitHttp(API_PORT);

// 3. Ingest a message exactly the way mailkite_ingest does.
const RAW = Buffer.from('From: alice@sender.example\r\nTo: bob@local.example\r\nSubject: e2e hello\r\nDate: Sat, 01 Aug 2026 00:00:00 +0000\r\n\r\nround trip\r\n');
const ts = Math.floor(Date.now() / 1000);
const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(RAW).digest('hex');
const ing = await fetch(`http://127.0.0.1:${API_PORT}/api/ingest`, {
  method: 'POST',
  headers: {
    'content-type': 'message/rfc822',
    'x-mailkite-signature': `t=${ts},v1=${sig}`,
    'x-mailkite-rcpt': 'bob@local.example',
    'x-mailkite-mailfrom': 'alice@sender.example',
  },
  body: RAW,
});
if (ing.status !== 200) fail(`ingest → ${ing.status}`);
ok('ingest accepted (HMAC verified)');

await waitPort(IMAP_PORT);

// 4. Drive a real IMAP session.
const socket = connect({ port: IMAP_PORT, host: '127.0.0.1', rejectUnauthorized: false });
let buf = '';
socket.on('data', (d) => { buf += d.toString(); });
const until = (re, what) => new Promise((res) => {
  const t = setTimeout(() => fail(`timeout waiting for ${what}\n--- buffer:\n${buf}`), 8000);
  const iv = setInterval(() => { const m = buf.match(re); if (m) { clearTimeout(t); clearInterval(iv); res(m); } }, 25);
});
const send = (line) => socket.write(line + '\r\n');

await until(/\* OK/, 'greeting');                       ok('greeting');
send(`a LOGIN bob@local.example ${appPassword}`);
await until(/^a OK/m, 'LOGIN');                          ok('LOGIN with app-password');
send('b SELECT INBOX');
const sel = await until(/\* (\d+) EXISTS[\s\S]*?^b OK/m, 'SELECT');
if (Number(sel[1]) < 1) fail('SELECT reports 0 messages');
ok(`SELECT INBOX (${sel[1]} message)`);
send('c FETCH 1 (UID FLAGS ENVELOPE)');
const f = await until(/^c OK/m, 'FETCH');
if (!buf.includes('e2e hello')) fail('ENVELOPE subject missing — raw round-trip broken');
ok('FETCH ENVELOPE returns ingested subject');
send('d UID STORE 1 +FLAGS (\\Seen)');
await until(/^d OK/m, 'STORE');                          ok('UID STORE \\Seen');
send('e LOGOUT');
await until(/^e OK/m, 'LOGOUT');                         ok('LOGOUT');
socket.destroy();

// 5. Verify the flag write landed in the backend.
const auth = await (await fetch(`http://127.0.0.1:${API_PORT}/api/imap/auth`, {
  method: 'POST', headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'bob@local.example', password: appPassword, ip: '' }),
})).json();
const list = await (await fetch(`http://127.0.0.1:${API_PORT}/api/imap/list`, {
  method: 'POST', headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: JSON.stringify({ userId: auth.userId, mailboxId: null, mailbox: 'INBOX' }),
})).json();
if (!list.messages[0].flags.includes('Seen')) fail('STORE flag did not persist to backend');
ok('flag persisted through edge → backend');

console.log('\nE2E PASS: mta-style ingest → api-local → imap-core edge → IMAP client');
cleanup(0);
