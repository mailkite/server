// Smoke tests under plain node — no Haraka install. A minimal plugin facade provides
// the facilities the canonical plugins use (config.get, log*, register_hook, inherits),
// and Haraka's OK/DENY/DENYSOFT globals are stubbed the same way mta/test does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

global.OK = 'OK';
global.DENY = 'DENY';
global.DENYSOFT = 'DENYSOFT';

function facade(iniMain) {
  const calls = { hooks: [], inherited: [] };
  return {
    calls,
    name: 'mailkite',
    config: {
      get(file, type_or_cb) {
        if (file === 'mailkite.ini') return { main: iniMain };
        if (file === 'host_list' && type_or_cb === 'list') return [];
        return undefined; // no backends.json → single-backend mode
      },
    },
    register_hook(hook, method) { calls.hooks.push(`${hook}:${method}`); },
    inherits(parent) { calls.inherited.push(parent); },
    logdebug() {}, loginfo() {}, lognotice() {}, logwarn() {}, logerror() {}, logcrit() {},
  };
}

const plugin = require_(join(pkgDir, 'index.js'));

test('sync check: package copies match canonical sources', () => {
  execFileSync(process.execPath, [join(pkgDir, 'scripts', 'sync.mjs'), '--check']);
});

test('role=mx grafts rcpt + ingest and wires the rcpt hook', () => {
  const p = facade({
    role: 'mx',
    api_url: 'http://127.0.0.1:9',
    ingest_url: 'http://127.0.0.1:9/api/ingest',
    hmac_secret: 'test-secret',
  });
  Object.setPrototypeOf(p, plugin);
  p.register();
  assert.equal(typeof p.check_rcpt, 'function');
  assert.equal(typeof p.hook_queue, 'function', 'hook_queue present for Haraka post-register scan');
  assert.equal(typeof p.post_to_ingest, 'function');
  assert.ok(p.calls.hooks.includes('rcpt:check_rcpt'), `rcpt hook registered (${p.calls.hooks})`);
});

test('role=submit grafts auth (with auth_base inherit) and delegates relay hooks', () => {
  const p = facade({
    role: 'submit',
    api_url: 'http://127.0.0.1:9',
    hmac_secret: 'test-secret',
  });
  Object.setPrototypeOf(p, plugin);
  p.register();
  assert.deepEqual(p.calls.inherited, ['auth/auth_base']);
  assert.equal(typeof p.check_plain_passwd, 'function');
  assert.equal(typeof p.hook_capabilities, 'function');
  assert.ok(p.calls.hooks.includes('queue:mailkite_relay_queue'), String(p.calls.hooks));
  assert.ok(p.calls.hooks.includes('queue_outbound:mailkite_relay_queue'), String(p.calls.hooks));
  // relay state lives on the delegate, not the plugin: auth's 5s timeout must survive
  assert.equal(p.timeout_ms, 5000, 'auth timeout not clobbered by relay load_cfg');
});

test('unknown role throws', () => {
  const p = facade({ role: 'bogus' });
  Object.setPrototypeOf(p, plugin);
  assert.throws(() => p.register(), /unknown role/);
});
