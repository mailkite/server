#!/usr/bin/env node
// Admin CLI for api-local. Operates directly on the SQLite store (no server needed).
//
//   node cli.mjs add-user <name>
//   node cli.mjs add-domain <domain> <user>
//   node cli.mjs add-key <user>                  → prints a new mk_local_ API key
//   node cli.mjs add-app-password <domain> [address-pattern] [--imap] [--api] [--label=…]
//                                                → prints a new mk_pw_ app password.
//                                                  address-pattern defaults to '*'
//                                                  (every address on the domain);
//                                                  access defaults to --imap.
//                                                  See docs/app-passwords.md
//   node cli.mjs add-app-password <address>      → shorthand: that one address, IMAP only
//   node cli.mjs list
//   node cli.mjs reset-admin <email>             → wipes web-console admins + sessions,
//                                                  seeds <email> (recovery if someone
//                                                  claimed an unclaimed install first)
//   node cli.mjs signin-link [email]             → mint a one-time /login#token=… URL
//                                                  (recovery when the provider is down)
//   node cli.mjs auth-status                     → the configured sign-in method and
//                                                  when it was last proven to work
//   node cli.mjs reset-auth                      → clear the method, revoke sessions,
//                                                  re-open setup (recovery when the
//                                                  provider dies). docs/auth-setup.md
//
// DATA_DIR env selects the store (default ./data, same as the server).

import { Store } from './lib/db.mjs';
import { normalizePattern } from './lib/patterns.mjs';

const DATA_DIR = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
const store = new Store(DATA_DIR);
const argv = process.argv.slice(2);
const flags = argv.filter((x) => x.startsWith('--'));
const [cmd, a, b] = argv.filter((x) => !x.startsWith('--'));
const flagValue = (name) => (flags.find((f) => f.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

const userId = (name) => {
  const r = store.db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (!r) { console.error(`no such user: ${name} (run: add-user ${name})`); process.exit(1); }
  return r.id;
};

switch (cmd) {
  case 'add-user':
    console.log(`user ${a} → id ${store.addUser(a)}`);
    break;
  case 'add-domain':
    store.addDomain(a, userId(b));
    console.log(`domain ${a} → user ${b}`);
    break;
  case 'add-key':
    console.log(store.addApiKey(userId(a)));
    break;
  case 'add-app-password': {
    // Two shapes: `<domain> [pattern]`, or the older `<address>` (one address, IMAP).
    const arg = String(a || '');
    const oneAddress = arg.includes('@');
    const domain = (oneAddress ? arg.slice(arg.lastIndexOf('@') + 1) : arg).toLowerCase();
    const uid = store.userForDomain(domain);
    if (uid == null) { console.error(`domain ${domain} is not hosted here (run: add-domain ${domain} <user>)`); process.exit(1); }
    const address = normalizePattern(oneAddress ? arg.slice(0, arg.lastIndexOf('@')) : (b || '*'), domain);
    if (!address) { console.error(`invalid address pattern: ${oneAddress ? arg : b}`); process.exit(1); }
    const protocols = [flags.includes('--imap') && 'imap', flags.includes('--api') && 'api'].filter(Boolean);
    const { secret } = store.addAppPassword({
      domain, address, protocols: protocols.length ? protocols : ['imap'],
      label: flagValue('label') || null, userId: uid,
    });
    console.log(secret);
    break;
  }
  case 'reset-admin': {
    if (!a) { console.error('usage: reset-admin <email>'); process.exit(1); }
    store.resetAdmin(a);
    console.log(`web-console admin reset → ${a.toLowerCase()} (all sessions revoked)`);
    // Without this the rescue can brick the box: the claim is closed (an admin now
    // exists) and, until setup completes, no session can be minted over the network.
    console.log(`sign in with: /login#token=${store.createLoginToken(a)}`);
    break;
  }
  // Mint a one-time sign-in link from the box. Shell access is already the root
  // authority (it can read the database), so this weakens nothing — it just makes the
  // documented recovery actually usable when the configured provider is down.
  case 'signin-link': {
    const email = a || store.db.prepare('SELECT email FROM admin_users ORDER BY added LIMIT 1').get()?.email;
    if (!email) { console.error('usage: signin-link <email>   (no admins on record)'); process.exit(1); }
    if (!store.isAdminUser(email)) { console.error(`${email} is not a console admin (run: reset-admin ${email})`); process.exit(1); }
    console.log(`/login#token=${store.createLoginToken(email)}`);
    console.log('(valid once, for 15 minutes — prefix it with your server URL)');
    break;
  }
  // --- sign-in setup recovery (docs/auth-setup.md) ------------------------------
  // Once setup is complete a broken provider means no console sign-in — correct, but
  // it must never brick the box. Shell access is the root authority, so these two
  // commands are the documented way back in.
  case 'auth-status': {
    const cfg = store.authConfig();
    const envKey = process.env.MAILKITE_SEND_KEY ? 'MAILKITE_SEND_KEY' : (process.env.OAUTH_CLIENT_ID ? 'OAUTH_*' : null);
    if (envKey) console.log(`method: set by environment (${envKey}) — this overrides any stored config`);
    if (!cfg.method) {
      console.log(envKey ? 'stored: none' : 'method: none — setup is owed; the console gates on finishing it');
    } else {
      const s = cfg.settings || {};
      const detail = cfg.method === 'email_smtp' ? `${s.user ? `${s.user}@` : ''}${s.host}:${s.port}`
        : cfg.method === 'email_cloud' ? `from ${s.from || '(default)'}`
        : `${s.clientId ? `client ${String(s.clientId).slice(0, 12)}…` : ''} allow=[${(s.allowedEmails || []).join(', ')}]`;
      console.log(`stored: ${cfg.method}  ${detail}`);
      console.log(`verified: ${cfg.verifiedAt ? new Date(cfg.verifiedAt).toISOString() : 'never'}`);
      console.log(`complete: ${cfg.complete}`);
    }
    const admins = store.db.prepare('SELECT email FROM admin_users ORDER BY email').all().map((r) => r.email);
    console.log(`admins: ${admins.length ? admins.join(', ') : '(none — install is unclaimed)'}`);
    break;
  }
  case 'reset-auth': {
    store.resetAuth();
    console.log('sign-in method cleared, all sessions revoked — setup re-opens on next visit');
    if (process.env.MAILKITE_SEND_KEY || process.env.OAUTH_CLIENT_ID) {
      console.log('NOTE: environment variables still configure a method; unset them to run the wizard');
    }
    break;
  }
  case 'list': {
    for (const u of store.db.prepare('SELECT * FROM users').all()) {
      const domains = store.db.prepare('SELECT domain FROM domains WHERE user_id = ?').all(u.id).map((r) => r.domain);
      const keys = store.db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ?').get(u.id).c;
      const pws = store.appPasswords(u.id);
      console.log(`${u.id}  ${u.name}  domains=[${domains}]  api-keys=${keys}  app-passwords=${pws.length}`);
      for (const k of pws) {
        console.log(`      #${k.id}  ${k.address}@${k.domain}  [${k.protocols.join(',')}]  ${k.label || ''}`);
      }
    }
    break;
  }
  default:
    console.error('usage: cli.mjs add-user|add-domain|add-key|add-app-password|reset-admin|signin-link|auth-status|reset-auth|list …');
    process.exit(1);
}
