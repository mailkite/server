// Inbound webhook dispatch — the "receive email as a webhook" half of the product,
// for self-hosted installs.
//
// On ingest we store first, then queue a delivery. The queue is a table, so a restart
// mid-retry doesn't lose the attempt, and a receiver that's down gets backed off
// instead of blocking the SMTP transaction.
//
// Payload is metadata + a raw_url pointer, not the whole message: webhook receivers
// mostly route on headers, and posting multi-MB bodies to a flaky endpoint is how
// retry storms start. Fetch the raw over the admin API when you need it.

import { createHmac } from 'node:crypto';

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 30 * 60_000]; // after attempts 1..4
export const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

/** t=<unix>,v1=<hex> over "<t>." + body — same scheme the edges use for ingest. */
export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function buildPayload({ domain, rcpt, mailfrom, from, subject, uid, baseUrl }) {
  return JSON.stringify({
    event: 'inbound',
    domain,
    rcpt,
    mailfrom: mailfrom || '',
    from: from || '',
    subject: subject || '',
    uid,
    receivedAt: new Date().toISOString(),
    // Where to GET the full RFC822 (admin-authenticated).
    raw_url: `${baseUrl || ''}/api/admin/raw?mailbox=INBOX&uid=${uid}`,
  });
}

/**
 * The secret that signs one queued delivery: a route's own (isolating rotation and
 * blast radius per route) when the row came from a route, else the domain's.
 * Null when the config behind it was deleted mid-flight.
 */
function secretFor(store, row) {
  if (row.route_id == null) return store.webhook(row.domain)?.secret ?? null;
  const route = store.route(row.route_id);
  return route && route.active ? route.webhook_secret : null;
}

/** POST one queued delivery. Returns {ok, error}. Never throws. */
export async function attempt(store, row, { fetchImpl = fetch } = {}) {
  const secret = secretFor(store, row);
  if (!secret) return { ok: false, error: row.route_id == null ? 'webhook removed for domain' : 'route removed or disabled' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(row.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mailkite-signature': signPayload(secret, row.payload),
        'x-mailkite-event': 'inbound',
        'user-agent': 'MailKite-Server/1.0',
      },
      body: row.payload,
      signal: ac.signal,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Run every due delivery once. Returns counts — used by the scanner and by tests. */
export async function runDue(store, opts = {}) {
  const due = store.dueDeliveries(opts.limit ?? 20, opts.now ?? Date.now());
  let delivered = 0, retried = 0, failed = 0;
  for (const row of due) {
    const { ok, error } = await attempt(store, row, opts);
    if (ok) { store.recordAttempt(row.id, { ok: true }); delivered++; continue; }
    const nextAttemptNo = row.attempts + 1;
    const maxed = nextAttemptNo >= MAX_ATTEMPTS;
    store.recordAttempt(row.id, {
      ok: false, error, maxed,
      backoffMs: BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)],
    });
    if (maxed) { failed++; console.error(`webhook: ${row.domain} → ${row.url} giving up after ${nextAttemptNo} attempts (${error})`); }
    else { retried++; console.warn(`webhook: ${row.domain} → ${row.url} attempt ${nextAttemptNo} failed (${error}) — will retry`); }
  }
  return { delivered, retried, failed };
}

/** Background scanner. Returns a stop() — unref'd so it never holds the process open. */
export function startScanner(store, intervalMs = 30_000) {
  const timer = setInterval(() => { runDue(store).catch((e) => console.error('webhook scanner:', e.message)); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
