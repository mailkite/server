# backend-local — reference backend (SQLite)

The reference implementation of [the backend contract](../docs/contract.md): a single
Node process, SQLite (`node:sqlite`) + content-addressed file blobs, **zero npm
dependencies**. Every edge in this repo (MX, submission, IMAP) runs against it unchanged —
it is the "self-hosted" half of the provider toggle, MailKite Cloud being the other.

| | |
|---|---|
| Implements | `/api/ingest`, `/api/mx/accepted-domains`, `/api/smtp/auth`, `/api/relay`, `/api/imap/{auth,status,list,flags,raw}` |
| Storage | `DATA_DIR/mail.db` (WAL) + `DATA_DIR/blobs/<sha256>` raw messages |
| Requires | Node ≥ 22.5 (`node:sqlite`) |
| Listens | `127.0.0.1:8787` by default — keep it loopback/private; the edges are its only intended callers |

## Runs on

Any **Node ≥ 22.5 host**: bare VPS (systemd), **Docker**, **Fly.io**, **Railway**, or a
laptop. That's the whole support matrix by design — the zero-dependency `node:http` +
`node:sqlite` architecture stays as-is. Cloudflare Workers / Vercel serverless are **out
of scope by decision**: serverless runtimes can't hold a SQLite file or a raw-TCP edge,
and the hosted backend for that deployment style already exists — it's
[MailKite Cloud](https://mailkite.dev), speaking the same contract.

## Run

```sh
HMAC_SECRET=$(openssl rand -hex 32) node server.mjs
# → backend-local listening on http://127.0.0.1:8787
```

Set the same value as `MAILKITE_HMAC_SECRET` on the edges, and point them at it:
`MAILKITE_API_URL=http://127.0.0.1:8787`, `MAILKITE_INGEST_URL=http://127.0.0.1:8787/api/ingest`.

Optional native HTTPS: set `TLS_CERT` + `TLS_KEY` (PEM paths) to serve TLS directly —
no reverse proxy needed for a single-box install.

### Docker

```sh
# from the repo root (the image bundles the built web console)
docker build -f backend-local/Dockerfile -t mailkite-server .
docker run -d -p 8787:8787 -e HMAC_SECRET=$(openssl rand -hex 32) \
  -v mail-data:/data mailkite-server
```

Or `docker compose up -d` at the repo root (`compose.yaml`; add `--profile edges` for the
MX edge). Hosted variants: [`../deploy/fly.md`](../deploy/fly.md) ·
[`../deploy/railway.md`](../deploy/railway.md). One replica only — SQLite is
single-writer; `/data` is the database, back it up.

## Provision accounts (CLI)

```sh
node cli.mjs add-user gabe
node cli.mjs add-domain yourdomain.com gabe
node cli.mjs add-key gabe                       # → mk_local_… (SMTP AUTH password / relay Bearer)
node cli.mjs add-app-password you@yourdomain.com # → mk_imap_… (IMAP login)
node cli.mjs list
```

## v1 scope — honest limits

- **Outbound is not internet delivery.** `/api/relay` enforces the From-domain gate,
  records to **Sent**, and loop-delivers to locally-hosted domains. Recipients on foreign
  domains are accepted-and-skipped (logged). Real outbound needs a smarthost hop or
  MailKite Cloud — deliverability (IP reputation, DKIM, FBLs) is exactly the part you
  should think twice about self-hosting. A smarthost option is on the roadmap.
- **No webhooks yet.** Inbound mail is stored and readable over IMAP; the
  inbound-webhook dispatch the cloud does is roadmap.
- **Single process, single SQLite file.** Right-sized for a personal/app mailbox volume,
  not a mail farm.
- IMAP brute-force lockout is per-IP (20 fails / 15 min), mirroring the cloud's
  no-victim-DoS policy; pair it with the fail2ban configs in `imap/fail2ban/`.

## Tests

```sh
npm test                      # conformance suite (boots a throwaway instance)
node ../scripts/e2e-imap.mjs  # full stack: ingest → backend → real imap/ daemon → TLS IMAP client
```

The conformance suite is the executable form of `docs/contract.md` and can be pointed at
any backend: `BACKEND_URL=… HMAC_SECRET=… API_KEY=… APP_PASSWORD=… npm test`.
