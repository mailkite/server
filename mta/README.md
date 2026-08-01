# mta — MX edge (Haraka SMTP→HTTP relay)

The inbound mail server. Accepts SMTP on `:25` for your MX hostname, then POSTs each raw
message (HMAC-signed) to the backend's `POST /api/ingest`, which runs the
parse → store → route → webhook pipeline. All real logic lives behind the backend
contract; this edge is a **dumb pipe** — which is what makes it portable across backends
(the reference local backend or MailKite Cloud).

## Layout

```
mta/
  Dockerfile            Node 22 + Haraka image
  fly.toml              example Fly.io deployment (one MX host)
  package.json          Haraka dependency
  config/
    smtp.ini            listen :25, daemon name
    plugins             enabled plugins (rcpt_to.host_list, tls, mailkite_ingest)
    host_list           accepted recipient domains (synced from the backend)
    me                  your MX hostname
    databytes           max message size (25 MB)
    mailkite.ini        ingest_url + timeout (secret comes from env)
  plugins/
    mailkite_ingest.js  the queue hook → HMAC POST to /api/ingest
    mailkite_rcpt.js    live anti-open-relay RCPT check against the backend
  scripts/
    sync-host-list.mjs  pull verified domains → host_list (anti-open-relay)
    entrypoint.sh       sync then run Haraka
```

## Local dev

```sh
cd mta
npm install
# Point ingest at your backend and set the shared secret.
MAILKITE_INGEST_URL=http://localhost:8787/api/ingest \
MAILKITE_HMAC_SECRET=dev-ingest-secret-change-me \
  npm run dev

# In another terminal, send a test message (brew install swaks):
swaks --to test@example.com --server localhost:25 --data $'Subject: hi\n\nbody'
```

Add the recipient's domain to `config/host_list` (e.g. `example.com`) or the edge rejects
RCPT. Set the same secret on the backend side. Expect a `250` at the edge, a
`POST /api/ingest`, and a stored message + webhook delivery on the backend.

## Deploy

See [`../docs/self-hosting.md`](../docs/self-hosting.md) for the VPS + systemd setup. The
non-negotiables for any host:

- **Port 25 must be open** (many clouds block it by default — request an unblock).
- **A dedicated IP with PTR (reverse DNS)** set to your MX hostname.
- `fly.toml` documents the Fly.io variant: allocate a **dedicated** IPv4 (`fly ips
  allocate-v4`, not `--shared`) and set rDNS in the dashboard before pointing MX records.

## TLS / STARTTLS

Senders expect STARTTLS on an MX. The `tls` plugin is enabled in `config/plugins`,
configured by `config/tls.ini`, and reads `config/tls/tls_cert.pem` +
`config/tls/tls_key.pem` (git-ignored, provisioned per host — Let's Encrypt works fine;
prefer DNS-01 so nothing needs port 80 and renewals don't require downtime). Add a certbot
`--deploy-hook` that re-copies the cert into `config/tls/` and restarts the daemon.

## Secrets & config

| Name | Where | Purpose |
|---|---|---|
| `MAILKITE_HMAC_SECRET` | env | Signs ingest POSTs; must equal the backend's ingest secret. Also Bearer for host_list sync. |
| `MAILKITE_INGEST_URL` | env | Backend ingest endpoint. |
| `MAILKITE_API_URL` | env | Base URL for the host_list sync + RCPT checks. |
| `MAILKITE_INGEST_TIMEOUT_MS` | env (optional) | Ingest POST timeout (default 10000). |

Secrets are read from the environment only and never written to disk or the image.

## Deps / `package-lock.json`

The lockfile is committed so deployed trees are reproducible (`npm ci`). Haraka is pinned
deliberately; do not regenerate the lockfile or run `npm audit fix` casually — `npm audit
fix` is known to strip `asn1.js` while leaving `@haraka/ocsp` in place, which throws
`Cannot find module 'asn1.js'` the moment OCSP loads. Verify any lockfile change with a
throwaway `npm ci` and confirm `node_modules/@haraka/ocsp` resolves `asn1.js`.
