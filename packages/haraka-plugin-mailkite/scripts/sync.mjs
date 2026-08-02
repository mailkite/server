#!/usr/bin/env node
// Sync the canonical plugin sources into this package (single source of truth stays
// in mta/ and mta-submit/). Default: copy. `--check`: exit 1 if the copies drift —
// run by `npm test` and `prepack`, and enforced in CI.

import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(pkg, '..', '..');

const FILES = {
  'mta/plugins/mailkite_ingest.js':        'plugins/mailkite_ingest.js',
  'mta/plugins/mailkite_rcpt.js':          'plugins/mailkite_rcpt.js',
  'mta-submit/plugins/auth_mailkite.js':   'plugins/auth_mailkite.js',
  'mta-submit/plugins/mailkite_relay.js':  'plugins/mailkite_relay.js',
  'mta/lib/backends.js':                   'lib/backends.js',
  'LICENSE':                               'LICENSE',
};

const check = process.argv.includes('--check');
let drift = 0;
for (const [src, dest] of Object.entries(FILES)) {
  const from = join(repo, src);
  const to = join(pkg, dest);
  if (check) {
    const same = existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8');
    if (!same) { console.error(`DRIFT: ${dest} != ${src} — run: npm run sync`); drift++; }
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`synced ${dest}`);
  }
}
if (check && drift) process.exit(1);
if (check) console.log('sync check: package matches canonical sources');
