# haraka-plugin-mailkite

Connect an **existing Haraka install** to a MailKite-contract backend —
[MailKite Cloud](https://mailkite.dev) or a self-hosted
[`api-local`](https://github.com/mailkite/server/tree/main/api-local) — without adopting
the whole [mailkite/server](https://github.com/mailkite/server) repo.

- **MX role:** inbound mail is POSTed to your backend as an HMAC-signed webhook
  (raw RFC822 + envelope + SPF/DKIM/spam verdict headers), with live anti-open-relay
  recipient checks against the backend's accepted-domains list.
- **Submission role:** SMTP AUTH validated against the backend (API key = password),
  authenticated mail relayed through the backend's send pipeline.
- Backend interface: [the contract](https://github.com/mailkite/server/blob/main/docs/contract.md).

## Install

```sh
cd /path/to/your/haraka   # the directory holding config/
npm install haraka-plugin-mailkite
echo mailkite >> config/plugins
```

MX and submission belong on **separate Haraka instances** (different trust models) —
install the package in each and set the role per instance.

## Configure — `config/mailkite.ini`

```ini
[main]
role = mx                                   ; or: submit
api_url = https://api.mailkite.dev          ; your backend base URL
ingest_url = https://api.mailkite.dev/api/ingest   ; mx role only
; hmac_secret is read from env MAILKITE_HMAC_SECRET — never put it on disk
```

Env (preferred over ini for anything secret):

| Var | Role | Purpose |
|---|---|---|
| `MAILKITE_HMAC_SECRET` | both | shared edge secret (signs ingest, authenticates edge calls) |
| `MAILKITE_API_URL` | both | backend base URL |
| `MAILKITE_INGEST_URL` | mx | ingest endpoint override |
| `MAILKITE_RELAY_URL` | submit | relay endpoint override |

For the MX role, keep `rcpt_to.host_list` **out** of `config/plugins` — this plugin's
live backend check replaces it. For the submission role, TLS is required (AUTH is only
advertised on encrypted sessions).

## Multiple backends on one MX

Drop a `config/backends.json` and one Haraka MX serves several backends at once — each
recipient domain routed to the backend that claims it (order = priority):

```json
{
  "backends": [
    { "name": "cloud", "url": "https://api.mailkite.dev",  "secretEnv": "MAILKITE_HMAC_SECRET" },
    { "name": "mine",  "url": "https://mail.example.com",  "secretEnv": "MY_BACKEND_SECRET" }
  ]
}
```

Semantics: [docs/multi-backend.md](https://github.com/mailkite/server/blob/main/docs/multi-backend.md).

## Provenance

`plugins/` and `lib/` are verbatim copies of the canonical sources in
[mailkite/server](https://github.com/mailkite/server) (`mta/`, `mta-submit/`) — the same
code running MailKite's production MX. `scripts/sync.mjs --check` (run by `npm test` and
`prepack`) fails the build if they ever drift. File issues against the canonical repo.

## License

AGPL-3.0-only. The MailKite name and logo are trademarks — see the repo's
[TRADEMARK.md](https://github.com/mailkite/server/blob/main/TRADEMARK.md).
