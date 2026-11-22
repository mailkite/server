# Self-hosting MailKite Server

One VPS, three daemons, one backend URL. This guide covers the generic setup; each
component README has the component-specific detail.

> **Pre-release note:** until `api-local/` ships, the backend contract is only
> implemented by MailKite Cloud — so today "self-hosted" means running the edges against
> a cloud account. Fully-local operation lands with v0.1.0.

## 1. DNS

For a sending/receiving domain `yourdomain.com` served by host `mx.example.com`:

| Record | Name | Value | Purpose |
|---|---|---|---|
| A/AAAA | `mx.example.com` | your VPS IP | the edge host |
| MX | `yourdomain.com` | `mx.example.com` | inbound mail |
| TXT (SPF) | `yourdomain.com` | `v=spf1 a:mx.example.com -all` | outbound auth |
| TXT (DKIM) | `<selector>._domainkey.yourdomain.com` | your DKIM public key | outbound signing (see `mta-submit/config/dkim/`) |
| TXT (DMARC) | `_dmarc.yourdomain.com` | `v=DMARC1; p=quarantine; rua=mailto:you@yourdomain.com` | policy + reports |
| A | `imap.example.com` | your VPS IP | IMAP endpoint |

Also set PTR (reverse DNS) on the VPS IP to `mx.example.com` — most providers do this in
their control panel, and outbound deliverability suffers badly without it.

## 2. Hostname configs

- `mta/config/me` → your MX hostname (`mx.example.com`)
- `mta-submit/config/me` → your submission hostname
- `mta/config/host_list` → domains you accept mail for (seed; synced from the backend at
  boot by `mta/scripts/sync-host-list.mjs`)

## 3. Environment

Each daemon reads its secrets from the environment only — nothing secret lives on disk.

| Variable | Used by | Purpose |
|---|---|---|
| `MAILKITE_API_URL` | all | base URL of your backend (local backend or `https://api.mailkite.dev`) |
| `MAILKITE_HMAC_SECRET` | all | shared secret for backend calls (Bearer/HMAC) |
| `SMARTHOST` + credential | api-local | where external mail leaves: `cloud` (+ `MAILKITE_SEND_KEY`), `ses` (+ `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY`), or `smtp[s]://…`. See [`api-local/README.md`](../api-local/README.md) § Outbound |
| `IMAP_PORT` / `IMAP_HOST` | imap | defaults `993` / `::` |
| `TLS_CERT` / `TLS_KEY` | imap | PEM paths |

Put them in `/etc/mailkite/<component>.env` and reference from the systemd units.

## Outbound (sending)

Receiving needs the MX edge; sending to the outside world needs a smarthost. It is one
variable with three options — the full matrix is in
[`api-local/README.md`](../api-local/README.md) § Outbound.

| `SMARTHOST` | Credential | What it does |
|---|---|---|
| `cloud` | `MAILKITE_SEND_KEY=mk_live_…` | hands the message to MailKite Cloud, which sends with managed IP reputation |
| `ses` · `ses://<region>` | `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY` | calls Amazon SES `SendRawEmail`, signed with your ordinary AWS access key pair over HTTPS 443 |
| `smtp[s]://user:pass@host:port` | in the URL | relays through any SMTP server that accepts AUTH over TLS |

SES is the option for a box that already pays AWS — and for a host that blocks outbound
SMTP (Railway, most serverless platforms): the request is HTTPS 443, there is no derived
SMTP username/password to generate, and nothing else to install. Three things stay yours:

1. **Verify the From domain (or address) in SES and enable Easy DKIM.** This backend does
   not DKIM-sign; without Easy DKIM the message goes out unsigned or under
   `d=amazonses.com` and fails alignment at the receiver.
2. **Leave the SES sandbox**, or only verified recipients receive mail.
3. **Grant the IAM user `ses:SendRawEmail`** and nothing more.

```sh
# /etc/mailkite/api-local.env
SMARTHOST=ses
SES_ACCESS_KEY_ID=AKIA…
SES_SECRET_ACCESS_KEY=…
SES_REGION=us-east-1          # or use SMARTHOST=ses://eu-west-1
```

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` work as fallbacks, so a
machine that already has AWS credentials in its environment needs only `SMARTHOST=ses`.
A bad configuration is reported at boot and outbound stays disabled rather than failing
message by message.

Design record, semantics and the SES error → fix table: [`ses-outbound.md`](ses-outbound.md).

## 4. TLS

Provision Let's Encrypt certs for your MX, submission, and IMAP hostnames (certbot
standalone or DNS-01), then link them into each component's `config/tls/`. Add a
renewal deploy-hook that re-links and restarts the daemons.

## 5. systemd

One unit per daemon (`mailkite-mta`, `mailkite-submit`, `mailkite-imap`):

```ini
[Unit]
Description=MailKite %i edge
After=network-online.target

[Service]
EnvironmentFile=/etc/mailkite/%i.env
WorkingDirectory=/opt/mailkite-server/%i
ExecStart=/usr/bin/node server.js
Restart=always
User=mailkite
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

(Haraka components start via `npx haraka -c .` rather than `node server.js` — see their
READMEs.)

## 6. Abuse hardening

`imap/fail2ban/` ships filter + jail configs for IMAP auth brute-force; adapt paths and
enable via `fail2ban-client`. Rate limits and connection caps for the SMTP edges are in
each `config/connection.ini` / `config/smtp.ini`.
