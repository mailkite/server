// Console auth: magic-link request/verify, cookie sessions + CSRF header,
// first-boot /setup fallback, HMAC-bearer coexistence. Uses the log-delivery
// fallback (no MAILKITE_SEND_KEY), reading links from the server's stdout.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/db.mjs';

const SECRET = 'auth-test-secret';
const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'gabe@admin.example';
const dir = new URL('..', import.meta.url).pathname;

let proc, dataDir, stdout = '';

const ui = (path, body, extra = {}) => fetch(BASE + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'x-mailkite-ui': '1', 'content-type': 'application/json', ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const waitLog = async (re, timeoutMs = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = stdout.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`log line ${re} not found in:\n${stdout}`);
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-auth-'));
  proc = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(PORT), ADMIN_EMAIL: ADMIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/auth/me', { headers: { 'x-mailkite-ui': '1' } }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('request-link: unknown email still {ok:true} and issues nothing', async () => {
  const res = await ui('/api/auth/request-link', { email: 'stranger@nowhere.example' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!stdout.includes('magic-link:'), 'no link may be issued for a non-admin email');
});

let cookie = '';

test('magic link: request → log fallback → verify → session cookie', async () => {
  const res = await ui('/api/auth/request-link', { email: ADMIN.toUpperCase() }); // case-insensitive
  assert.deepEqual(await res.json(), { ok: true });
  const [, url] = await waitLog(/magic-link: (\S+)/);
  assert.ok(url.startsWith('http://127.0.0.1:' + PORT + '/login#token='), url);
  const token = url.split('#token=')[1];

  const verify = await ui('/api/auth/verify', { token });
  assert.equal(verify.status, 200);
  const body = await verify.json();
  assert.equal(body.email, ADMIN);
  const setCookie = verify.headers.get('set-cookie');
  assert.match(setCookie, /^mk_session=.+HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(!/Secure/.test(setCookie), 'no Secure flag on plain http');
  cookie = setCookie.split(';')[0];

  const reuse = await ui('/api/auth/verify', { token });
  assert.equal(reuse.status, 400, 'tokens are single-use');
});

test('cookie session: admin API works with cookie + CSRF header, fails without either', async () => {
  const ok = await ui('/api/admin/overview', undefined, { cookie });
  assert.equal(ok.status, 200);

  const noHeader = await fetch(BASE + '/api/admin/overview', { headers: { cookie } });
  assert.equal(noHeader.status, 401, 'cookie without x-mailkite-ui must fail (CSRF gate)');

  const noCookie = await ui('/api/admin/overview');
  assert.equal(noCookie.status, 401);

  const me = await ui('/api/auth/me', undefined, { cookie });
  assert.deepEqual(await (me).json(), { email: ADMIN });
});

test('HMAC bearer still works on admin routes (script path unchanged)', async () => {
  const res = await fetch(BASE + '/api/admin/overview', { headers: { authorization: 'Bearer ' + SECRET } });
  assert.equal(res.status, 200);
});

test('invite: admin adds a second console user who can then sign in', async () => {
  const invite = await ui('/api/admin/users', { email: 'ops@admin.example' }, { cookie });
  assert.equal(invite.status, 200);
  await ui('/api/auth/request-link', { email: 'ops@admin.example' });
  await waitLog(/magic-link: \S+/); // a second link got issued
});

test('logout clears the session', async () => {
  await ui('/api/auth/logout', {}, { cookie });
  const me = await ui('/api/auth/me', undefined, { cookie });
  assert.equal(me.status, 401);
});

test('login tokens: expiry honored at the store level', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'mk-tok-')));
  const raw = s.createLoginToken('x@y.example', -1); // already expired
  assert.equal(s.consumeLoginToken(raw), null);
  const good = s.createLoginToken('x@y.example');
  assert.equal(s.consumeLoginToken(good), 'x@y.example');
  assert.equal(s.consumeLoginToken(good), null, 'single-use');
});

test('first boot without ADMIN_EMAIL: /setup claims the server once', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'mk-setup-'));
  const PORT2 = 18792;
  let out = '';
  const p2 = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dir2, HMAC_SECRET: SECRET, PORT: String(PORT2), ADMIN_EMAIL: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p2.stdout.on('data', (d) => { out += d.toString(); });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${PORT2}/api/auth/me`, { headers: { 'x-mailkite-ui': '1' } }); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const m = out.match(/setup: .*\/setup#token=(\S+)/);
    assert.ok(m, `setup URL not logged:\n${out}`);
    const token = m[1];

    const bad = await fetch(`http://127.0.0.1:${PORT2}/api/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'mk_setup_wrong', email: 'a@b.example' }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`http://127.0.0.1:${PORT2}/api/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: 'Founder@First.Example' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).email, 'founder@first.example');
    const c2 = ok.headers.get('set-cookie').split(';')[0];

    const admin = await fetch(`http://127.0.0.1:${PORT2}/api/admin/overview`, {
      headers: { cookie: c2, 'x-mailkite-ui': '1' },
    });
    assert.equal(admin.status, 200, 'setup session unlocks the console');

    const again = await fetch(`http://127.0.0.1:${PORT2}/api/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: 'other@x.example' }),
    });
    assert.equal(again.status, 400, 'setup token is one-time');
  } finally {
    p2.kill();
    rmSync(dir2, { recursive: true, force: true });
  }
});
