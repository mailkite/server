// Sign-in setup (docs/auth-setup.md): the state machine, and the rule that a method is
// only ever stored once it has been PROVEN to work. Everything runs against stubs — a
// fake send API and a fake OAuth provider — so the real proof paths are exercised
// end to end without touching a live provider.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'setup-test-secret';
const PORT = 24000 + (process.pid % 900);
const SEND_PORT = PORT + 1;
const OAUTH_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;
const ADMIN = 'founder@setup.example';

let proc, dataDir, sendStub, oauthStub;
let sendBehaviour = 'ok';           // 'ok' | 'reject'
const sentMail = [];
let oauthEmail = 'founder@setup.example';

/** Session cookie of the claiming admin — the one session the claim grants. */
let cookie = '';

const ui = (path, body, extra = {}) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'x-mailkite-ui': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
  redirect: 'manual',
});

const lastCode = () => {
  const m = String(sentMail[sentMail.length - 1]?.text || '').match(/\b(\d{6})\b/);
  return m?.[1];
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-setup-'));

  // Stub send API: can be told to reject, which is how "the key is wrong" is simulated.
  sendStub = createServer((req, res) => {
    // /v1/me is how the server asks "what may this key send from?"
    if (new URL(req.url, 'http://x').pathname.endsWith('/me')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ email: ADMIN, emailVerified: true, plan: 'free', sendingDomains: ['verified.example'] }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (sendBehaviour === 'reject') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid api key' }));
      }
      try { sentMail.push(JSON.parse(body)); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: 'msg_stub' }));
    });
  });
  await new Promise((r) => sendStub.listen(SEND_PORT, '127.0.0.1', r));

  // Stub OAuth provider: /authorize is never fetched by the server (the browser would
  // go there), only /token and /userinfo are.
  oauthStub = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (path === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'stub_token', token_type: 'bearer' }));
      }
      if (path === '/userinfo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ email: oauthEmail, email_verified: true }));
      }
      res.writeHead(404); return res.end('{}');
    });
  });
  await new Promise((r) => oauthStub.listen(OAUTH_PORT, '127.0.0.1', r));

  proc = spawn('node', [join(dir, 'server.mjs')], {
    // No ADMIN_EMAIL and no send key: a genuinely fresh, unclaimed install.
    env: {
      ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(PORT),
      ADMIN_EMAIL: '', MAILKITE_SEND_KEY: '', SMARTHOST: '',
      MAILKITE_SEND_URL: `http://127.0.0.1:${SEND_PORT}/v1/send`,
      OAUTH_TEST_BASE_URL: `http://127.0.0.1:${OAUTH_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => {
  proc?.kill();
  sendStub?.close();
  oauthStub?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('state 1 → 2: claiming the install leaves setup owed', async () => {
  const before = await (await ui('/api/auth/status')).json();
  assert.equal(before.needsSetup, true, 'fresh install is unclaimed');

  const claim = await ui('/api/auth/setup', { email: ADMIN });
  assert.equal(claim.status, 200);
  cookie = (claim.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mk_session=/, 'the claim grants one session');

  const after = await (await ui('/api/auth/status')).json();
  assert.equal(after.needsSetup, false);
  assert.equal(after.setupRequired, true, 'a sign-in method is still owed');
  assert.equal(after.method, null);

  const state = await (await ui('/api/auth/setup-state')).json();
  assert.equal(state.state, 'setup');
  assert.equal(state.adminEmail, ADMIN);
});

test('before setup, an admin can still sign in directly (and is told setup is owed)', async () => {
  const still = await ui('/api/admin/overview');
  assert.equal(still.status, 200, 'the claiming session still works');

  // No verification method exists yet, so email-as-credential is the only posture
  // available; locking this to one session would strand an admin who loses their
  // cookie mid-setup, with shell access as the only way back in.
  const r = await fetch(BASE + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN }),
  });
  const body = await r.json();
  assert.equal(body.setupRequired, true, 'the console still owes setup');
  assert.equal(body.signedIn, true, 'a known admin gets in');
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mk_session=/);
  const me = await fetch(BASE + '/api/admin/overview', { headers: { cookie, 'x-mailkite-ui': '1' } });
  assert.equal(me.status, 200, 'that session is usable');

  // A stranger still gets nothing.
  const s2 = await fetch(BASE + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@elsewhere.example' }),
  });
  const b2 = await s2.json();
  assert.ok(!b2.signedIn, 'non-admins are never signed in');
  assert.ok(!(s2.headers.get('set-cookie') || '').includes('mk_session='));
});

test('email setup: a key the send API rejects is never stored', async () => {
  sendBehaviour = 'reject';
  const r = await ui('/api/auth/setup/email', { mode: 'cloud', key: 'mk_live_wrong', from: 'no-reply@setup.example' });
  assert.equal(r.status, 400);
  const rejected = await r.json();
  // The failure is named specifically, and the admin is told what to do about it —
  // no upstream JSON, no stack, no bare status code.
  assert.equal(rejected.code, 'bad_key');
  assert.match(rejected.error, /rejected that API key/i);
  assert.ok(!/[{}]|Error:/.test(rejected.error), `message must stay human: ${rejected.error}`);

  const state = await (await ui('/api/auth/setup-state')).json();
  assert.equal(state.state, 'setup', 'still owed — a failed proof changes nothing');
  assert.equal(state.method, null);
  sendBehaviour = 'ok';
});

test('email setup: the wrong code does not complete setup', async () => {
  const sent = await ui('/api/auth/setup/email', { mode: 'cloud', key: 'mk_live_good', from: 'no-reply@setup.example' });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).sent, true);
  assert.ok(lastCode(), 'a 6-digit code was emailed');

  const bad = await ui('/api/auth/setup/email/verify', { code: '000000' === lastCode() ? '111111' : '000000' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'bad_code');
  assert.equal((await (await ui('/api/auth/setup-state')).json()).state, 'setup', 'still not complete');
});

test('email setup: the right code completes it, and sign-in becomes link-only', async () => {
  const ok = await ui('/api/auth/setup/email/verify', { code: lastCode() });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).method, 'email_cloud');

  const status = await (await ui('/api/auth/status')).json();
  assert.equal(status.setupRequired, false);
  assert.equal(status.method, 'email_cloud');
  assert.equal(status.mailChannel, true);

  // Secrets never come back out.
  const state = await (await ui('/api/auth/setup-state')).json();
  assert.equal(state.state, 'complete');
  assert.equal(state.settings.keySet, true);
  assert.ok(!JSON.stringify(state).includes('mk_live_good'), 'the key is never returned');

  // And direct sign-in is gone for good: a request mints a link, not a session.
  const before = sentMail.length;
  const r = await fetch(BASE + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN }),
  });
  assert.ok(!(await r.json()).signedIn, 'never a direct session once setup is complete');
  assert.ok(!(r.headers.get('set-cookie') || '').includes('mk_session='));
  for (let i = 0; i < 60 && sentMail.length === before; i++) await new Promise((x) => setTimeout(x, 50));
  assert.ok(sentMail.length > before, 'a link was emailed instead');
});

test('reset-auth re-opens setup and revokes every session', async () => {
  execFileSync('node', [join(dir, 'cli.mjs'), 'reset-auth'], { env: { ...process.env, DATA_DIR: dataDir } });

  const revoked = await ui('/api/admin/overview');
  assert.equal(revoked.status, 401, 'sessions are gone');

  const status = await (await fetch(BASE + '/api/auth/status')).json();
  assert.equal(status.setupRequired, true, 'setup is owed again');
  assert.equal(status.method, null);

  // Box access is the way back in — the network offers none.
  const out = execFileSync('node', [join(dir, 'cli.mjs'), 'signin-link', ADMIN],
    { env: { ...process.env, DATA_DIR: dataDir } }).toString();
  const token = /\/login#token=(\S+)/.exec(out)?.[1];
  assert.ok(token, `signin-link printed no token: ${out}`);
  const verified = await fetch(BASE + '/api/auth/verify', {
    method: 'POST', headers: { 'x-mailkite-ui': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(verified.status, 200);
  cookie = (verified.headers.get('set-cookie') || '').split(';')[0];
});

test('oauth setup: a mismatched state parameter is refused (CSRF)', async () => {
  const staged = await ui('/api/auth/setup/oauth', {
    provider: 'google', clientId: 'cid', clientSecret: 'csec', allowedEmails: [ADMIN],
  });
  assert.equal(staged.status, 200);
  const { authorizeUrl } = await staged.json();
  assert.ok(authorizeUrl.startsWith(`http://127.0.0.1:${OAUTH_PORT}/authorize`), authorizeUrl);

  const res = await fetch(`${BASE}/api/auth/oauth/callback?code=abc&state=not-the-right-state`, { redirect: 'manual' });
  assert.equal(res.status, 400, 'a forged state never proceeds');
  assert.equal((await (await ui('/api/auth/setup-state')).json()).state, 'setup', 'setup not completed');
});

test('oauth setup: an email outside the allow-list is refused', async () => {
  const staged = await ui('/api/auth/setup/oauth', {
    provider: 'google', clientId: 'cid', clientSecret: 'csec', allowedEmails: [ADMIN],
  });
  const state = new URL((await staged.json()).authorizeUrl).searchParams.get('state');

  oauthEmail = 'stranger@elsewhere.example';
  const res = await fetch(`${BASE}/api/auth/oauth/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.equal((await (await ui('/api/auth/setup-state')).json()).state, 'setup', 'setup not completed');
});

test('oauth setup: a completed round trip proves it, completes setup, and signs in', async () => {
  const staged = await ui('/api/auth/setup/oauth', {
    provider: 'google', clientId: 'cid', clientSecret: 'csec', allowedEmails: [ADMIN],
  });
  const state = new URL((await staged.json()).authorizeUrl).searchParams.get('state');

  oauthEmail = ADMIN;
  const res = await fetch(`${BASE}/api/auth/oauth/callback?code=abc&state=${state}`, { redirect: 'manual' });
  assert.equal(res.status, 302, 'lands back in the console');
  const newCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.match(newCookie, /^mk_session=/, 'the round trip signs the admin in');
  cookie = newCookie;

  const status = await (await fetch(BASE + '/api/auth/status')).json();
  assert.equal(status.method, 'oauth_google');
  assert.equal(status.setupRequired, false);
  assert.equal(status.mailChannel, false, 'OAuth installs have no email sign-in path');

  const state2 = await (await ui('/api/auth/setup-state')).json();
  assert.equal(state2.state, 'complete');
  assert.ok(!JSON.stringify(state2).includes('csec'), 'the client secret is never returned');
});

test('oauth install: request-link offers OAuth instead of a link, and never a session', async () => {
  const r = await fetch(BASE + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN }),
  });
  const body = await r.json();
  assert.equal(body.oauth, 'google');
  assert.ok(!body.signedIn);
  assert.ok(!(r.headers.get('set-cookie') || '').includes('mk_session='));
});

test('env pre-configuration skips the wizard entirely', async () => {
  const P = PORT + 3;
  const B = `http://127.0.0.1:${P}`;
  const d = mkdtempSync(join(tmpdir(), 'mk-envcfg-'));
  const p = spawn('node', [join(dir, 'server.mjs')], {
    env: {
      ...process.env, DATA_DIR: d, HMAC_SECRET: SECRET, PORT: String(P),
      ADMIN_EMAIL: ADMIN, MAILKITE_SEND_KEY: 'mk_live_from_env',
      MAILKITE_SEND_URL: `http://127.0.0.1:${SEND_PORT}/v1/send`,
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(B + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const status = await (await fetch(B + '/api/auth/status')).json();
    assert.equal(status.needsSetup, false, 'ADMIN_EMAIL claims it');
    assert.equal(status.setupRequired, false, 'MAILKITE_SEND_KEY satisfies setup');
    assert.equal(status.method, 'email_cloud');
  } finally {
    p.kill();
    rmSync(d, { recursive: true, force: true });
  }
});

// The console's "Advanced: connect with the admin secret" path authenticates with the
// HMAC bearer, not a cookie. Setup used to reject it with "not signed in", stranding an
// admin who connected that way with no path forward.
test('setup works for the HMAC bearer, not just a cookie session', async () => {
  const state = await fetch(BASE + '/api/auth/setup-state', {
    headers: { authorization: 'Bearer ' + SECRET },
  });
  assert.equal(state.status, 200, 'bearer can read setup state');

  sendBehaviour = 'reject';
  const r = await fetch(BASE + '/api/auth/setup/email', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'cloud', key: 'mk_live_wrong', from: 'no-reply@setup.example' }),
  });
  // Reaches the send attempt (and fails there) rather than 401ing on auth.
  assert.equal(r.status, 400);
  const rejected = await r.json();
  // The failure is named specifically, and the admin is told what to do about it —
  // no upstream JSON, no stack, no bare status code.
  assert.equal(rejected.code, 'bad_key');
  assert.match(rejected.error, /rejected that API key/i);
  assert.ok(!/[{}]|Error:/.test(rejected.error), `message must stay human: ${rejected.error}`);

  const anon = await fetch(BASE + '/api/auth/setup-state');
  assert.equal(anon.status, 401, 'no credential is still refused');
});

// An empty From must resolve to something the cloud will actually accept — the server
// cannot know that locally, so it asks the account and only prompts if there's no answer.
test('cloud setup with no From adopts a domain the account can send from', async () => {
  sendBehaviour = 'ok';
  const r = await ui('/api/auth/setup/email', { mode: 'cloud', key: 'mk_live_ok' }); // no from
  assert.equal(r.status, 200, await r.text());
  const lastSend = sentMail[sentMail.length - 1];
  assert.match(lastSend.from, /@verified\.example$/, `adopted the account's domain, got ${lastSend.from}`);
});
