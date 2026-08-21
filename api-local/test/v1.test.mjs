// Developer API (docs/v1.md) — the same JSON send/receive surface api.mailkite.dev
// exposes, so SDKs and code written against MailKite Cloud run unchanged against a
// self-hosted server. These tests prove the request/response shapes match, that auth
// is by API key, and that the underlying transport is still this server's own pipeline.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('..', import.meta.url).pathname;
const SECRET = 'v1-test-secret';
const PORT = 27000 + (process.pid % 900);

async function boot(port, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mk-v1-'));
  const proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const admin = (path, body) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await admin('/api/admin/domains', { domain: 'local.example' });
  const { key } = await (await admin('/api/admin/keys', {})).json();
  return { base, key, stop: () => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); } };
}

const v1 = (base, key, path, body, method = 'POST') => fetch(base + path, {
  method,
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
});
const signed = (raw, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => {
  const sig = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
  return `t=${ts},v1=${sig}`;
};
const ingest = (base, raw, rcpt) => fetch(base + '/api/ingest', {
  method: 'POST',
  headers: { 'x-mailkite-signature': signed(raw), 'x-mailkite-rcpt': rcpt },
  body: raw,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('v1 developer API', () => {
  let srv;
  before(async () => { srv = await boot(PORT); });
  after(() => srv.stop());

  test('every endpoint requires an API key', async () => {
    assert.equal((await fetch(srv.base + '/v1/send', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(srv.base + '/v1/me')).status, 401);
    assert.equal((await fetch(srv.base + '/api/messages')).status, 401);
    assert.equal((await fetch(srv.base + '/api/messages/msg_x')).status, 401);
  });

  test('POST /v1/send returns the cloud shape: { id, status }', async () => {
    const r = await v1(srv.base, srv.key, '/v1/send', {
      from: 'me@local.example', to: 'bob@local.example', subject: 'hi', text: 'hello',
    });
    assert.equal(r.status, 202);
    const b = await r.json();
    assert.match(b.id, /^msg_[A-Za-z0-9_-]+$/, 'a msg_… id is minted');
    assert.equal(b.status, 'sent');

    const msgs = await (await v1(srv.base, srv.key, '/api/messages', undefined, 'GET')).json();
    // Sending to a locally-hosted address files a Sent copy AND loop-delivers an INBOX
    // copy, so the account-wide view shows both — find the outbound row by its id.
    const sent = msgs.find((m) => m.id === b.id);
    assert.ok(sent, 'the returned id round-trips through the list');
    assert.equal(sent.direction, 'outbound');
    assert.equal(sent.from_addr, 'me@local.example');
    assert.equal(sent.to_addr, 'bob@local.example');
    assert.equal(sent.subject, 'hi');
    assert.match(sent.user_id, /^usr_local_/);
    assert.deepEqual(sent.from, { address: 'me@local.example' });
    assert.deepEqual(sent.to, [{ address: 'bob@local.example' }]);
    assert.equal(typeof sent.received_at, 'number', 'received_at is epoch ms');
  });

  test('a local recipient also lands in their INBOX (loop delivery)', async () => {
    const inbox = await (await fetch(`${srv.base}/api/admin/messages?mailbox=INBOX`, {
      headers: { authorization: 'Bearer ' + SECRET },
    })).json();
    assert.ok(inbox.messages.some((m) => m.to_addr === 'bob@local.example'));
  });

  test('replyTo and custom headers are applied to the message', async () => {
    await v1(srv.base, srv.key, '/v1/send', {
      from: 'me@local.example', to: 'bob@local.example', subject: 'thread',
      text: 'x', replyTo: 'support@local.example', headers: { 'X-Tag': 'receipts' },
    });
    const msgs = await (await v1(srv.base, srv.key, '/api/messages', undefined, 'GET')).json();
    const detail = (await (await v1(srv.base, srv.key, `/api/messages/${msgs[0].id}`, undefined, 'GET')).json()).message;
    const h = JSON.parse(detail.headers_json);
    assert.equal(h['reply-to'], 'support@local.example');
    assert.equal(h['x-tag'], 'receipts');
    assert.equal(detail.text_body, 'x');
  });

  test('html send exposes both bodies on the detail endpoint', async () => {
    await v1(srv.base, srv.key, '/v1/send', {
      from: 'me@local.example', to: 'bob@local.example', subject: 'rich', text: 'plain', html: '<p>rich</p>',
    });
    const msgs = await (await v1(srv.base, srv.key, '/api/messages', undefined, 'GET')).json();
    const detail = (await (await v1(srv.base, srv.key, `/api/messages/${msgs[0].id}`, undefined, 'GET')).json()).message;
    assert.equal(detail.text_body, 'plain');
    assert.equal(detail.html_body, '<p>rich</p>');
  });

  test('GET /api/messages mixes inbound and outbound, newest first', async () => {
    await ingest(srv.base, Buffer.from(
      'From: Ada <ada@sender.example>\r\nTo: hello@local.example\r\nSubject: inbound one\r\n\r\nbody\r\n'), 'hello@local.example');
    await sleep(5);
    const msgs = await (await v1(srv.base, srv.key, '/api/messages', undefined, 'GET')).json();
    assert.equal(msgs[0].direction, 'inbound', 'the newest message is the inbound one');
    assert.equal(msgs[0].subject, 'inbound one');
    assert.equal(msgs[0].from_addr, 'ada@sender.example');
    assert.ok(msgs.some((m) => m.direction === 'outbound'), 'outbound sends are in the same view');
  });

  test('search filters across sender, recipient, and subject', async () => {
    const hits = await (await v1(srv.base, srv.key, '/api/messages?search=inbound%20one', undefined, 'GET')).json();
    assert.ok(hits.every((m) => m.subject === 'inbound one'));
    assert.equal((await (await v1(srv.base, srv.key, '/api/messages?search=zzz-nothing', undefined, 'GET')).json()).length, 0);
  });

  test('POST /v1/send/batch returns per-recipient results', async () => {
    const r = await v1(srv.base, srv.key, '/v1/send/batch', {
      from: 'me@local.example', subject: 'batch', text: 'hello',
      recipients: [{ to: 'one@local.example' }, { to: 'two@local.example' }],
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sent, 2);
    assert.equal(body.failed, 0);
    assert.deepEqual(body.results.map((item) => item.status), ['sent', 'sent']);
    assert.ok(body.results.every((item) => /^msg_/.test(item.id)));
  });

  test('the From gate and validation mirror the cloud', async () => {
    assert.equal((await v1(srv.base, srv.key, '/v1/send', { from: 'me@elsewhere.example', to: 'bob@local.example', subject: 'x', text: 'y' })).status, 403);
    assert.equal((await v1(srv.base, srv.key, '/v1/send', { to: 'bob@local.example', subject: 'x', text: 'y' })).status, 400);
    assert.equal((await v1(srv.base, srv.key, '/v1/send', { from: 'me@local.example', to: 'bob@local.example', text: 'y' })).status, 400, 'subject required');
    assert.equal((await v1(srv.base, srv.key, '/v1/send', { from: 'me@local.example', to: 'bob@local.example', subject: 'x' })).status, 400, 'html or text required');
  });

  test('an external recipient is refused up front without a smarthost', async () => {
    const r = await v1(srv.base, srv.key, '/v1/send', { from: 'me@local.example', to: 'out@elsewhere.example', subject: 'x', text: 'y' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'no_smarthost');
  });

  test('hosted-only fields are refused explicitly, not silently ignored', async () => {
    for (const field of ['templateId', 'attachments', 'scheduledAt']) {
      const r = await v1(srv.base, srv.key, '/v1/send', {
        from: 'me@local.example', to: 'bob@local.example', subject: 'x', text: 'y', [field]: 'x',
      });
      assert.equal(r.status, 400, `${field} should be refused`);
      assert.equal((await r.json()).code, 'unsupported');
    }
  });

  test('header fields reject CRLF injection and non-string values', async () => {
    for (const body of [
      { replyTo: 'victim@example.com\r\nBcc: leak@example.com' },
      { inReplyTo: '<id>\nX-Injected: yes' },
      { headers: { 'X-Tag': 'ok\r\nBcc: leak@example.com' } },
      { headers: { 'X-Count': 1 } },
    ]) {
      const r = await v1(srv.base, srv.key, '/v1/send', {
        from: 'me@local.example', to: 'bob@local.example', subject: 'x', text: 'y', ...body,
      });
      assert.equal(r.status, 400);
    }
  });

  test('GET /api/messages/:id 404s for an unknown id', async () => {
    assert.equal((await v1(srv.base, srv.key, '/api/messages/msg_bogus', undefined, 'GET')).status, 404);
  });
});
