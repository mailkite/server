# imap — IMAP edge (read access)

A thin **IMAP server** that lets a standard mail client (Thunderbird, Apple Mail, Outlook)
— or an agent's IMAP library — read an account's received mail. Built on **`imap-core`**
(the protocol engine by the Nodemailer author); all storage lives behind the backend
contract, reached through `/api/imap/*`. No mailbox store runs here.

| | |
|---|---|
| Listens | `:993` (IMAPS, implicit TLS) |
| Auth | a scoped **app-password** (username = a mailbox address, e.g. `you@yourdomain.com`) — **never** a full API key |
| Validates auth via | `POST /api/imap/auth` (HMAC-Bearer) |
| Reads from | `POST /api/imap/{status,list,flags,raw}` (HMAC-trusted; the daemon passes the account it authenticated) |
| Mailboxes (v1) | **INBOX** (inbound) · **Sent** (outbound) |
| Scope (v1) | read-mostly: LOGIN, LIST, SELECT/EXAMINE, STATUS, FETCH, SEARCH, STORE(flags). Mutating folder ops refused |

## How a session flows

```
client → IMAPS 993 → LOGIN you@yourdomain.com <app-password>
  onAuth → POST /api/imap/auth {username,password} → {userId, domain}   (535-equiv on bad creds)
SELECT INBOX  → onOpen  → /api/imap/status + /api/imap/list → UIDVALIDITY/UIDNEXT/uidList
FETCH …       → onFetch → /api/imap/list (+ /api/imap/raw per message) → imap-core formats ENVELOPE/BODY[]
STORE flags   → onUpdate → /api/imap/flags
SEARCH …      → onSearch → match imap-core's SEARCH tree over the loaded messages
```

The daemon is a dumb protocol head; parsing, gating, retention, and encryption all live
behind the backend contract.

## Encryption

For **encrypted domains**, IMAP serves the stored **encrypted message** and the client
decrypts with its own key (standard **PGP/MIME** by default, **S/MIME** opt-in).
Passthrough (zero-retention) domains have no mailbox and don't offer IMAP.

## Config (env, never on disk)

| Name | Purpose |
|---|---|
| `MAILKITE_HMAC_SECRET` | Must equal the backend's ingest secret. Bearer for `/api/imap/*`. |
| `MAILKITE_API_URL` | Base URL of the backend. |
| `IMAP_PORT` / `IMAP_HOST` | Default `993` / `::`. |
| `TLS_CERT` / `TLS_KEY` | PEM paths (default `config/tls/tls_{cert,key}.pem`). |

Set these in `/etc/mailkite/imap.env` (loaded by the systemd unit — see
[`../docs/self-hosting.md`](../docs/self-hosting.md)).

## TLS

Provision a Let's Encrypt cert for your IMAP hostname and link it into `config/tls/`
(git-ignored), with a renewal deploy-hook that re-links and restarts the daemon.

## Dependencies — do not "clean up" `redis`

`package.json` depends on `redis`, and **nothing in this repo imports it**. It looks dead.
It is not:

```
Error: Cannot find module 'redis'
Require stack:
- node_modules/imap-core/lib/redis-notifier/index.js
- node_modules/imap-core/index.js
```

`imap-core` requires `redis` unconditionally at module load but does not declare it as a
dependency, so our direct dep is what makes `require('imap-core')` resolve at all. Remove
it and the daemon dies on startup, at deploy time, in production.

The comment in `server.js` ("no redis server needed") is about the **process** — the
notifier is single-process and never dials a redis server. The **npm package** is still
mandatory. Those are different claims; conflating them breaks the edge.

`package-lock.json` is committed and installs use `npm ci`, so this stays pinned and
reproducible.

### The 3 high-severity `semver` advisories are accepted, not ignored

Every `npm ci` here reports them. Assessed 2026-07-27 — **not reachable**:

```
imap-core → utf7 → semver 5.3.0    ReDoS, GHSA-c2qf-rxjj-qqgw    "No fix available"
```

`utf7` calls semver exactly twice, both at module load:

```js
if (semver.gte(process.version, '6.0.0'))   // utf7.js:4 and :30
```

The only input is `process.version`, a constant supplied by Node. No IMAP client data ever
reaches the vulnerable regex, so there is no denial-of-service path. There is also no fix
to take: `utf7` pins `semver ~5.3.0`, and `utf7` is `imap-core`'s own dependency.

Re-assess if `imap-core` or `utf7` ever start passing untrusted strings to semver — but do
not "fix" this by force-resolving semver, which risks breaking `utf7`'s Node-version
branch for no security gain.

## Run

```sh
# local smoke (needs config/tls/ + env):
MAILKITE_API_URL=<your backend> MAILKITE_HMAC_SECRET=… IMAP_PORT=9993 npm start
```

## Test (after deploy + TLS)

```sh
# Apple Mail / Thunderbird: server imap.yourdomain.com, port 993, SSL/TLS,
# username = you@your-verified-domain.com, password = an IMAP app-password.
openssl s_client -quiet -connect imap.yourdomain.com:993
a LOGIN you@your-verified-domain.com <app-password>
b SELECT INBOX
c FETCH 1:* (FLAGS ENVELOPE)
```

The domain must be **MX-verified and not zero-retention** (passthrough). Create the
app-password in the dashboard or via `POST /api/imap/keys`.

## Abuse hardening

`fail2ban/` ships filter + jail configs for IMAP auth brute-force — see
[`../docs/self-hosting.md`](../docs/self-hosting.md) §6.
