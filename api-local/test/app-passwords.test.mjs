// App passwords (docs/app-passwords.md): admin CRUD, IMAP auth resolution, access
// enforcement, the address-scoped mailbox REST API, and legacy-secret compatibility.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'app-password-test-secret';
const PORT = 23000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = new URL('..', import.meta.url).pathname;
const DOMAIN = 'keys.example';
let proc, dataDir;

const admin = (path, body, method) => fetch(BASE + path, {
  method: method || (body === undefined ? 'GET' : 'POST'),
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const edge = (path, body) => fetch(BASE + path, {
  method: 'POST',
  headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const mailbox = (path, key, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...init.headers },
});
const newPw = (body) => admin('/api/admin/app-passwords', body).then((r) => r.json());
const imapAuth = (username, password) => edge('/api/imap/auth', { username, password, ip: '' }).then((r) => r.json());

/** Deliver a message to `rcpt` exactly the way the MX edge does. */
async function ingest(rcpt, subject) {
  const raw = Buffer.from(`From: sender@out.example\r\nTo: ${rcpt}\r\nSubject: ${subject}\r\n\r\nbody\r\n`);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(raw).digest('hex');
  const r = await fetch(BASE + '/api/ingest', {
    method: 'POST',
    headers: { 'x-mailkite-signature': `t=${ts},v1=${sig}`, 'x-mailkite-rcpt': rcpt, 'x-mailkite-mailfrom': 'sender@out.example' },
    body: raw,
  });
  assert.equal(r.status, 200, `ingest ${rcpt}`);
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mk-apppw-'));
  proc = spawn('node', [join(dir, 'server.mjs')],
    { env: { ...process.env, DATA_DIR: dataDir, HMAC_SECRET: SECRET, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/admin/overview'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await admin('/api/admin/domains', { domain: DOMAIN });
  await admin('/api/admin/domains', { domain: 'other.example' });
});
after(() => { proc?.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('admin CRUD: create, list, delete — and validation', async () => {
  assert.equal((await admin('/api/admin/app-passwords')).status !== 401, true);
  assert.equal((await fetch(BASE + '/api/admin/app-passwords')).status, 401, 'requires auth');

  const bad = await admin('/api/admin/app-passwords', { domain: 'nothosted.example' });
  assert.equal(bad.status, 400, 'domain must be hosted');
  const badProto = await admin('/api/admin/app-passwords', { domain: DOMAIN, protocols: ['smtp'] });
  assert.equal(badProto.status, 400, 'at least one known protocol');
  const badAddr = await admin('/api/admin/app-passwords', { domain: DOMAIN, address: 'has space' });
  assert.equal(badAddr.status, 400, 'invalid pattern');
  const otherDomain = await admin('/api/admin/app-passwords', { domain: DOMAIN, address: 'a@other.example' });
  assert.equal(otherDomain.status, 400, 'full-address form pinned to its own domain');

  const created = await newPw({ domain: DOMAIN, address: '*', protocols: ['imap', 'api'], label: 'everything' });
  assert.ok(created.secret.startsWith('mk_pw_'), 'new universal prefix');
  assert.equal(created.address, '*');

  const { appPasswords } = await (await admin('/api/admin/app-passwords')).json();
  const row = appPasswords.find((k) => k.id === created.id);
  assert.ok(row, 'listed');
  assert.deepEqual(row.protocols, ['imap', 'api']);
  assert.equal(row.label, 'everything');
  assert.ok(!('secret' in row) && !('hash' in row) && !('lookup' in row), 'listing never exposes the secret');

  assert.equal((await admin(`/api/admin/app-passwords/${created.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await admin(`/api/admin/app-passwords/${created.id}`, undefined, 'DELETE')).status, 404);
  const after = await (await admin('/api/admin/app-passwords')).json();
  assert.ok(!after.appPasswords.some((k) => k.id === created.id), 'gone');
});

test('IMAP auth: a domain-wide key serves every address on it', async () => {
  const { secret } = await newPw({ domain: DOMAIN, address: '*', protocols: ['imap'] });
  for (const addr of [`hello@${DOMAIN}`, `anyone-else@${DOMAIN}`, `First.Last@${DOMAIN}`]) {
    const r = await imapAuth(addr, secret);
    assert.equal(r.ok, true, addr);
    assert.equal(r.domain, DOMAIN);
    assert.equal(r.mailboxId, null);
  }
  const off = await imapAuth('hello@other.example', secret);
  assert.equal(off.ok, false, 'never crosses domains');
  assert.equal((await imapAuth(`hello@${DOMAIN}`, 'mk_pw_wrong')).ok, false, 'wrong secret');
});

test('IMAP auth: an exact key covers only its own address', async () => {
  const { secret } = await newPw({ domain: DOMAIN, address: 'support-*', protocols: ['imap'] });
  assert.equal((await imapAuth(`support-billing@${DOMAIN}`, secret)).ok, true);
  assert.equal((await imapAuth(`support-@${DOMAIN}`, secret)).ok, true);
  assert.equal((await imapAuth(`sales@${DOMAIN}`, secret)).ok, false, 'outside the pattern');
});

test('access kinds are enforced in both directions', async () => {
  const apiOnly = await newPw({ domain: DOMAIN, address: '*', protocols: ['api'] });
  const imapOnly = await newPw({ domain: DOMAIN, address: '*', protocols: ['imap'] });

  assert.equal((await imapAuth(`hello@${DOMAIN}`, apiOnly.secret)).ok, false, 'api key refused over IMAP');
  assert.equal((await imapAuth(`hello@${DOMAIN}`, imapOnly.secret)).ok, true);

  const q = `?address=hello@${DOMAIN}`;
  assert.equal((await mailbox(`/api/mailbox/messages${q}`, imapOnly.secret)).status, 403, 'imap key refused over API');
  assert.equal((await mailbox(`/api/mailbox/messages${q}`, apiOnly.secret)).status, 200);
});

test('mailbox REST: list, raw and flags, scoped to the address', async () => {
  await ingest(`agent@${DOMAIN}`, 'for the agent');
  await ingest(`someone-else@${DOMAIN}`, 'not for the agent');
  const { secret } = await newPw({ domain: DOMAIN, address: 'agent', protocols: ['api'] });

  const list = await (await mailbox(`/api/mailbox/messages?address=agent@${DOMAIN}`, secret)).json();
  assert.equal(list.mailbox, 'INBOX');
  assert.equal(list.messages.length, 1, 'only this address, not the whole account');
  assert.equal(list.messages[0].subject, 'for the agent');
  const uid = list.messages[0].uid;

  const rawRes = await mailbox(`/api/mailbox/messages/${uid}/raw?address=agent@${DOMAIN}`, secret);
  assert.equal(rawRes.status, 200);
  assert.equal(rawRes.headers.get('content-type'), 'message/rfc822');
  assert.match(await rawRes.text(), /Subject: for the agent/);

  const flagged = await mailbox(`/api/mailbox/messages/${uid}/flags`, secret, {
    method: 'POST', body: JSON.stringify({ address: `agent@${DOMAIN}`, flags: 'Seen Flagged' }),
  });
  assert.equal(flagged.status, 200);
  const after = await (await mailbox(`/api/mailbox/messages?address=agent@${DOMAIN}`, secret)).json();
  assert.equal(after.messages[0].flags, 'Seen Flagged', 'flag persisted');

  // A message belonging to another address is invisible even by uid.
  const others = await (await admin('/api/admin/messages?mailbox=INBOX')).json();
  const otherUid = others.messages.find((m) => m.subject === 'not for the agent').uid;
  assert.equal((await mailbox(`/api/mailbox/messages/${otherUid}/raw?address=agent@${DOMAIN}`, secret)).status, 404);
});

test('mailbox REST: rejects a missing key, a foreign address, and a wildcard address', async () => {
  const { secret } = await newPw({ domain: DOMAIN, address: '*', protocols: ['api'] });
  const path = `/api/mailbox/messages?address=hello@${DOMAIN}`;

  assert.equal((await fetch(BASE + path)).status, 401, 'no bearer');
  assert.equal((await mailbox(path, 'mk_pw_bogus')).status, 403, 'unknown key');
  assert.equal((await mailbox(`/api/mailbox/messages?address=hello@other.example`, secret)).status, 403,
    'key never reaches another domain');
  assert.equal((await mailbox('/api/mailbox/messages', secret)).status, 400, 'address is required');
  assert.equal((await mailbox(`/api/mailbox/messages?address=*@${DOMAIN}`, secret)).status, 400,
    'a wildcard is not a concrete mailbox');
});

test('last_used_at is recorded on API use', async () => {
  const { id, secret } = await newPw({ domain: DOMAIN, address: 'tracked', protocols: ['api'] });
  const before = (await (await admin('/api/admin/app-passwords')).json()).appPasswords.find((k) => k.id === id);
  assert.equal(before.last_used_at, null, 'unused');
  await mailbox(`/api/mailbox/messages?address=tracked@${DOMAIN}`, secret);
  const after = (await (await admin('/api/admin/app-passwords')).json()).appPasswords.find((k) => k.id === id);
  assert.ok(after.last_used_at > 0, 'stamped');
});

test('legacy app-password endpoint still works and authenticates over IMAP', async () => {
  const { password, username } = await (await admin('/api/admin/app-passwords', { username: `legacy@${DOMAIN}` })).json();
  assert.equal(username, `legacy@${DOMAIN}`);
  assert.equal((await imapAuth(`legacy@${DOMAIN}`, password)).ok, true);
  assert.equal((await imapAuth(`other@${DOMAIN}`, password)).ok, false, 'still address-scoped');
  // …and it shows up as an imap-only mailbox key.
  const { appPasswords } = await (await admin('/api/admin/app-passwords')).json();
  const row = appPasswords.find((k) => k.address === 'legacy');
  assert.deepEqual(row.protocols, ['imap']);
  // The legacy credentials view keeps listing it.
  const creds = await (await admin('/api/admin/credentials')).json();
  assert.ok(creds.appPasswords.includes(`legacy@${DOMAIN}`));
  assert.ok(Array.isArray(creds.appPasswordRows), 'credentials expose the full rows too');
});

test('rows written before scoping existed keep working (legacy mk_imap_ secret)', async () => {
  // Seed a store the old way (writing app_passwords directly), then boot a server on it.
  const legacyDir = mkdtempSync(join(tmpdir(), 'mk-legacy-'));
  const P = PORT + 1;
  const seed = `
    import { Store } from '${join(dir, 'lib/db.mjs')}';
    import { randomBytes, scryptSync } from 'node:crypto';
    const s = new Store(process.env.DATA_DIR);
    const u = s.addUser('default');
    s.addDomain('${DOMAIN}', u);
    const salt = randomBytes(16);
    const hash = salt.toString('hex') + ':' + scryptSync('mk_imap_legacysecret', salt, 32).toString('hex');
    s.db.prepare('INSERT INTO app_passwords(username, hash, user_id) VALUES (?, ?, ?)')
      .run('old@${DOMAIN}', hash, u);
  `;
  execFileSync('node', ['--input-type=module', '-e', seed], { env: { ...process.env, DATA_DIR: legacyDir } });

  const p = spawn('node', [join(dir, 'server.mjs')],
    { env: { ...process.env, DATA_DIR: legacyDir, HMAC_SECRET: SECRET, PORT: String(P) }, stdio: 'ignore' });
  try {
    const B = `http://127.0.0.1:${P}`;
    for (let i = 0; i < 60; i++) {
      try { await fetch(B + '/api/admin/overview'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const auth = await (await fetch(B + '/api/imap/auth', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ username: `old@${DOMAIN}`, password: 'mk_imap_legacysecret', ip: '' }),
    })).json();
    assert.equal(auth.ok, true, 'the original secret still signs in after migration');

    const { appPasswords } = await (await fetch(B + '/api/admin/app-passwords', {
      headers: { authorization: 'Bearer ' + SECRET },
    })).json();
    const migrated = appPasswords.find((k) => k.address === 'old' && k.domain === DOMAIN);
    assert.ok(migrated, 'backfilled with its own address as the scope');
    assert.deepEqual(migrated.protocols, ['imap'], 'imap-only, exactly as before');
    assert.equal(appPasswords.filter((k) => k.address === 'old').length, 1, 'backfill is idempotent');

    // A legacy secret must never gain API access it was not granted.
    const apiTry = await fetch(`${B}/api/mailbox/messages?address=old@${DOMAIN}`,
      { headers: { authorization: 'Bearer mk_imap_legacysecret' } });
    assert.equal(apiTry.status, 403, 'imap-only legacy secret is refused over the API');
  } finally {
    p.kill();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('CLI add-app-password mints usable passwords', async () => {
  const run = (...args) => execFileSync('node', [join(dir, 'cli.mjs'), ...args],
    { env: { ...process.env, DATA_DIR: dataDir } }).toString().trim();

  const domainWide = run('add-app-password', DOMAIN, '*', '--imap', '--api', '--label=cli key');
  assert.ok(domainWide.startsWith('mk_pw_'));
  assert.equal((await imapAuth(`cli-user@${DOMAIN}`, domainWide)).ok, true);
  assert.equal((await mailbox(`/api/mailbox/messages?address=cli-user@${DOMAIN}`, domainWide)).status, 200);

  // Defaults: '*' address, imap only.
  const defaulted = run('add-app-password', DOMAIN);
  assert.equal((await imapAuth(`whoever@${DOMAIN}`, defaulted)).ok, true);
  assert.equal((await mailbox(`/api/mailbox/messages?address=whoever@${DOMAIN}`, defaulted)).status, 403);

  assert.match(run('list'), /app-passwords=/);
});

// An address-scoped password must see the same mail over IMAP as over the REST routes —
// otherwise the scope the UI promises is fiction on the protocol most people use.
test('IMAP sessions are scoped to the matched address', async () => {
  const wild = (await newPw({ label: 'wide', domain: DOMAIN, address: '*', protocols: ['imap'] })).password;
  const only = (await newPw({ label: 'one', domain: DOMAIN, address: 'scoped', protocols: ['imap'] })).password;

  await ingest(`scoped@${DOMAIN}`, 'for the scoped mailbox');
  await ingest(`other@${DOMAIN}`, 'for a different mailbox');

  const asWild = await imapAuth(`scoped@${DOMAIN}`, wild);
  assert.equal(asWild.ok, true);
  assert.equal(asWild.mailboxId, null, 'wildcard password stays account-wide');
  const wildList = await (await edge('/api/imap/list', { userId: asWild.userId, mailboxId: asWild.mailboxId, mailbox: 'INBOX' })).json();
  assert.ok(wildList.messages.length >= 2, 'account-wide session sees every address');

  const asScoped = await imapAuth(`scoped@${DOMAIN}`, only);
  assert.equal(asScoped.ok, true);
  assert.equal(asScoped.mailboxId, `scoped@${DOMAIN}`, 'concrete password scopes the session');
  const scoped = await (await edge('/api/imap/list', { userId: asScoped.userId, mailboxId: asScoped.mailboxId, mailbox: 'INBOX' })).json();
  assert.ok(scoped.messages.length >= 1, 'sees its own mail');
  assert.ok(
    scoped.messages.every((m) => (m.to_addr || '').toLowerCase() === `scoped@${DOMAIN}`),
    'never sees another address on the same account',
  );
  const st = await (await edge('/api/imap/status', { userId: asScoped.userId, mailboxId: asScoped.mailboxId, mailbox: 'INBOX' })).json();
  assert.equal(st.total, scoped.messages.length, 'STATUS agrees with LIST');
});
