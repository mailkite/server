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

## Security notes

- A backend can only ever *claim domains*; priority order means a lower-priority backend
  cannot shadow a higher-priority one. The routing table is operator-controlled config —
  this is multi-backend, not open multi-tenancy.
- Per-backend secrets isolate compromise: leaking one backend's HMAC secret does not let
  anyone sign ingests for another backend.

## Scope

Inbound MX only (`mta/`). The submission and IMAP edges stay single-backend for now —
their auth is user-credential-based and a routing story there needs its own design.
