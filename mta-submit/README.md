# mta-submit — SMTP submission edge (outbound relay)

Lets apps that only speak SMTP (WordPress, legacy CRMs, off-the-shelf SaaS with an SMTP
settings panel) send through your backend. A separate Haraka instance from the `:25` MX
edge (`mta/`) — **different trust model**: this one **requires AUTH over TLS** and relays
for the authenticated user; it never accepts inbound mail.

| | |
|---|---|
| Listens | `:587` (STARTTLS submission) + `:465` (implicit TLS / SMTPS) |
| Auth | SMTP AUTH PLAIN/LOGIN; **username** = anything (`mailkite` / `apikey`), **password** = an API key |
| Validates auth via | `POST /api/smtp/auth` (HMAC-Bearer) |
| Relays to | `POST /api/relay` (Bearer = the user's API key; raw RFC822 body) |

## How a send flows

```
app SMTP client → EHLO → STARTTLS → AUTH LOGIN (user / api key)
  auth_mailkite.check_plain_passwd → POST /api/smtp/auth {key}  → 235 (relaying=true) / 535
MAIL FROM / RCPT TO / DATA … QUIT
  mailkite_relay.hook_queue → POST /api/relay (Bearer key, raw MIME, x-mailkite-rcpt)
    backend: parse → same gates as the send API → sign → send
  2xx → 250 queued · 4xx → permanent reject · 5xx/net → tempfail (client retries)
```

The edge is a dumb SMTP→HTTP pipe; all parsing, gating, DKIM signing, logging and
metering live behind the backend contract.

## Layout

```
config/
  smtp.ini            listeners (:587 + :465), daemon_name
  me                  your submission hostname
  connection.ini      core connection sections (required in a custom config dir)
  tls.ini             TLS options (certs loaded from config/tls/)
  plugins             enabled plugins: tls, auth_mailkite, mailkite_relay
  mailkite.ini        api_url (+ relay_url); secrets come from env
  databytes           max message size (25 MB)
  dkim/               per-domain DKIM keys (git-ignored; see dkim/README.md)
plugins/
  auth_mailkite.js         SMTP AUTH → POST /api/smtp/auth (extends core auth_base)
  mailkite_relay.js        queue hook → Bearer POST raw MIME to /api/relay
  mailkite_http_inject.js  HTTP inject listener (backend → edge send path)
```

## Secrets & config (env, never on disk)

| Name | Purpose |
|---|---|
| `MAILKITE_HMAC_SECRET` | Must equal the backend's ingest secret. Bearer for `/api/smtp/auth`. |
| `MAILKITE_API_URL` | Base URL of the backend. |
| `MAILKITE_RELAY_URL` | Optional override; defaults to `MAILKITE_API_URL` + `/api/relay`. |

Set these in `/etc/mailkite/submit.env` (loaded by the systemd unit — see
[`../docs/self-hosting.md`](../docs/self-hosting.md)).

## TLS (required)

AUTH is only advertised on an encrypted session, so the cert is mandatory, not optional.
Provision a Let's Encrypt cert for your submission hostname and link it into
`config/tls/`:

```sh
sudo certbot certonly --standalone -d smtp.yourdomain.com
ln -sf /etc/letsencrypt/live/smtp.yourdomain.com/fullchain.pem config/tls/tls_cert.pem
ln -sf /etc/letsencrypt/live/smtp.yourdomain.com/privkey.pem   config/tls/tls_key.pem
```

`config/tls/` is git-ignored — TLS material is per-host and never committed.

## DKIM discipline

A DKIM mistake doesn't throw — it sends mail unsigned or under the wrong `d=`, and the
first symptom is a deliverability cliff. Before rolling out any change that touches
signing, stage the candidate beside the live plugin, sign the same message with both using
the real key, and compare byte for byte (RSA PKCS#1 v1.5 is deterministic, so any
difference is a behaviour change). `plugins/mailkite_http_inject.js` exposes a `/health`
endpoint reporting `PLUGIN_VERSION` and its DKIM mode — sweep your fleet after a deploy;
a version that doesn't match this repo means a box is running code nobody is reviewing.

## Test a send (after deploy + TLS)

```sh
swaks --server smtp.yourdomain.com:587 --tls \
  --auth LOGIN --auth-user mailkite --auth-password "$API_KEY" \
  --from you@your-verified-domain.com --to someone@example.com \
  --header "Subject: SMTP relay test" --body "hello via SMTP relay"
```

The key must belong to an account whose `from` domain passed **outbound (SPF+DKIM)**
verification — same gate as the send API.
