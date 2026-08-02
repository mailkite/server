// Smarthost outbound: config parsing, cloud mode (against a stub relay), SMTP mode
// (against an in-test SMTP server), and the unset default. Each mode boots its own
// api-local so SMARTHOST can differ per case.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSmarthost } from '../lib/smarthost.mjs';

const dir = new URL('..', import.meta.url).pathname;
const SECRET = 'smarthost-test-secret';

const RAW = (to) => Buffer.from(
  `From: sender@local.example\r\nTo: ${to}\r\nSubject: outbound test\r\n\r\nhello out there\r\n`);

/** Boot an api-local with a provisioned domain + key; returns {base, key, stop}. */
async function boot(port, extraEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mk-smart-'));
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

const relay = (base, key, to) => fetch(base + '/api/relay', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + key, 'content-type': 'message/rfc822', 'x-mailkite-rcpt': to },
  body: RAW(to),
});

describe('parseSmarthost', () => {
  test('unset → null; cloud without key → null', () => {
    assert.equal(parseSmarthost({}), null);
    assert.equal(parseSmarthost({ SMARTHOST: 'cloud' }), null, 'cloud needs MAILKITE_SEND_KEY');
  });
  test('cloud mode', () => {
    const c = parseSmarthost({ SMARTHOST: 'cloud', MAILKITE_SEND_KEY: 'mk_live_x' });
    assert.equal(c.mode, 'cloud');
    assert.equal(c.sendKey, 'mk_live_x');
    assert.match(c.url, /api\.mailkite\.dev/);
  });
  test('smtp url: defaults, credentials, implicit TLS', () => {
    const a = parseSmarthost({ SMARTHOST: 'smtp://user:pa%40ss@mail.example' });
    assert.deepEqual([a.mode, a.host, a.port, a.user, a.pass, a.implicitTls],
      ['smtp', 'mail.example', 587, 'user', 'pa@ss', false], 'percent-decoded password, default 587');
    const b = parseSmarthost({ SMARTHOST: 'smtps://u:p@mail.example' });
    assert.equal(b.port, 465);
    assert.equal(b.implicitTls, true);
  });
  test('garbage / unsupported scheme → null (outbound disabled, not crashed)', () => {
    assert.equal(parseSmarthost({ SMARTHOST: 'not a url' }), null);
    assert.equal(parseSmarthost({ SMARTHOST: 'http://mail.example' }), null);
  });
});

describe('relay with no smarthost (default)', () => {
  let srv;
  before(async () => { srv = await boot(18801); });
  after(() => srv.stop());

  test('external recipients are skipped and reported', async () => {
    const r = await relay(srv.base, srv.key, 'someone@elsewhere.example');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual([b.smarthost, b.externalSkipped, b.relayed, b.localDelivered], [null, 1, 0, 0]);
  });
});

describe('SMARTHOST=cloud', () => {
  let srv, stub, seen;
  before(async () => {
    seen = [];
    stub = createHttp((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          auth: req.headers.authorization,
          rcpt: req.headers['x-mailkite-rcpt'],
          ctype: req.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => stub.listen(18802, '127.0.0.1', r));
    srv = await boot(18803, {
      SMARTHOST: 'cloud',
      MAILKITE_SEND_KEY: 'mk_live_stub',
      MAILKITE_CLOUD_RELAY: 'http://127.0.0.1:18802/api/relay',
    });
  });
  after(() => { srv.stop(); stub.close(); });

  test('forwards raw message with Bearer key, external recipients only', async () => {
    // One local + one external recipient: only the external one may be forwarded.
    const r = await fetch(srv.base + '/api/relay', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + srv.key,
        'content-type': 'message/rfc822',
        'x-mailkite-rcpt': 'bob@local.example,out@elsewhere.example',
      },
      body: RAW('bob@local.example'),
    });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual([b.smarthost, b.relayed, b.localDelivered], ['cloud', 1, 1]);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer mk_live_stub');
    assert.equal(seen[0].rcpt, 'out@elsewhere.example', 'local recipient must not be re-sent to the cloud');
    assert.equal(seen[0].ctype, 'message/rfc822');
    assert.match(seen[0].body, /Subject: outbound test/);
  });

  test('cloud rejection surfaces as 502, not a silent drop', async () => {
    stub.close();
    const r = await relay(srv.base, srv.key, 'out2@elsewhere.example');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'smarthost_failed');
  });
});

describe('SMARTHOST=smtp://', () => {
  let srv, smtp, session;

  /**
   * Tiny SMTP server: records the conversation, accepts everything.
   * `authMechs` controls what EHLO advertises, so both AUTH paths can be exercised.
   */
  const startSmtp = (port, sess, authMechs = 'LOGIN PLAIN') => new Promise((resolve) => {
    const server = createTcp((sock) => {
      let buf = '', inData = false;
      sock.write('220 test.smarthost ESMTP\r\n');
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; sock.write('250 2.0.0 Ok: queued\r\n'); }
            else sess.data.push(line);
            continue;
          }
          const up = line.toUpperCase();
          sess.cmds.push(up.startsWith('AUTH PLAIN') ? 'AUTH PLAIN <redacted>' : line);
          if (up.startsWith('EHLO')) sock.write(`250-test.smarthost\r\n250-AUTH ${authMechs}\r\n250 SIZE 26214400\r\n`);
          else if (up.startsWith('AUTH PLAIN')) {
            // AUTH PLAIN <base64(\0user\0pass)>
            const [, , b64] = line.split(' ');
            const [, user, pass] = Buffer.from(b64 || '', 'base64').toString().split('\0');
            sess.user = user; sess.pass = pass; sess.mech = 'PLAIN';
            sock.write('235 2.7.0 Authenticated\r\n');
          } else if (up.startsWith('AUTH LOGIN')) { sess.stage = 'user'; sess.mech = 'LOGIN'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (sess.stage === 'user') { sess.user = Buffer.from(line, 'base64').toString(); sess.stage = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (sess.stage === 'pass') { sess.pass = Buffer.from(line, 'base64').toString(); sess.stage = null; sock.write('235 2.7.0 Authenticated\r\n'); }
          else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
          else if (up.startsWith('RCPT TO')) sock.write('250 2.1.5 Ok\r\n');
          else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (up === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
          else sock.write('250 2.0.0 Ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });

  const blank = () => ({ cmds: [], data: [], user: null, pass: null, stage: null, mech: null });

  before(async () => {
    session = blank();
    smtp = await startSmtp(18804, session);
    srv = await boot(18805, { SMARTHOST: 'smtp://relayuser:relaypass@127.0.0.1:18804' });
  });
  after(() => { srv.stop(); smtp.close(); });

  test('authenticates (PLAIN) and delivers the message to the smarthost', async () => {
    const r = await relay(srv.base, srv.key, 'out@elsewhere.example');
    assert.equal(r.status, 200, `relay failed: ${srv.log().split('\n').filter((l) => l.includes('smarthost')).join(' | ')}`);
    const b = await r.json();
    assert.deepEqual([b.smarthost, b.relayed], ['smtp', 1]);

    assert.equal(session.mech, 'PLAIN', 'prefers AUTH PLAIN when advertised');
    assert.equal(session.user, 'relayuser');
    assert.equal(session.pass, 'relaypass');
    assert.ok(session.cmds.some((c) => c.startsWith('EHLO ')), 'EHLO sent');
    assert.ok(session.cmds.includes('MAIL FROM:<sender@local.example>'), `MAIL FROM — got ${session.cmds}`);
    assert.ok(session.cmds.includes('RCPT TO:<out@elsewhere.example>'), 'RCPT TO');
    assert.ok(session.cmds.includes('DATA'), 'DATA');
    assert.ok(session.data.some((l) => l === 'Subject: outbound test'), 'message body reached the smarthost');
  });

  test('falls back to AUTH LOGIN when PLAIN is not advertised', async () => {
    const sess = blank();
    const srv2Smtp = await startSmtp(18806, sess, 'LOGIN');
    const srv2 = await boot(18807, { SMARTHOST: 'smtp://loginuser:loginpass@127.0.0.1:18806' });
    try {
      const r = await relay(srv2.base, srv2.key, 'out@elsewhere.example');
      assert.equal(r.status, 200, srv2.log().slice(-400));
      assert.equal(sess.mech, 'LOGIN');
      assert.equal(sess.user, 'loginuser');
      assert.equal(sess.pass, 'loginpass');
    } finally { srv2.stop(); srv2Smtp.close(); }
  });

  test('smarthost refusing the connection surfaces as 502', async () => {
    smtp.close();
    const r = await relay(srv.base, srv.key, 'out3@elsewhere.example');
    assert.equal(r.status, 502);
  });
});
