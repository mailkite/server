# Self-hosting MailKite Server

One VPS, three daemons, one backend URL. This guide covers the generic setup; each
component README has the component-specific detail.

> **Pre-release note:** until `backend-local/` ships, the backend contract is only
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
| `IMAP_PORT` / `IMAP_HOST` | imap | defaults `993` / `::` |
| `TLS_CERT` / `TLS_KEY` | imap | PEM paths |

Put them in `/etc/mailkite/<component>.env` and reference from the systemd units.

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
