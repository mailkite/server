# App passwords

**One credential model for mailbox access, shared by MailKite Cloud and MailKite Server.**
Supersedes "IMAP app-passwords" (server, scoped to one address) and the cloud dashboard's
domain-scoped IMAP passwords, which were two names for near-identical things with
incompatible scoping.

## The model

An **app password** grants access to the mailboxes matched by a
(`domain`, `address`) pair, over one or more protocols.

| Field | |
|---|---|
| `label` | human name ("support inbox agent") |
| `domain` | one hosted domain — chosen from a dropdown, never free text |
| `address` | local-part pattern within that domain (below) |
| `protocols` | `["imap"]`, `["api"]`, or both — at least one |
| `secret` | `mk_pw_…`, shown once, stored hashed (scrypt) |
| `created_at`, `last_used_at` | |

### Address patterns — the same matcher routes already use

| Pattern | Matches |
|---|---|
| `*` | every address on the domain (domain-scoped key) |
| `hello` | exactly `hello@domain` |
| `support-*` | `support-anything@domain` |
| `*-agent` | `anything-agent@domain` |

Matching is case-insensitive on the local part; the domain must match exactly. Reusing the
routes matcher is the point: one mental model for "which addresses does this apply to",
whether you're routing mail or granting access to it.

## Protocols

- **`imap`** — `LOGIN <full address> <key>` on the IMAP edge. The username must match the
  key's domain and address pattern, so one domain-scoped key serves every mailbox on it
  (a mail client per address, one credential to manage).
- **`api`** — `Authorization: Bearer <key>` on the mailbox REST routes, so an agent can
  read and manage its mail over plain HTTPS with no IMAP client:

  | Route | |
  |---|---|
  | `GET /api/mailbox/messages?address=&mailbox=&limit=&before=` | list (paged, newest first) |
  | `GET /api/mailbox/messages/:uid/raw?address=` | raw RFC822 |
  | `POST /api/mailbox/messages/:uid/flags` | `{address, flags}` |

  Every route requires `address` to be a concrete address the key matches; a key scoped
  `*` must still name which mailbox it is acting on.

## Auth semantics

- An **address-scoped password scopes the IMAP session too**: `/api/imap/auth` returns
  the matched address as `mailboxId`, and the edge echoes it on every read, so a
  `hello`-scoped password sees the same mail over IMAP as over the REST routes. A `*`
  password stays account-wide.
- Sign-in mode is decided by configuration, and it fails closed: with
  `MAILKITE_SEND_KEY` set, sign-in is *always* verified by emailed link — a delivery
  failure logs the link for box-level recovery but never issues a session, so an
  outage can't downgrade authentication to "knows the admin address". Without a send
  key the operator has explicitly chosen a server that cannot verify by mail, and a
  known admin signs in directly.
- App passwords are **user-trust** credentials (like API keys), never edge-trust. The IMAP edge
  keeps calling `POST /api/imap/auth` (HMAC) — the backend now resolves the username
  against app passwords and answers with the matched account/mailbox.
- A password that lacks a protocol is refused on that protocol, with the failure logged and
  counted by the same per-IP lockout as before.
- App passwords are never full API keys: they cannot manage domains, mint credentials, or send
  outside their matched addresses.

## Migration

Existing address-scoped app passwords (`mk_imap_…`) gain
`address = <their local part>`, `protocols = ["imap"]` — behavior unchanged.
**`mk_imap_` secrets keep working indefinitely**; new ones are issued as `mk_pw_…`
(universal, since these are no longer IMAP-only). Cloud's domain-scoped IMAP
passwords map to `address = "*"`.

Both implementations expose the same shape, so the web console and the cloud dashboard
can present one screen — "App passwords: domain dropdown, address pattern, protocol
toggles" — and mean the same thing.
