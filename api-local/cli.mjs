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
    console.error('usage: cli.mjs add-user|add-domain|add-key|add-app-password|reset-admin|list …');
    process.exit(1);
}
