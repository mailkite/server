// Plugin-level tests for mailkite_ingest's delivery targeting + request shape.
// Verifies the no-backends.json path produces the exact request the pre-multi-backend
// plugin sent (same URL, same header set, same t=…,v1=… signature over the same bytes),
// and that multi-backend mode splits recipients and fails soft when any backend fails.
// Zero-dep: Haraka isn't installed; the plugin only needs node builtins + a stubbed
// `this` (config/log) and the OK/DENYSOFT globals Haraka normally injects.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

global.OK = 'OK';
global.DENY = 'DENY';
global.DENYSOFT = 'DENYSOFT';

const RAW = Buffer.from('From: a@b\r\n\r\nhi\r\n');

function makePlugin({ ini = {}, backendsJson = null } = {}) {
  const proto = require_('../plugins/mailkite_ingest.js');
  const plugin = Object.create(proto);
  plugin.config = {
    get(name) {
      if (name === 'mailkite.ini') return { main: ini };
      if (name === 'backends.json') return backendsJson;
      return null;
    },
  };
  plugin.loginfo = () => {};
  plugin.logwarn = () => {};
  plugin.logerror = () => {};
  plugin.load_mailkite_ini();
  return plugin;
}

function fakeTxn(rcpts, notes = {}) {
  return {
    rcpt_to: rcpts.map((a) => ({ address: () => a })),
    mail_from: { address: () => 'sender@origin.example' },
    notes,
    results: { get: () => null },
  };
}

const post = (plugin, txn) => new Promise((resolve) => {
  plugin.post_to_ingest({ notes: {} }, txn, RAW, (code, msg) => resolve({ code, msg }));
});

let fetches;
beforeEach(() => {
  fetches = [];
  for (const k of ['MAILKITE_INGEST_URL', 'MAILKITE_HMAC_SECRET', 'MAILKITE_INGEST_TIMEOUT_MS']) delete process.env[k];
  global.fetch = async (url, opts) => {
    fetches.push({ url, opts });
    return { ok: true, status: 200, text: async () => '' };
  };
});

test('single-backend (no backends.json): one POST, byte-identical request shape', async () => {
  const plugin = makePlugin({ ini: { ingest_url: 'https://api.example/api/ingest', hmac_secret: 'sekret' } });
  const { code } = await post(plugin, fakeTxn(['a@x.example', 'b@y.example']));
  assert.equal(code, 'OK');
  assert.equal(fetches.length, 1, 'exactly one POST — no per-rcpt splitting without config');

  const { url, opts } = fetches[0];
  assert.equal(url, 'https://api.example/api/ingest', 'uses ingest_url verbatim (incl. MAILKITE_INGEST_URL override semantics)');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.body, RAW);
  const h = opts.headers;
  assert.equal(h['content-type'], 'message/rfc822');
  assert.equal(h['x-mailkite-rcpt'], 'a@x.example,b@y.example');
  assert.equal(h['x-mailkite-mailfrom'], 'sender@origin.example');
  // Signature: t=<unix>,v1=HMAC(secret, "<t>." + raw) — recompute and compare exactly.
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h['x-mailkite-signature']);
  assert.ok(m, 'signature format');
  const expect = createHmac('sha256', 'sekret').update(`${m[1]}.`).update(RAW).digest('hex');
  assert.equal(m[2], expect);
  // Exactly the original header set — nothing added in single-backend mode.
  assert.deepEqual(Object.keys(h).sort(),
    ['content-type', 'x-mailkite-mailfrom', 'x-mailkite-rcpt', 'x-mailkite-signature']);
});

test('multi-backend: recipients split per owner, each POST signed with its own secret', async () => {
  process.env.S_CLOUD = 'cloud-secret';
  process.env.S_DEMO = 'demo-secret';
  const plugin = makePlugin({
    backendsJson: {
      backends: [
        { name: 'cloud', url: 'https://api.example', secretEnv: 'S_CLOUD' },
        { name: 'demo', url: 'https://demo.example', secretEnv: 'S_DEMO' },
      ],
    },
  });
  const txn = fakeTxn(['a@cloud-dom.example', 'b@demo-dom.example', 'c@cloud-dom.example'], {
    mailkite_backend_by_addr: {
      'a@cloud-dom.example': 'cloud',
      'b@demo-dom.example': 'demo',
      'c@cloud-dom.example': 'cloud',
    },
  });
  const { code } = await post(plugin, txn);
  assert.equal(code, 'OK');
  assert.equal(fetches.length, 2);

  const byUrl = new Map(fetches.map((f) => [f.url, f.opts]));
  const cloud = byUrl.get('https://api.example/api/ingest');
  const demo = byUrl.get('https://demo.example/api/ingest');
  assert.equal(cloud.headers['x-mailkite-rcpt'], 'a@cloud-dom.example,c@cloud-dom.example');
  assert.equal(demo.headers['x-mailkite-rcpt'], 'b@demo-dom.example');
  for (const [opts, secret] of [[cloud, 'cloud-secret'], [demo, 'demo-secret']]) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(opts.headers['x-mailkite-signature']);
    assert.equal(m[2], createHmac('sha256', secret).update(`${m[1]}.`).update(RAW).digest('hex'));
  }
  delete process.env.S_CLOUD;
  delete process.env.S_DEMO;
});

test('multi-backend: any backend failing → DENYSOFT (sender retries)', async () => {
  process.env.S_A = 'sa';
  process.env.S_B = 'sb';
  global.fetch = async (url, opts) => {
    fetches.push({ url, opts });
    if (url.startsWith('https://flaky')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => '' };
  };
  const plugin = makePlugin({
    backendsJson: {
      backends: [
        { name: 'solid', url: 'https://solid.example', secretEnv: 'S_A' },
        { name: 'flaky', url: 'https://flaky.example', secretEnv: 'S_B' },
      ],
    },
  });
  const txn = fakeTxn(['a@s.example', 'b@f.example'], {
    mailkite_backend_by_addr: { 'a@s.example': 'solid', 'b@f.example': 'flaky' },
  });
  const { code } = await post(plugin, txn);
  assert.equal(code, 'DENYSOFT');
  assert.equal(fetches.length, 2, 'both backends were attempted');
  delete process.env.S_A;
  delete process.env.S_B;
});

test('multi-backend: un-noted recipient falls back to highest-priority backend', async () => {
  process.env.S_A = 'sa';
  const plugin = makePlugin({
    backendsJson: { backends: [{ name: 'only', url: 'https://only.example', secretEnv: 'S_A' }] },
  });
  const { code } = await post(plugin, fakeTxn(['x@unknown.example'], {}));
  assert.equal(code, 'OK');
  assert.equal(fetches[0].url, 'https://only.example/api/ingest');
  delete process.env.S_A;
});
