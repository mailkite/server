# Multi-backend routing — one MX, many backends

The MX edge can serve **multiple backends at once**: each recipient domain is owned by
exactly one backend, RCPT checks consult every backend's accepted-domains list, and
accepted mail is ingested to whichever backend owns the recipient's domain. One shared
edge (with its port 25, PTR, and IP reputation) can then front MailKite Cloud, a
self-hosted `api-local`, or any other implementation of
[the contract](contract.md) — simultaneously.

## Prior art (why this design)

Per-domain routing inside the MTA is the established pattern: Postfix `transport_maps`,
Haraka's own [recipient-routes](https://github.com/haraka/haraka-plugin-recipient-routes)
plugin (domain/address → MX route). This is the same design with an HTTP backend as the
route target instead of an SMTP/LMTP host — which keeps the edge stateless and the
delivery semantics (retry on non-2xx) unchanged.

**Considered and deferred: per-tenant backend containers.** Containers answer a
different question — *isolation between backends* — not how one MX reaches many of
them; you need this routing table under either model. Per-tenant containers remain the
natural deployment for managed dedicated instances later; nothing here precludes them.

## Configuration

Without `config/backends.json`, behavior is **byte-identical to single-backend mode**
(env `MAILKITE_API_URL` / `MAILKITE_INGEST_URL` / `MAILKITE_HMAC_SECRET`). With it:

```json
{
  "backends": [
    { "name": "cloud", "url": "https://api.mailkite.dev",    "secretEnv": "MAILKITE_HMAC_SECRET" },
    { "name": "demo",  "url": "https://server.mailkite.dev", "secretEnv": "MAILKITE_DEMO_SECRET" }
  ]
}
```

- `url` — base URL; the edge appends `/api/mx/accepted-domains` and `/api/ingest`.
- `secretEnv` — name of the env var holding that backend's HMAC secret. Secrets stay in
  the environment, never in config files.
- **Order is priority.** If two backends claim the same domain, the earlier entry wins
  and the edge logs a loud conflict warning. Put the backend you trust most (e.g. the
  cloud) first — a later backend can never hijack an earlier backend's domains.

## Semantics

- **RCPT:** each backend keeps its own cached accepted-domains set (TTL + live re-check
  on miss, exactly the single-backend behavior). A domain is accepted iff some backend
  claims it; the claiming backend is recorded for ingest. One backend being down never
  evicts another's cache — its domains serve from last-known, or tempfail cold.
- **Ingest:** recipients are grouped by owning backend; the raw message is POSTed once
  per owning backend (that backend's secret signs it, `x-mailkite-rcpt` carries only its
  recipients). All groups 2xx → `250`. Any group fails → `DENYSOFT` (sender retries).
- **Duplicates on retry:** if backend A stored the message and backend B tempfailed, the
  sender's retry re-delivers to both. Backends should make ingest idempotent —
  `api-local` dedupes on (recipient, mailbox, content hash); the raw blob store is
  already content-addressed. Cross-backend recipient mixes are rare in practice (one
  message addressed to two different organizations' domains at the same MX).

## Add a backend

Adding one does not touch the others. Do these in order:

1. **Implement the two endpoints.** The new backend serves
   `GET /api/mx/accepted-domains` and `POST /api/ingest` as specified in
   [`contract.md`](./contract.md). Both require its own secret; neither reads another
   backend's state.
2. **Create a dedicated secret.** Generate a new HMAC secret for this backend only, and
   put it in the edge's environment (for the reference deployment, the
   `mailkite-mta` unit's environment file — never in `backends.json` or the repo).
3. **Append the entry.** Add `{name, url, secretEnv}` to `config/backends.json` **after**
   the existing entries. Order is priority, so appending means the new backend can never
   shadow an existing one. A starting point ships in
   `mta/config/backends.example.json`.
4. **Restart the edge.** The router is built at plugin registration. A restart briefly
   tempfails new connections; connected senders retry, and queued mail is unaffected.
5. **Verify before announcing the domain** (next section).

## Verify the routing

Check the backend's claim list directly, then check what the edge does with it:

```sh
# 1. The backend answers with only its own domains.
curl -fsS -H "Authorization: Bearer $NEW_BACKEND_SECRET" \
  https://new-backend.example.com/api/mx/accepted-domains

# 2. The edge accepts a recipient the new backend claims.
swaks --to test@new-domain.example --server mx.example.com

# 3. The edge rejects a domain nobody claims (anti-open-relay).
swaks --to test@unclaimed.example --server mx.example.com
```

The edge logs one line per successful refresh:

```text
backends: new-backend: refreshed 1 accepted domain(s)
```

For an end-to-end check, send a real message to an address on a domain **only** the new
backend claims, and confirm the message is durable in that backend before the edge
returned `250`. Then confirm an address on an existing backend still lands in its
original store — the add is only correct if both directions hold.

## Failure modes

| Symptom | Cause | What the edge does |
|---|---|---|
| One backend's domains are rejected at RCPT | Its `secretEnv` is unset, so the entry was skipped at startup | Logs `env <NAME> is unset/empty — backend skipped`; every other backend keeps serving |
| A domain is rejected but its backend is up | The backend's accepted-domains list does not include it yet | `DENY` — the backend must claim the domain before the edge will accept it |
| A domain tempfails while other domains work | That backend is cold and unreachable | `DENYSOFT` for that domain only; other backends are unaffected |
| Every domain tempfails on a cold edge | No backend has produced a list yet | `DENYSOFT` rather than a bounce, because an unqueried backend may own the domain |
| A message is accepted twice by one backend | A partial ingest failure made the sender retry | Expected; backends must dedupe on recipient + content hash (the reference backend does) |
| Log line `CONFLICT — 2 backends claim <domain>` | Two claim lists overlap | The earlier entry wins; the warning is emitted once per domain |

## Security notes

- A backend can only ever *claim domains*; priority order means a lower-priority backend
  cannot shadow a higher-priority one. The routing table is operator-controlled config —
  this is multi-backend, not open multi-tenancy.
- Per-backend secrets isolate compromise: leaking one backend's HMAC secret does not let
  anyone sign ingests for another backend.

## Scope

Inbound MX only (`mta/`). The submission and IMAP edges stay single-backend for now —
their auth is user-credential-based and a routing story there needs its own design.
