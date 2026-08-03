# api-local — reference backend (SQLite)

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
# → api-local listening on http://127.0.0.1:8787
```

Set the same value as `MAILKITE_HMAC_SECRET` on the edges, and point them at it:
`MAILKITE_API_URL=http://127.0.0.1:8787`, `MAILKITE_INGEST_URL=http://127.0.0.1:8787/api/ingest`.

Optional native HTTPS: set `TLS_CERT` + `TLS_KEY` (PEM paths) to serve TLS directly —
no reverse proxy needed for a single-box install.

### Docker

```sh
# from the repo root (the image bundles the built web console)
docker build -f api-local/Dockerfile -t mailkite-server .
docker run -d -p 8787:8787 -e HMAC_SECRET=$(openssl rand -hex 32) \
  -v mail-data:/data mailkite-server
```

Or `docker compose up -d` at the repo root (`compose.yaml`; add `--profile edges` for the
MX edge). Hosted variants: [`../deploy/fly.md`](../deploy/fly.md) ·
[`../deploy/railway.md`](../deploy/railway.md). One replica only — SQLite is
single-writer; `/data` is the database, back it up.

## Web console auth (magic link)

**Sign-in mode depends on whether this server can send mail:**

| `SMARTHOST` / `MAILKITE_SEND_KEY` | Sign-in |
|---|---|
| neither set | An admin email **signs in directly** — no link, no log-digging. Knowing the admin address is the credential (the server has no way to verify it by mail). Per-IP rate limiting still applies. |
| either set | Magic link: the admin gets a single-use link (15 min) by email; only clicking it creates a session. |

Configure a mail channel before exposing an install to the internet if you want link
verification. Admin identity itself is anchored by `ADMIN_EMAIL` (or the first-visitor
claim on unclaimed installs — see below).

### Details


The web console signs in with **email magic links**, not the HMAC secret:

| Env | Purpose |
|---|---|
| `ADMIN_EMAIL` | The anchor admin — the one address always allowed to request a sign-in link. More admins can be invited from a signed-in session (`POST /api/admin/users`). |
| `MAILKITE_SEND_KEY` | Optional MailKite Cloud API key used to *send* the link emails (`POST api.mailkite.dev/v1/send`). Without it, links are printed to the server log: `journalctl -u mailkite-backend \| grep magic-link`. |
| `MAGIC_LINK_FROM` | Optional From address for link emails (default `no-reply@<first hosted domain>`). |

**Unclaimed install** (no `ADMIN_EMAIL`, no admins on record): the web console shows
"Create your admin account" and **the first email entered becomes the admin** — the
WordPress-install pattern, race accepted by design since a fresh install is short-lived
and empty. Every claim is logged (`web console admin claimed: <email> ip=<ip>`). If
someone else claims your install first, box access is the root credential:

```sh
node cli.mjs reset-admin you@yourdomain.com   # wipes admins + ALL sessions, seeds yours
```

Setting `ADMIN_EMAIL` disables claiming entirely — recommended for internet-facing
installs provisioned by script.

Sessions are httpOnly cookies (`mk_session`, 30-day rolling), stored **hashed** in
SQLite so a copied database can't be replayed. Cookie-authed requests must also carry
the `x-mailkite-ui: 1` header (CSRF gate). Link requests are rate-limited per IP
(5 / 15 min) and never reveal whether an email is an admin. The **HMAC bearer keeps
working** on `/api/admin/*` for scripts and the conformance suite.

## Provision accounts (CLI)

```sh
node cli.mjs add-user gabe
node cli.mjs add-domain yourdomain.com gabe
node cli.mjs add-key gabe                       # → mk_local_… (SMTP AUTH password / relay Bearer)
node cli.mjs add-app-password you@yourdomain.com # → mk_imap_… (IMAP login)
node cli.mjs list
node cli.mjs reset-admin you@yourdomain.com      # recover a squatted web-console claim
```

## Outbound (smarthost)

`/api/relay` enforces the From-domain gate, records the message to **Sent**, and
loop-delivers to locally-hosted domains. Everyone else goes through the **smarthost**
named by `SMARTHOST` — api-local deliberately isn't an outbound MTA, because
deliverability (IP reputation, DKIM alignment, feedback loops) is the part you should
think hardest about before self-hosting.

| `SMARTHOST` | Behavior |
|---|---|
| *(unset)* | External recipients are skipped and logged. Local delivery + IMAP still work. |
| `cloud` | Forwards the raw message to MailKite Cloud's `/api/relay` with `MAILKITE_SEND_KEY` as Bearer. |
| `smtp://user:pass@host:587` | Relays to any SMTP smarthost — EHLO → STARTTLS → AUTH PLAIN/LOGIN → DATA. |
| `smtps://user:pass@host:465` | Same, implicit TLS. |

```sh
SMARTHOST=cloud MAILKITE_SEND_KEY=mk_live_… node server.mjs
SMARTHOST=smtp://apikey:mk_live_…@smtp.mailkite.dev:587 node server.mjs
```

The relay response reports what happened: `{localDelivered, relayed, smarthost, externalSkipped}`.
A smarthost failure returns **502** rather than silently dropping mail — the submission
edge maps that to an SMTP tempfail so the client retries (the Sent copy is already stored,
so a retry can duplicate it; that's the deliberate trade against losing the message).

> **`SMARTHOST=cloud` gate:** the cloud applies *its own* From-domain verification. The
> sending domain must be verified on the MailKite Cloud account that owns
> `MAILKITE_SEND_KEY`, not just added here — otherwise the cloud returns 4xx and you'll
> see a 502 with its reason attached.

Credentials in a URL land in `ps` output and shell history; prefer an env file
(`EnvironmentFile=` in systemd, `env_file:` in compose).

## Inbound webhooks

Set one target per domain (web console → **Webhooks**, or the admin API) and every
inbound message for that domain is POSTed to it:

```sh
curl -X POST localhost:8787/api/admin/domains/webhook \
  -H "authorization: Bearer $HMAC_SECRET" -H 'content-type: application/json' \
  -d '{"domain":"yourdomain.com","url":"https://your-app.example/inbound"}'
# → {"ok":true,"domain":"yourdomain.com","url":"…","secret":"whsec_…"}
```

```jsonc
// POST body
{
  "event": "inbound",
  "domain": "yourdomain.com",
  "rcpt": "you@yourdomain.com",
  "mailfrom": "sender@far.example",   // envelope
  "from": "Alice <alice@far.example>", // header
  "subject": "hello",
  "uid": 42,
  "receivedAt": "2026-08-02T12:00:00.000Z",
  "raw_url": "https://…/api/admin/raw?mailbox=INBOX&uid=42"  // full RFC822, admin-auth
}
```

- **Signed** with the domain's `whsec_…`: `x-mailkite-signature: t=<unix>,v1=<hex>` where
  the hex is `HMAC-SHA256(secret, "<t>." + body)` — the same scheme the edges use for
  ingest. Verify over the exact body bytes.
- **Metadata, not the whole message.** Receivers mostly route on headers; posting
  multi-MB bodies at a flaky endpoint is how retry storms start. Fetch `raw_url` when
  you need the full message.
- **Store first, then dispatch.** Mail is never lost because a receiver is down — the
  SMTP transaction doesn't wait on your endpoint.
- **Retries:** 5 attempts at 1m / 5m / 30m / 30m backoff, tracked in a `deliveries`
  table (survives restarts). Any 2xx is success. `GET /api/admin/domains/webhook-status`
  reports recent attempts and counts; the web console shows the same.
- The signing secret is generated with the first URL and stays stable across URL edits,
  so receivers don't have to re-key.

## v1 scope — honest limits

- **No inbound routing rules.** One webhook per domain — no per-address routes or
  filters (`routes` stays false in `capabilities`).
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
