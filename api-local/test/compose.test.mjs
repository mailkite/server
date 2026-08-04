// Compose (POST /api/admin/send) — the console's send path. It shares the outbound
// pipeline with /api/relay, so the interesting cases are the ones only compose has:
// building the message, and refusing before storing when there's nowhere to send.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('..', import.meta.url).pathname;
const SECRET = 'compose-test-secret';
const PORT = 25000 + (process.pid % 900);

/**
 * Boot an api-local hosting local.example, with whatever smarthost the case needs.
 * The domain is added through the admin API rather than the CLI on purpose: the API
 * files domains under the implicit `default` account, and the console's reads
 * (/api/admin/messages) look there — a CLI-provisioned domain belongs to its own user,
 * so mail sent from it would never show up in the console.
 */
async function boot(port, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mk-compose-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  const proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...env, HMAC_SECRET: SECRET, PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await fetch(base + '/api/admin/domains', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'local.example' }),
  });
  return { base, stop: () => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); } };
}

/** Returns {status, body} — the response body is read once, here. */
async function send(base, body) {
  const r = await fetch(base + '/api/admin/send', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const list = async (base, mailbox) =>
  (await (await fetch(`${base}/api/admin/messages?mailbox=${mailbox}`, { headers: { authorization: 'Bearer ' + SECRET } })).json()).messages;
const rawOf = (base, mailbox, uid) =>
  fetch(`${base}/api/admin/raw?mailbox=${mailbox}&uid=${uid}`, { headers: { authorization: 'Bearer ' + SECRET } }).then((r) => r.text());

describe('compose with no smarthost', () => {
  let srv;
  before(async () => { srv = await boot(PORT); });
  after(() => srv.stop());

  test('requires admin auth', async () => {
    const r = await fetch(srv.base + '/api/admin/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'a@local.example', to: 'b@local.example', subject: 'x', text: 'y' }),
    });
    assert.equal(r.status, 401);
  });

  test('a local recipient lands in Sent and in their INBOX', async () => {
    const { status, body: b } = await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example', subject: 'hello there', text: 'body text',
    });
    assert.equal(status, 200, JSON.stringify(b));
    assert.deepEqual([b.stored, b.localDelivered, b.external, b.smarthost], [true, 1, 0, null]);
    assert.match(b.messageId, /^<.+@.+>$/, 'a Message-ID is minted');

    const sent = await list(srv.base, 'Sent');
    assert.equal(sent[0].subject, 'hello there');
    assert.equal(sent[0].to_addr, 'bob@local.example');
    const inbox = await list(srv.base, 'INBOX');
    assert.equal(inbox[0].subject, 'hello there', 'loop-delivered to the local mailbox');
  });

  test('the stored message is well-formed RFC822', async () => {
    await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example', cc: 'carol@local.example',
      subject: 'headers check', text: 'line one\nline two',
    });
    const sent = await list(srv.base, 'Sent');
    const raw = await rawOf(srv.base, 'Sent', sent[0].uid);

    assert.match(raw, /^From: me@local\.example\r\n/m);
    assert.match(raw, /^To: bob@local\.example\r\n/m);
    assert.match(raw, /^Cc: carol@local\.example\r\n/m);
    assert.match(raw, /^Subject: headers check\r\n/m);
    assert.match(raw, /^Date: .+GMT\r\n/m);
    assert.match(raw, /^Message-ID: <.+@.+>\r\n/m);
    assert.match(raw, /^MIME-Version: 1\.0\r\n/m);
    assert.match(raw, /^Content-Type: text\/plain; charset=utf-8\r\n/m);
    assert.ok(!/[^\r]\n/.test(raw), 'every newline is CRLF — a bare LF corrupts DATA');
    assert.match(raw, /\r\n\r\nline one\r\nline two/, 'body follows the blank line');
  });

  test('a non-ASCII subject and body are encoded, not mangled', async () => {
    await send(srv.base, { from: 'me@local.example', to: 'bob@local.example', subject: 'héllo ✓', text: 'naïve — ✓' });
    const raw = await rawOf(srv.base, 'Sent', (await list(srv.base, 'Sent'))[0].uid);
    assert.match(raw, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/m, 'RFC2047-encoded subject');
    assert.match(raw, /^Content-Transfer-Encoding: base64\r\n/m);
    const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'naïve — ✓', 'body round-trips');
  });

  test('html produces multipart/alternative with both parts', async () => {
    await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example', subject: 'rich', text: 'plain', html: '<p>rich</p>',
    });
    const raw = await rawOf(srv.base, 'Sent', (await list(srv.base, 'Sent'))[0].uid);
    const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
    assert.ok(boundary, 'a boundary is declared');
    assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
    assert.ok(raw.includes(`--${boundary}--`), 'the multipart is closed');
  });

  test('bcc receives the mail but never appears in the headers', async () => {
    await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example', bcc: 'secret@local.example', subject: 'quiet', text: 'shh',
    });
    const raw = await rawOf(srv.base, 'Sent', (await list(srv.base, 'Sent'))[0].uid);
    assert.ok(!/secret@local\.example/.test(raw), 'a blind recipient must not be in the headers');
    const inbox = await list(srv.base, 'INBOX');
    assert.ok(inbox.some((m) => m.to_addr === 'secret@local.example'), 'but it was delivered to them');
  });

  test('a newline in the subject cannot inject a header', async () => {
    await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example',
      subject: 'normal\r\nBcc: sneak@elsewhere.example', text: 'x',
    });
    const raw = await rawOf(srv.base, 'Sent', (await list(srv.base, 'Sent'))[0].uid);
    assert.ok(!/^Bcc:/m.test(raw), 'the injected header must not become a real one');
    assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, 'it is encoded into the subject instead');
  });

  test('the From gate refuses a domain this server does not host', async () => {
    const { status, body } = await send(srv.base, { from: 'me@elsewhere.example', to: 'bob@local.example', subject: 'x', text: 'y' });
    assert.equal(status, 403);
    assert.equal(body.code, 'from_domain');
  });

  test('an external recipient is refused up front, and nothing is stored', async () => {
    const before = (await list(srv.base, 'Sent')).length;
    const { status, body: b } = await send(srv.base, { from: 'me@local.example', to: 'out@elsewhere.example', subject: 'x', text: 'y' });
    assert.equal(status, 400);
    assert.equal(b.code, 'no_smarthost');
    assert.match(b.error, /out@elsewhere\.example/, 'the message names who cannot be reached');
    assert.match(b.error, /SMARTHOST/, 'and what to configure');
    assert.equal((await list(srv.base, 'Sent')).length, before, 'no Sent copy for mail that never left');
  });

  test('recipients and From are validated', async () => {
    assert.equal((await send(srv.base, { from: 'me@local.example', to: '', subject: 'x', text: 'y' })).status, 400);
    assert.equal((await send(srv.base, { from: 'nonsense', to: 'bob@local.example', subject: 'x', text: 'y' })).status, 400);
    const bad = await send(srv.base, { from: 'me@local.example', to: 'not-an-address', subject: 'x', text: 'y' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'bad_rcpt');
  });
});

describe('compose with a smarthost', () => {
  let srv, stub, seen;
  before(async () => {
    seen = [];
    stub = createHttp((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ rcpt: req.headers['x-mailkite-rcpt'], body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => stub.listen(PORT + 1, '127.0.0.1', r));
    srv = await boot(PORT + 2, {
      SMARTHOST: 'cloud',
      MAILKITE_SEND_KEY: 'mk_live_stub',
      MAILKITE_CLOUD_RELAY: `http://127.0.0.1:${PORT + 1}/api/relay`,
    });
  });
  after(() => { srv.stop(); stub.close(); });

  test('external recipients go out through the smarthost', async () => {
    const { status, body: b } = await send(srv.base, {
      from: 'me@local.example', to: 'bob@local.example, out@elsewhere.example', subject: 'mixed', text: 'hi',
    });
    assert.equal(status, 200, JSON.stringify(b));
    assert.deepEqual([b.localDelivered, b.external, b.smarthost, b.relayed], [1, 1, 'cloud', 1]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rcpt, 'out@elsewhere.example', 'the local recipient is not re-sent externally');
    assert.match(seen[0].body, /^Subject: mixed\r\n/m);
  });

  test('a smarthost failure is reported in plain language, not a stack', async () => {
    stub.close();
    const { status, body: b } = await send(srv.base, { from: 'me@local.example', to: 'out2@elsewhere.example', subject: 'x', text: 'y' });
    assert.equal(status, 502);
    assert.equal(b.stored, true, 'the Sent copy exists — say so rather than implying nothing happened');
    assert.ok(b.error && !/[{}]|Error:/.test(b.error), `message must stay human: ${b.error}`);
  });
});
