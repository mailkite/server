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

// ---- read_verdicts: SPF identity + type ---------------------------------------------------
// The MAIL FROM result is a WORD; connection.notes.spf_helo is a NUMERIC enum for a DIFFERENT
// identity (RFC 7208 §2.3). Falling back from one to the other put 24,386 rows of '1'/'2'/'3'
// into `messages.spf`, where the Worker's scorer matched none of them — SPF silently contributed
// nothing for that mail, and consumers got `auth.spf: "2"`.

const verdicts = (txnNotes = {}, connNotes = {}) => {
  const proto = require_('../plugins/mailkite_ingest.js');
  return proto.read_verdicts({ notes: connNotes, remote: {} }, { notes: txnNotes, results: { get: () => null } });
};

test('read_verdicts: the MAIL FROM result word is lowercased and used', () => {
  assert.equal(verdicts({ spf_mail_result: 'Pass' }).spf, 'pass');
  assert.equal(verdicts({ spf_mail_result: 'SoftFail' }).spf, 'softfail');
  assert.equal(verdicts({ spf_mail_result: '  Fail  ' }).spf, 'fail');
});

test('read_verdicts: the NUMERIC helo result is never stored as `spf`', () => {
  // The regression. Every one of these used to become spf='1'/'2'/'3'.
  for (const code of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(verdicts({}, { spf_helo: code }).spf, undefined, `helo ${code}`);
  }
});

test('read_verdicts: no MAIL FROM result means ABSENT, not a substituted one', () => {
  // Absent is honest — the Worker reads it as "not checked" rather than as a verdict we never got.
  assert.equal(verdicts({}, { spf_helo: 2 }).spf, undefined);
  assert.equal(verdicts({}).spf, undefined);
  assert.equal(verdicts({ spf_mail_result: '' }).spf, undefined);
  assert.equal(verdicts({ spf_mail_result: null }).spf, undefined);
});

test('read_verdicts: a non-string MAIL FROM result is refused too', () => {
  // Belt and braces: if the plugin ever hands back a code here, it must not become a fake word.
  assert.equal(verdicts({ spf_mail_result: 2 }).spf, undefined);
});

// ---- mailkite_spam.sender_domain ----------------------------------------------------------
// The whole correctness of the sender-domain blocklist check: score the wrong domain and the
// verdict is worse than useless, because it looks like a check that ran.

const senderDomain = (h) => require_('../plugins/mailkite_spam.js').sender_domain(h);

test('sender_domain: plain and display-name forms', () => {
  assert.equal(senderDomain('a@b.com'), 'b.com');
  assert.equal(senderDomain('Foo Bar <a@b.com>'), 'b.com');
  assert.equal(senderDomain('<a@b.com>'), 'b.com');
  assert.equal(senderDomain('Foo <a@B.CoM>'), 'b.com');
});

test('sender_domain: a display name containing @ must NOT win', () => {
  // The phishing shape this check exists for. Reading the first @ scores the SPOOFED name
  // (paypal.com — clean) and reports the message clean on a domain the sender doesn't own.
  assert.equal(senderDomain('"sales@paypal.com" <x@evil.ru>'), 'evil.ru');
  assert.equal(senderDomain('sales@paypal.com <x@evil.ru>'), 'evil.ru');
  assert.equal(senderDomain('"billing@apple.com" <fraud@bad.example>'), 'bad.example');
});

test('sender_domain: a quoted local part containing @ is not the domain', () => {
  assert.equal(senderDomain('"weird@local"@b.com'), 'b.com'); // RFC 5322 §3.4.1
});

test('sender_domain: trailing root-label dot and stray delimiters are stripped', () => {
  assert.equal(senderDomain('Foo <a@b.com.>'), 'b.com');
  assert.equal(senderDomain('a@b.com;'), 'b.com');
  assert.equal(senderDomain(' a@b.com \n'), 'b.com');
});

test('sender_domain: nothing to score returns empty, never a guess', () => {
  for (const bad of ['', null, undefined, 'no-at-here', 'Foo <>', '   ']) {
    assert.equal(senderDomain(bad), '', JSON.stringify(bad));
  }
});

test('sender_domain: a multi-address From takes the first sender', () => {
  assert.equal(senderDomain('A <a@b.com>, C <c@d.com>'), 'b.com');
});
