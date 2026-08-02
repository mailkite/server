// Inbound webhooks: config endpoints, dispatch-on-ingest with a verifiable signature,
// retry/backoff against a receiver that fails then recovers, and the status endpoint.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/db.mjs';
import { runDue, signPayload, BACKOFF_MS, MAX_ATTEMPTS } from '../lib/webhooks.mjs';

const dir = new URL('..', import.meta.url).pathname;
const SECRET = 'webhook-test-secret';
const PORT = 18810;
const HOOK_PORT = 18811;
const BASE = `http://127.0.0.1:${PORT}`;

let proc, dataDir, receiver, received, respondWith;

const admin = (path, body) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const ingest = (raw, rcpt) => {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.`).update(raw).digest('hex');
  return fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      'x-mailkite-signature': `t=${t},v1=${sig}`,
      'x-mailkite-rcpt': rcpt,
      'x-mailkite-mailfrom': 'sender@far.example',
    },
    body: raw,
  });
};

const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
};

before(async () => {
  received = [];
  respondWith = 200;
  receiver = createHttp((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(respondWith);
      res.end(respondWith === 200 ? 'ok' : 'nope');
    });
  });
  await new Promise((r) => receiver.listen(HOOK_PORT, '127.0.0.1', r));

  dataDir = mkdtempSync(join(tmpdir(), 'mk-hook-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-user', 'wh'], { env });
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-domain', 'hooked.example', 'wh'], { env });
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-domain', 'quiet.example', 'wh'], { env });
  proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...env, HMAC_SECRET: SECRET, PORT: String(PORT), WEBHOOK_SCAN_MS: '250' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => {
  proc?.kill();
  receiver?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('webhook configuration', () => {
  test('rejects unknown domains and non-http URLs', async () => {
    assert.equal((await admin('/api/admin/domains/webhook', { domain: 'nope.example', url: 'https://x.example/h' })).status, 400);
    assert.equal((await admin('/api/admin/domains/webhook', { domain: 'hooked.example', url: 'ftp://x.example/h' })).status, 400);
  });

  test('set → returns a signing secret and lists the hook', async () => {
    const r = await admin('/api/admin/domains/webhook', { domain: 'hooked.example', url: `http://127.0.0.1:${HOOK_PORT}/hook` });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.match(b.secret, /^whsec_/);
    assert.equal(b.url, `http://127.0.0.1:${HOOK_PORT}/hook`);

    const { webhooks } = await (await admin('/api/admin/domains/webhook')).json();
    assert.deepEqual(webhooks.map((w) => w.domain), ['hooked.example']);
  });

  test('capabilities report webhooks as available', async () => {
    const { capabilities } = await (await admin('/api/admin/overview')).json();
    assert.equal(capabilities.webhooks, true);
  });

  test('re-adding a domain keeps its webhook (INSERT OR IGNORE, not REPLACE)', async () => {
    await admin('/api/admin/domains', { domain: 'hooked.example' });
    const { url } = await (await admin('/api/admin/domains/webhook?domain=hooked.example')).json();
    assert.equal(url, `http://127.0.0.1:${HOOK_PORT}/hook`);
  });
});

describe('dispatch on ingest', () => {
  test('posts a signed payload the receiver can verify', async () => {
    received.length = 0;
    const raw = Buffer.from('From: alice@far.example\r\nTo: bob@hooked.example\r\nSubject: webhook me\r\n\r\nbody\r\n');
    const r = await ingest(raw, 'bob@hooked.example');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).webhooksQueued, 1);

    const hit = await waitFor(() => received[0]);
    const payload = JSON.parse(hit.body);
    assert.equal(payload.event, 'inbound');
    assert.equal(payload.domain, 'hooked.example');
    assert.equal(payload.rcpt, 'bob@hooked.example');
    assert.equal(payload.from, 'alice@far.example');
    assert.equal(payload.mailfrom, 'sender@far.example');
    assert.equal(payload.subject, 'webhook me');
    assert.ok(payload.uid >= 1);
    assert.match(payload.raw_url, /\/api\/admin\/raw\?mailbox=INBOX&uid=\d+/);

    // Verify the signature exactly as a receiver would.
    const { secret } = await (await admin('/api/admin/domains/webhook?domain=hooked.example')).json();
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.headers['x-mailkite-signature']);
    assert.ok(m, 'signature header present and well-formed');
    const expect = createHmac('sha256', secret).update(`${m[1]}.`).update(hit.body).digest('hex');
    assert.equal(m[2], expect, 'signature covers the exact body bytes');
    assert.equal(hit.headers['x-mailkite-event'], 'inbound');
  });

  test('domains without a webhook queue nothing', async () => {
    const raw = Buffer.from('From: a@far.example\r\nTo: b@quiet.example\r\nSubject: silent\r\n\r\nx\r\n');
    const r = await ingest(raw, 'b@quiet.example');
    assert.equal((await r.json()).webhooksQueued, 0);
  });

  test('status endpoint reports the delivery', async () => {
    const s = await (await admin('/api/admin/domains/webhook-status?domain=hooked.example')).json();
    assert.ok(s.counts.delivered >= 1);
    assert.equal(s.recent[0].domain, 'hooked.example');
    assert.equal(s.recent[0].status, 'delivered');
  });
});

describe('retry + backoff (store-level, no waiting on real timers)', () => {
  test('failed attempt is rescheduled, then delivered on retry', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mk-hook2-'));
    const store = new Store(tmp);
    try {
      const uid = store.addUser('r');
      store.addDomain('retry.example', uid);
      store.setWebhook('retry.example', 'http://127.0.0.1:1/dead');
      const id = store.queueDelivery('retry.example', 'http://127.0.0.1:1/dead', '{"event":"inbound"}');

      // Attempt 1: receiver 500s.
      let calls = 0;
      const failing = async () => { calls++; return new Response('no', { status: 500 }); };
      let r = await runDue(store, { fetchImpl: failing });
      assert.deepEqual([r.delivered, r.retried, r.failed], [0, 1, 0]);
      assert.equal(calls, 1);

      let row = store.deliveryStatus('retry.example').recent[0];
      assert.equal(row.status, 'pending', 'still pending — will retry');
      assert.equal(row.attempts, 1);
      assert.match(row.last_error, /HTTP 500/);
      assert.ok(row.next_attempt > Date.now() + BACKOFF_MS[0] - 5000, 'backed off ~1m');

      // Not due yet → untouched.
      r = await runDue(store, { fetchImpl: failing });
      assert.deepEqual([r.delivered, r.retried], [0, 0]);
      assert.equal(calls, 1, 'backoff respected');

      // Time-travel past the backoff; receiver now healthy.
      r = await runDue(store, { now: Date.now() + BACKOFF_MS[0] + 1000, fetchImpl: async () => new Response('ok', { status: 200 }) });
      assert.equal(r.delivered, 1);
      row = store.deliveryStatus('retry.example').recent[0];
      assert.equal(row.status, 'delivered');
      assert.equal(row.attempts, 2);
      void id;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('gives up after MAX_ATTEMPTS and marks the delivery failed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mk-hook3-'));
    const store = new Store(tmp);
    try {
      const uid = store.addUser('r');
      store.addDomain('dead.example', uid);
      store.setWebhook('dead.example', 'http://127.0.0.1:1/dead');
      store.queueDelivery('dead.example', 'http://127.0.0.1:1/dead', '{}');
      const failing = async () => { throw new Error('ECONNREFUSED'); };

      let now = Date.now();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await runDue(store, { now, fetchImpl: failing });
        now += 60 * 60_000; // jump past any backoff
      }
      const row = store.deliveryStatus('dead.example').recent[0];
      assert.equal(row.status, 'failed');
      assert.equal(row.attempts, MAX_ATTEMPTS);
      assert.match(row.last_error, /ECONNREFUSED/);

      // Exhausted deliveries are not picked up again.
      const r = await runDue(store, { now: now + 60 * 60_000, fetchImpl: failing });
      assert.deepEqual([r.delivered, r.retried, r.failed], [0, 0, 0]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('signPayload is stable for a given timestamp', () => {
    const a = signPayload('whsec_x', '{"a":1}', 1000);
    assert.equal(a, signPayload('whsec_x', '{"a":1}', 1000));
    assert.notEqual(a, signPayload('whsec_y', '{"a":1}', 1000));
  });
});
