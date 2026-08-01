# The backend contract

Every edge in this repo (MX, submission, IMAP) is a stateless protocol head. All state and
policy live behind the HTTP endpoints below. Implement them over any store and every edge
works unchanged — `backend-local/` (SQLite) and [MailKite Cloud](https://mailkite.dev) are
two implementations of the same contract.

**Versioning:** this document is the contract. Backwards-incompatible changes bump the
repo's major version; additive fields are allowed at any time (clients must ignore unknown
fields).

## Authentication

Two schemes, mirroring the two trust models:

- **Edge trust (HMAC secret):** the shared secret (`MAILKITE_HMAC_SECRET` on the edges)
  proves the caller *is* a trusted edge. Sent as `Authorization: Bearer <secret>` — except
  ingest, which uses a signature over the body (see below). Edge-trusted endpoints accept
  identity fields (e.g. `userId`) at face value, because the edge already authenticated
  the end user.
- **User trust (API key / app-password):** `/api/relay` authenticates the *user* with
  their API key as Bearer; `/api/imap/auth` verifies a scoped app-password.

All request/response bodies are JSON unless noted. Non-2xx errors should carry
`{"error": "<human message>", "code": "<machine_code>"}` when a body is present.

---

## Inbound

### `POST /api/ingest` — accept a raw inbound message

Called by `mta/plugins/mailkite_ingest.js` on Haraka's queue hook.

- **Body:** raw RFC822 bytes (`Content-Type: message/rfc822`).
- **Headers:**
  - `x-mailkite-signature: t=<unix-seconds>,v1=<hex>` where
    `<hex> = HMAC-SHA256(secret, "<t>." ‖ raw-body)`. Reject if the signature fails or
    `t` is outside a small clock-drift window (the reference backend uses ±5 minutes).
  - `x-mailkite-rcpt`: comma-separated envelope RCPT TO addresses.
  - `x-mailkite-mailfrom`: envelope MAIL FROM.
  - Optional edge verdicts: `x-mailkite-spf`, `x-mailkite-dkim`, `x-mailkite-dmarc`
    (pass/fail/none…), `x-mailkite-spam` (numeric score), `x-mailkite-spam-verdict`.
- **Responses:** any **2xx** = accepted (the edge tells the sender 250). Any non-2xx or
  network error = the edge tempfails (DENYSOFT) and the sender retries — so a backend
  outage delays mail, never loses it. Do **not** return 4xx for per-recipient problems;
  recipient acceptance already happened at RCPT time (below).

### `GET /api/mx/accepted-domains` — anti-open-relay list

Called by `mta/plugins/mailkite_rcpt.js` (live, cached ~30 s) and
`mta/scripts/sync-host-list.mjs` (boot-time seed).

- **Auth:** `Bearer <hmac secret>`.
- **Response:** `{"domains": ["example.com", ...]}` — every domain the backend will
  accept inbound mail for. The edge DENYs RCPTs outside this set.

---

## Outbound

### `POST /api/smtp/auth` — validate an SMTP AUTH credential

Called by `mta-submit/plugins/auth_mailkite.js`.

- **Auth:** `Bearer <hmac secret>` (proves the caller is the edge).
- **Body:** `{"key": "<the user's API key>"}`.
- **Response:** `200 {"ok": true, "userId": "<id>"}` on success;
  `{"ok": false}` (or non-2xx) → the edge answers 535.

### `POST /api/relay` — send a raw outbound message

Called by `mta-submit/plugins/mailkite_relay.js` after successful AUTH.

- **Auth:** `Bearer <the user's API key>` (user trust, not edge trust).
- **Body:** raw RFC822 bytes (`Content-Type: message/rfc822`).
- **Headers:** `x-mailkite-rcpt`: full envelope recipient list, comma-separated
  (recipients not in To/Cc are Bcc).
- **Responses (the edge maps these to SMTP):**
  - **2xx** → `250 queued`.
  - **4xx** → permanent SMTP reject (bad From-domain, suppressed recipient, bad MIME) —
    include `{"error": ...}` so the client sees why.
  - **5xx / network** → tempfail; the client retries.
- **Semantics:** parse the MIME, enforce the same gates as the normal send API
  (From-domain verified, quotas), sign (DKIM) and deliver, and record the message in the
  account's **Sent** mailbox so it is visible over IMAP.

---

## IMAP read API

All five endpoints are **edge-trusted**: `Authorization: Bearer <hmac secret>`, JSON
bodies. `mailbox` is `"INBOX"` or `"Sent"` (v1). `mailboxId` scopes a session to one
mailbox address; `null` = account-wide.

### `POST /api/imap/auth`

- **Body:** `{"username": "<mailbox address>", "password": "<app-password>", "ip": "<client ip>"}`.
  The `ip` is for backend-side brute-force lockout (lock the IP, not the username — no
  victim DoS).
- **Response:** `200 {"ok": true, "userId": ..., "domain": ..., "mailboxId": <id|null>}`;
  failure → `{"ok": false, "code": "bad_credentials"}` or non-2xx.
- App-passwords are scoped credentials, never full API keys. Domains without retention
  (passthrough) must fail auth.

### `POST /api/imap/status`

- **Body:** `{"userId", "mailboxId", "mailbox"}`.
- **Response:** `{"total": n, "unseen": n, "uidvalidity": n, "uidnext": n}`.
  `uidvalidity` must be stable for the life of the mailbox; if the mailbox is ever
  rebuilt, it must change.

### `POST /api/imap/list`

- **Body:** `{"userId", "mailboxId", "mailbox"}`.
- **Response:** `{"messages": [{"uid": n, "flags": "Seen Flagged", "internaldate": "<ISO-8601>", "from_addr": ..., "to_addr": ..., "subject": ...}, ...]}`
  ordered by uid ascending. `flags` is space-separated **without** the IMAP backslashes
  (`"Seen"`, not `"\\Seen"`); the edge converts.

### `POST /api/imap/raw`

- **Body:** `{"userId", "mailboxId", "mailbox", "uid"}`.
- **Response:** `200` with the stored raw RFC822 bytes. Non-2xx when raw is unavailable
  (e.g. a message stored before raw retention) — the edge synthesizes a minimal header
  envelope from the `list` fields instead.

### `POST /api/imap/flags`

- **Body:** `{"userId", "mailboxId", "mailbox", "uid", "flags": "Seen Flagged"}` —
  full replacement set, same backslash-less encoding.
- **Response:** any 2xx.

### `POST /api/imap/keys` *(optional, dashboard/CLI surface)*

Create an app-password for a mailbox address. Not called by any edge; backends may expose
it however suits them (the reference backend uses its CLI instead).

---

## Conformance

`backend-local/test/contract.test.mjs` is the executable form of this document. Run it
against any backend with:

```sh
BACKEND_URL=http://localhost:8787 HMAC_SECRET=... node --test backend-local/test/
```
