# MailKite Server docs

Every protocol head in this repo is stateless. Storage, policy, and routing live behind a
small HMAC-authenticated HTTP contract — implement it over any store and the MX,
submission, IMAP, and console run unchanged.

| Document | Read it when |
|---|---|
| [`contract.md`](./contract.md) | You are implementing a backend, or need the exact endpoint and signature rules |
| [`multi-backend.md`](./multi-backend.md) | One MX must serve several backends, one per recipient domain |
| [`self-hosting.md`](./self-hosting.md) | You are wiring DNS, TLS, and systemd on a VPS |
| [`routes.md`](./routes.md) | An address should POST to a webhook, forward, or run an agent |
| [`app-passwords.md`](./app-passwords.md) | You are issuing mailbox credentials for IMAP or API access |
| [`v1.md`](./v1.md) | You need the SDK-compatible send/read API |
| [`auth-setup.md`](./auth-setup.md) | You are claiming a fresh install's first admin account |

## The two boundaries

1. **Edge → backend.** The MX and submission edges are the only components that speak
   SMTP. They authenticate with a shared edge secret and hand accepted mail to the
   backend over HTTP.
2. **Backend → your application.** What happens after acceptance is the backend's
   business: store it, route it, POST a signed webhook, or run an agent
   ([`routes.md`](./routes.md)).

The MX handoff is where multi-backend routing applies: `config/backends.json` gives each
recipient domain exactly one owning backend, and the edge signs and delivers to that
owner only. Single-backend deployments need none of it — without the file, the edge
behaves exactly as before.
