// Amazon SES outbound: env parsing, the SigV4 signer against AWS's published test
// vector, the SendRawEmail body, and a real send against a stub SES endpoint (so the
// whole path — relay → sign → form body → error mapping — runs without an AWS account).

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSmarthost, transportTarget } from '../lib/smarthost.mjs';
import { parseSesConfig, relayViaSes, sesBody } from '../lib/ses.mjs';
import { signV4 } from '../lib/sigv4.mjs';

const dir = new URL('..', import.meta.url).pathname;
const SECRET = 'ses-test-secret';
const CREDS = { SES_ACCESS_KEY_ID: 'AKIDTEST', SES_SECRET_ACCESS_KEY: 'test-secret-key' };

const RAW = (to, extra = '') => Buffer.from(
  `From: sender@local.example\r\nTo: ${to}\r\nSubject: outbound test\r\n${extra}\r\nhello out there\r\n`);

/** Boot an api-local with a provisioned domain + key; returns {base, key, stop}. */
async function boot(port, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mk-ses-'));
  const env = { ...process.env, DATA_DIR: dataDir };
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-user', 'sh'], { env });
  execFileSync('node', [join(dir, 'cli.mjs'), 'add-domain', 'local.example', 'sh'], { env });
  const key = execFileSync('node', [join(dir, 'cli.mjs'), 'add-key', 'sh'], { env }).toString().trim();
  const proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...env, HMAC_SECRET: SECRET, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    base, key, log: () => out,
    stop: () => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

describe('SigV4', () => {
  test("matches AWS's published get-vanilla vector", () => {
    // The canonical AWS signing test suite: known key, date, host, empty payload.
    // If this drifts, every SES request fails with SignatureDoesNotMatch.
    const { headers, signature, signedHeaders } = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payload: '',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
    assert.equal(signedHeaders, 'host;x-amz-date');
    assert.equal(signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  test('SES scope and signed headers are exactly what the service expects', () => {
    // Cross-checked against an independent SigV4 implementation: same inputs, same
    // signature. Locks the date format, scope and signed-header list, not just the HMACs.
    const { signature, headers } = signV4({
      url: new URL('https://email.eu-west-1.amazonaws.com/'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      payload: 'Action=SendRawEmail&Version=2010-12-01',
      region: 'eu-west-1',
      service: 'ses',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret',
      now: new Date('2026-11-22T10:20:30.456Z'),
    });
    assert.equal(signature, 'af9d252be62dfbc836902f2efa9799021580b362d13ab1c177672a9b8094e067');
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDTEST/20261122/eu-west-1/ses/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, '
      + 'Signature=af9d252be62dfbc836902f2efa9799021580b362d13ab1c177672a9b8094e067',
    );
  });

  test('signs every header it sends, including a session token', () => {
    const call = () => signV4({
      url: new URL('https://email.eu-west-1.amazonaws.com/'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      payload: 'Action=SendRawEmail',
      region: 'eu-west-1',
      service: 'ses',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret',
      sessionToken: 'session-token',
      now: new Date('2026-11-22T10:20:30.456Z'),
    });
    const { headers, signedHeaders, signature } = call();
    assert.equal(
      signedHeaders,
      'content-type;host;x-amz-date;x-amz-security-token',
      'a header the caller sends but we do not sign can be tampered with',
    );
    assert.equal(headers['x-amz-security-token'], 'session-token');
    assert.equal(headers['x-amz-date'], '20261122T102030Z');
    assert.match(headers.authorization, /Credential=AKIDTEST\/20261122\/eu-west-1\/ses\/aws4_request/);
    assert.equal(call().signature, signature, 'same input, same signature');
  });

  test('refuses an incomplete credential set instead of signing garbage', () => {
    assert.throws(() => signV4({
      url: new URL('https://email.us-east-1.amazonaws.com/'), region: 'us-east-1',
      service: 'ses', accessKeyId: 'AKIDTEST',
    }), /secretAccessKey is required/);
  });
});

describe('parseSmarthost → ses', () => {
  test('unusable without a key pair', () => {
    assert.equal(parseSmarthost({ SMARTHOST: 'ses' }), null);
    assert.equal(parseSesConfig({ SES_ACCESS_KEY_ID: 'AKIDTEST' }), null, 'secret missing');
  });

  test('defaults to us-east-1 and the regional SES endpoint', () => {
    const cfg = parseSmarthost({ SMARTHOST: 'ses', ...CREDS });
    assert.deepEqual(
      [cfg.mode, cfg.region, cfg.url, cfg.sessionToken],
      ['ses', 'us-east-1', 'https://email.us-east-1.amazonaws.com/', ''],
    );
    assert.equal(cfg.host, 'email.us-east-1.amazonaws.com');
  });

  test('standard AWS_* names work; SES_* wins when both are set', () => {
    const aws = parseSesConfig({ SMARTHOST: 'ses', AWS_ACCESS_KEY_ID: 'AWSKEY', AWS_SECRET_ACCESS_KEY: 'awsecret', AWS_REGION: 'ap-southeast-2' });
    assert.deepEqual([aws.accessKeyId, aws.region], ['AWSKEY', 'ap-southeast-2']);
    const both = parseSesConfig({ SES_ACCESS_KEY_ID: 'SESKEY', SES_SECRET_ACCESS_KEY: 's', AWS_ACCESS_KEY_ID: 'AWSKEY', AWS_SECRET_ACCESS_KEY: 'a' });
    assert.equal(both.accessKeyId, 'SESKEY');
  });

  test('ses://<region> overrides the env region', () => {
    const cfg = parseSmarthost({ SMARTHOST: 'ses://eu-west-1', ...CREDS, SES_REGION: 'us-west-2' });
    assert.deepEqual([cfg.region, cfg.host], ['eu-west-1', 'email.eu-west-1.amazonaws.com']);
  });

  test('a typo in the region disables outbound rather than failing per message', () => {
    assert.equal(parseSesConfig({ ...CREDS, SES_REGION: 'eu west 1' }), null);
    assert.equal(parseSesConfig({ ...CREDS, MAILKITE_SES_ENDPOINT: 'not a url' }), null);
  });

  test('plaintext endpoints are refused unless they are loopback', () => {
    assert.equal(parseSesConfig({ ...CREDS, MAILKITE_SES_ENDPOINT: 'http://10.0.0.5/' }), null,
      'http would put the signature (and thus the secret) on the wire');
    assert.ok(parseSesConfig({ ...CREDS, MAILKITE_SES_ENDPOINT: 'http://127.0.0.1:18821/' }));
    assert.ok(parseSesConfig({ ...CREDS, MAILKITE_SES_ENDPOINT: 'https://email.eu-west-1.amazonaws.com/' }));
  });

  test('session tokens come from the environment, never the spec string', () => {
    const cfg = parseSesConfig({ ...CREDS, AWS_SESSION_TOKEN: 'tok' });
    assert.equal(cfg.sessionToken, 'tok');
  });

  test('transportTarget names the endpoint in failure messages', () => {
    const ses = parseSesConfig({ ...CREDS });
    assert.deepEqual(transportTarget(ses), { host: 'email.us-east-1.amazonaws.com' });
    assert.deepEqual(transportTarget({ mode: 'smtp', host: 'mail.example', port: 587 }), { host: 'mail.example', port: 587 });
    assert.deepEqual(transportTarget({ mode: 'cloud', url: 'https://api.mailkite.dev' }), {});
    assert.deepEqual(transportTarget(null), {});
  });
});

describe('sesBody', () => {
  test('carries the raw message byte-for-byte and the envelope as Destinations', () => {
    const raw = RAW('out@elsewhere.example', 'Content-Type: text/plain; charset=utf-8');
    const body = sesBody(raw, ['out@elsewhere.example', 'hidden@elsewhere.example'], 'sender@local.example');
    const form = new URLSearchParams(body);
    assert.equal(form.get('Action'), 'SendRawEmail');
    assert.equal(form.get('Version'), '2010-12-01');
    assert.equal(form.get('Source'), 'sender@local.example');
    assert.deepEqual(
      [form.get('Destinations.member.1'), form.get('Destinations.member.2')],
      ['out@elsewhere.example', 'hidden@elsewhere.example'],
      'Destinations is the envelope, so a Bcc stays blind',
    );
    assert.deepEqual(Buffer.from(form.get('RawMessage.Data'), 'base64'), raw);
    assert.equal(body.includes('hidden%40elsewhere.example'), true);
  });
});

describe('SMARTHOST=ses against a stub SES endpoint', () => {
  const STUB = 18821;
  const API = 18820;
  let srv, stub, seen = [];
  let reply = { status: 200, body: '<SendRawEmailResponse><SendRawEmailResult><MessageId>ses-msg-1</MessageId></SendRawEmailResult></SendRawEmailResponse>' };

  before(async () => {
    stub = createHttp((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ method: req.method, url: req.url, headers: req.headers, form: new URLSearchParams(body) });
        res.writeHead(reply.status, { 'content-type': 'text/xml' });
        res.end(reply.body);
      });
    });
    await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));
    srv = await boot(API, {
      SMARTHOST: 'ses',
      SES_REGION: 'eu-west-1',
      SES_ACCESS_KEY_ID: 'AKIDTEST',
      SES_SECRET_ACCESS_KEY: 'test-secret-key',
      MAILKITE_SES_ENDPOINT: `http://127.0.0.1:${STUB}/`,
    });
  });
  after(() => { srv.stop(); stub.close(); });

  test('sends raw MIME through SendRawEmail, external recipients only', async () => {
    seen = [];
    const raw = RAW('bob@local.example', 'Bcc: hidden@elsewhere.example');
    const r = await fetch(srv.base + '/api/relay', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + srv.key,
        'content-type': 'message/rfc822',
        'x-mailkite-rcpt': 'bob@local.example,out@elsewhere.example,hidden@elsewhere.example',
      },
      body: raw,
    });
    assert.equal(r.status, 200, srv.log());
    const b = await r.json();
    assert.deepEqual([b.smarthost, b.relayed, b.localDelivered], ['ses', 2, 1]);

    assert.equal(seen.length, 1);
    const [req] = seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/');
    assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.match(req.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
    assert.equal(req.form.get('Action'), 'SendRawEmail');
    assert.equal(req.form.get('Source'), 'sender@local.example');
    assert.deepEqual(
      [req.form.get('Destinations.member.1'), req.form.get('Destinations.member.2')],
      ['out@elsewhere.example', 'hidden@elsewhere.example'],
      'the locally-hosted recipient must not be re-sent to SES',
    );
    assert.deepEqual(Buffer.from(req.form.get('RawMessage.Data'), 'base64'), raw, 'the MIME is untouched');
  });

  test('an SES rejection is a 502 with an actionable code, not a silent drop', async () => {
    reply = {
      status: 400,
      body: '<ErrorResponse><Error><Type>Sender</Type><Code>MessageRejected</Code>'
        + '<Message>Email address is not verified. The following identities failed the check in region EU-WEST-1: local.example</Message></Error></ErrorResponse>',
    };
    seen = [];
    const r = await fetch(srv.base + '/api/relay', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + srv.key,
        'content-type': 'message/rfc822',
        'x-mailkite-rcpt': 'out@elsewhere.example',
      },
      body: RAW('out@elsewhere.example'),
    });
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.equal(b.code, 'smarthost_failed', '/api/relay keeps its contract shape');
    assert.match(b.error, /MessageRejected/);
  });

  test('the JSON send API reports the SES code and the fix', async () => {
    const r = await fetch(srv.base + '/v1/send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + srv.key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sender@local.example', to: 'out@elsewhere.example', subject: 'hi', text: 'hello' }),
    });
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.equal(b.code, 'ses_rejected');
    assert.match(b.error, /verified identity/);
  });

  test('throttling maps to rate_limited', async () => {
    reply = {
      status: 400,
      body: '<ErrorResponse><Error><Code>Throttling</Code><Message>Maximum sending rate exceeded.</Message></Error></ErrorResponse>',
    };
    const r = await fetch(srv.base + '/v1/send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + srv.key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sender@local.example', to: 'out@elsewhere.example', subject: 'hi', text: 'hello' }),
    });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'rate_limited');
  });

  test('a 5xx from SES is upstream, not a permanent rejection', async () => {
    reply = { status: 503, body: '<ErrorResponse><Error><Code>ServiceUnavailable</Code></Error></ErrorResponse>' };
    const r = await fetch(srv.base + '/v1/send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + srv.key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sender@local.example', to: 'out@elsewhere.example', subject: 'hi', text: 'hello' }),
    });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'provider_down');
    reply = { status: 200, body: '<SendRawEmailResponse><SendRawEmailResult><MessageId>ses-msg-1</MessageId></SendRawEmailResult></SendRawEmailResponse>' };
  });

  test('a bad key pair says which env vars to check', async () => {
    reply = {
      status: 403,
      body: '<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code>'
        + '<Message>The request signature we calculated does not match the signature you provided.</Message></Error></ErrorResponse>',
    };
    const r = await fetch(srv.base + '/v1/send', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + srv.key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sender@local.example', to: 'out@elsewhere.example', subject: 'hi', text: 'hello' }),
    });
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.equal(b.code, 'ses_credentials');
    assert.match(b.error, /secret key does not match/);
    reply = { status: 200, body: '<SendRawEmailResponse><SendRawEmailResult><MessageId>ses-msg-1</MessageId></SendRawEmailResult></SendRawEmailResponse>' };
  });
});

describe('relayViaSes failure surfaces', () => {
  const cfg = () => parseSesConfig({
    ...CREDS,
    SES_REGION: 'us-east-1',
    MAILKITE_SES_ENDPOINT: 'http://127.0.0.1:18829/',
  });

  test('an unreachable endpoint keeps its errno for transportError', async () => {
    await assert.rejects(
      () => relayViaSes(cfg(), RAW('a@b.example'), ['a@b.example'], 'sender@local.example', { timeoutMs: 2000 }),
      (e) => e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET',
    );
  });

  test('a 200 without the usual XML still counts as sent', async () => {
    const reply = '<html>ok</html>';
    const stub = createHttp((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200); res.end(reply); });
    });
    await new Promise((r) => stub.listen(18822, '127.0.0.1', r));
    try {
      const local = parseSesConfig({ ...CREDS, MAILKITE_SES_ENDPOINT: 'http://127.0.0.1:18822/' });
      assert.deepEqual(await relayViaSes(local, RAW('a@b.example'), ['a@b.example'], 'sender@local.example'), { messageId: null });
    } finally {
      stub.close();
    }
  });
});
