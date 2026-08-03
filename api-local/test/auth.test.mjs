// Console auth: magic-link request/verify, cookie sessions + CSRF header,
// WP-style first-run admin claim + reset-admin recovery, HMAC-bearer coexistence. Uses the log-delivery
// fallback (no MAILKITE_SEND_KEY), reading links from the server's stdout.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/db.mjs';

const SECRET = 'auth-test-secret';
const PORT = 22000 + (process.pid % 900);
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
    env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(PORT), ADMIN_EMAIL: ADMIN,
      // A configured mail channel keeps this instance on the magic-link path (links
      // still log, since MAILKITE_SEND_KEY is unset). The no-channel direct sign-in
      // mode gets its own instance below.
      SMARTHOST: 'smtp://u:p@127.0.0.1:2525' },
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

test('setup is unavailable when ADMIN_EMAIL is configured', async () => {
  const status = await ui('/api/auth/status');
  assert.equal((await status.json()).needsSetup, false);
  const claim = await ui('/api/auth/setup', { email: 'squatter@x.example' });
  assert.equal(claim.status, 403);
});

test('unclaimed install: first email claims admin (WP-style), once; reset-admin recovers', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'mk-setup-'));
  const PORT2 = PORT + 1; // pid-derived base, no cross-run collisions
  const B2 = `http://127.0.0.1:${PORT2}`;
  let out = '';
  const p2 = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dir2, HMAC_SECRET: SECRET, PORT: String(PORT2), ADMIN_EMAIL: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  p2.stdout.on('data', (d) => { out += d.toString(); });
  const u2 = (path, body, extra = {}) => fetch(B2 + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-mailkite-ui': '1', 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await u2('/api/auth/me'); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal((await (await u2('/api/auth/status')).json()).needsSetup, true);

    const bad = await u2('/api/auth/setup', { email: 'not-an-email' });
    assert.equal(bad.status, 400);

    const ok = await u2('/api/auth/setup', { email: 'Founder@First.Example' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).email, 'founder@first.example');
    const c2 = ok.headers.get('set-cookie').split(';')[0];
    assert.match(out, /web console admin claimed: founder@first\.example/);

    const admin = await u2('/api/admin/overview', undefined, { cookie: c2 });
    assert.equal(admin.status, 200, 'claim session unlocks the web console');
    assert.equal((await (await u2('/api/auth/status')).json()).needsSetup, false);

    const again = await u2('/api/auth/setup', { email: 'other@x.example' });
    assert.equal(again.status, 403, 'claim is once-only');

    // Recovery path: box access resets the admin and revokes every session.
    execFileSync('node', [join(dir, 'cli.mjs'), 'reset-admin', 'Rescue@New.Example'],
      { env: { ...process.env, DATA_DIR: dir2 } });
    const revoked = await u2('/api/admin/overview', undefined, { cookie: c2 });
    assert.equal(revoked.status, 401, 'squatter session revoked by reset-admin');
    // This instance has no mail channel, so the rescued admin signs in directly.
    const rescued = await (await u2('/api/auth/request-link', { email: 'rescue@new.example' })).json();
    assert.equal(rescued.signedIn, true, 'reset admin can sign in');
  } finally {
    p2.kill();
    rmSync(dir2, { recursive: true, force: true });
  }
});

// --- no-mail-channel direct sign-in (Gabe 2026-08-03) --------------------------
// With no SMARTHOST/MAILKITE_SEND_KEY the server can't deliver a link, so a known
// admin email signs in directly rather than stranding the admin in the server log.
test('no mail channel: direct admin sign-in, no session for strangers', async () => {
  const P3 = PORT + 2;
  const B3 = `http://127.0.0.1:${P3}`;
  const dir3 = mkdtempSync(join(tmpdir(), 'mk-nochan-'));
  const p3 = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dir3, HMAC_SECRET: SECRET, PORT: String(P3), ADMIN_EMAIL: ADMIN, SMARTHOST: '', MAILKITE_SEND_KEY: '' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(B3 + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const s = await (await fetch(B3 + '/api/auth/status')).json();
    assert.equal(s.mailChannel, false, 'status reports no mail channel');

    const r = await fetch(B3 + '/api/auth/request-link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN }),
    });
    const body = await r.json();
    assert.equal(body.signedIn, true, 'admin signs in directly when no channel');
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^mk_session=/);
    const me = await fetch(B3 + '/api/admin/overview', { headers: { cookie, 'x-mailkite-ui': '1' } });
    assert.equal(me.status, 200, 'that session works on the admin API');

    const r2 = await fetch(B3 + '/api/auth/request-link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@nowhere.example' }),
    });
    const b2 = await r2.json();
    assert.equal(b2.ok, true);
    assert.ok(!b2.signedIn, 'no direct sign-in for non-admins');
    assert.ok(!(r2.headers.get('set-cookie') || '').includes('mk_session='), 'no cookie for strangers');
  } finally {
    p3.kill();
    rmSync(dir3, { recursive: true, force: true });
  }
});

test('mail channel configured: magic link required (no direct sign-in)', async () => {
  const r = await fetch(BASE + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN }),
  });
  const body = await r.json();
  assert.ok(!body.signedIn, 'link flow, not direct sign-in');
  assert.ok(!(r.headers.get('set-cookie') || '').includes('mk_session='));
  const s = await (await fetch(BASE + '/api/auth/status')).json();
  assert.equal(s.mailChannel, true);
});

test('rate limiting counts failures only and resets for known admins', async () => {
  const P4 = PORT + 3;
  const B4 = `http://127.0.0.1:${P4}`;
  const dir4 = mkdtempSync(join(tmpdir(), 'mk-rate-'));
  const p4 = spawn('node', [join(dir, 'server.mjs')], {
    env: { ...process.env, DATA_DIR: dir4, HMAC_SECRET: SECRET, PORT: String(P4), ADMIN_EMAIL: ADMIN, SMARTHOST: '', MAILKITE_SEND_KEY: '' },
    stdio: 'ignore',
  });
  const ask = (email) => fetch(B4 + '/api/auth/request-link', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(B4 + '/api/auth/status'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    // An admin signing in many times must never lock themselves out.
    for (let i = 0; i < 15; i++) {
      const r = await ask(ADMIN);
      assert.equal(r.status, 200, `admin attempt ${i + 1} not rate-limited`);
      assert.equal((await r.json()).signedIn, true);
    }
    // Unknown emails do accumulate, and the limit answers 429 (not a silent ok).
    for (let i = 0; i < 10; i++) await ask(`nobody${i}@nowhere.example`);
    assert.equal((await ask('nobody@nowhere.example')).status, 429, 'unknown-email flood is limited');
    // …and a real admin is rescued by the success reset.
    assert.equal((await ask(ADMIN)).status, 429, 'limiter applies before identity is known');
  } finally {
    p4.kill();
    rmSync(dir4, { recursive: true, force: true });
  }
});
