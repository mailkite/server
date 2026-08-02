#!/usr/bin/env node
// Admin CLI for api-local. Operates directly on the SQLite store (no server needed).
//
//   node cli.mjs add-user <name>
//   node cli.mjs add-domain <domain> <user>
//   node cli.mjs add-key <user>                  → prints a new mk_local_ API key
//   node cli.mjs add-app-password <address>      → prints a new IMAP app-password
//   node cli.mjs list
//   node cli.mjs reset-admin <email>             → wipes web-console admins + sessions,
//                                                  seeds <email> (recovery if someone
//                                                  claimed an unclaimed install first)
//
// DATA_DIR env selects the store (default ./data, same as the server).

import { Store } from './lib/db.mjs';

const DATA_DIR = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;
const store = new Store(DATA_DIR);
const [cmd, a, b] = process.argv.slice(2);

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
    const domain = a.split('@')[1];
    const uid = store.userForDomain(domain || '');
    if (uid == null) { console.error(`domain ${domain} is not hosted here (run: add-domain ${domain} <user>)`); process.exit(1); }
    console.log(store.addAppPassword(a, uid));
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
      const pws = store.db.prepare('SELECT COUNT(*) c FROM app_passwords WHERE user_id = ?').get(u.id).c;
      console.log(`${u.id}  ${u.name}  domains=[${domains}]  api-keys=${keys}  app-passwords=${pws}`);
    }
    break;
  }
  default:
    console.error('usage: cli.mjs add-user|add-domain|add-key|add-app-password|reset-admin|list …');
    process.exit(1);
}
