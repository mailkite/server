// Fetch the platform's verified domains from the Worker and write config/host_list,
// so the edge only accepts RCPT for domains we can actually route (anti-open-relay).
//
// Run at boot (entrypoint) and/or on an interval. Non-fatal: if the fetch fails we keep
// the existing committed host_list rather than blocking startup.
//
// Env:
//   MAILKITE_API_URL    base URL of the Worker (e.g. https://api.mailkite.dev)
//   MAILKITE_HMAC_SECRET shared INGEST_SECRET (sent as Bearer)

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_LIST = join(__dirname, '..', 'config', 'host_list');

const base = process.env.MAILKITE_API_URL;
const secret = process.env.MAILKITE_HMAC_SECRET;

if (!base || !secret) {
  console.warn('[sync-host-list] MAILKITE_API_URL / MAILKITE_HMAC_SECRET unset — keeping existing host_list');
  process.exit(0);
}

try {
  const res = await fetch(new URL('/api/mx/accepted-domains', base), {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[sync-host-list] ${res.status} from API — keeping existing host_list`);
    process.exit(0);
  }
  const { domains } = await res.json();
  const body =
    '# Auto-synced from GET /api/mx/accepted-domains. Do not edit by hand.\n' +
    (Array.isArray(domains) ? domains : []).join('\n') + '\n';
  await writeFile(HOST_LIST, body, 'utf8');
  console.log(`[sync-host-list] wrote ${Array.isArray(domains) ? domains.length : 0} domain(s)`);
} catch (e) {
  console.warn(`[sync-host-list] ${e.message} — keeping existing host_list`);
  process.exit(0);
}
