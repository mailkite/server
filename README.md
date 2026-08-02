# MailKite Server

**An open-source, programmable mail server for apps and AI agents.**
Haraka-based SMTP (MX + submission) and a thin IMAP head, designed around one small HTTP
backend contract — run it fully self-hosted, or point the same components at
[MailKite Cloud](https://mailkite.dev) and skip the ops.

> Status: **pre-release.** The SMTP/IMAP edges here run in production at MailKite, and
> the reference backend passes the conformance + end-to-end suites; the UI (`ui/`) lands
> next. Watch releases for v0.1.0.

## What's in the box

| Component | What it is |
|---|---|
| [`mta/`](mta/) | Inbound MX edge — [Haraka](https://haraka.github.io/) + plugins that POST accepted mail to your backend as a webhook, with live anti-open-relay recipient checks |
| [`mta-submit/`](mta-submit/) | Submission edge (587/465) — authenticated send with DKIM signing, relayed through your backend |
| [`imap/`](imap/) | IMAP4 head (993, implicit TLS) — a stateless protocol daemon on `imap-core`; all storage lives behind the backend contract |
| [`api-local/`](api-local/) | Reference REST API: Node + SQLite + file blobs implementing the contract below — zero npm dependencies. Inbound webhooks with signing + retries, and smarthost outbound (`SMARTHOST=cloud` or any SMTP relay) |
| [`ui/`](ui/) | Web console for domains, DNS records, message log, webhooks, and credentials — magic-link sign-in, pluggable providers (local or MailKite Cloud) |

## The backend contract

Every component is a dumb protocol head. State lives behind a handful of HMAC-authenticated
HTTP endpoints (`/api/imap/{auth,status,list,flags,raw}`, an inbound ingest hook, and a
submission inject endpoint). Implement that contract over any store and every edge here
works unchanged — the reference SQLite backend and MailKite Cloud are just two
implementations of it. One MX edge can even serve **several backends at once**, routing
each recipient domain to its owner — see [`docs/multi-backend.md`](docs/multi-backend.md).
See [`docs/contract.md`](docs/contract.md); the conformance suite
in `api-local/test/` is its executable form, and `scripts/e2e-imap.mjs` proves the
full stack (signed ingest → backend → the real IMAP daemon → a TLS IMAP client).

## Self-hosting

**Runs on any Node ≥ 22.5 host** — VPS (systemd), Docker, Fly.io, Railway. Serverless
(Workers/Vercel) is intentionally out of scope: those runtimes can't hold SQLite state or
raw-TCP mail ports, and the hosted backend for that style is MailKite Cloud.

- Quick start: `docker compose up -d` → backend + web console on `:8787`
  ([`compose.yaml`](compose.yaml); `--profile edges` adds the MX edge)
- Hosted: [`deploy/fly.md`](deploy/fly.md) · [`deploy/railway.md`](deploy/railway.md)
- Bare VPS (full mail stack incl. IMAP/submission): [`docs/self-hosting.md`](docs/self-hosting.md)
  — DNS records, TLS provisioning, and systemd units. Short version: one VPS, three
  daemons, your backend URL in one env var.

Don't want to run mail infrastructure? [MailKite Cloud](https://mailkite.dev) is the hosted
backend + dashboard, with deliverability, retention, and support handled for you.

## License

Code is licensed under **AGPL-3.0-only** — see [`LICENSE`](LICENSE).
The **MailKite name and logo are not covered by the code license**; see
[`TRADEMARK.md`](TRADEMARK.md) and [`brand-assets/`](brand-assets/). Forks must use their
own name and branding.

Contributions require a signed CLA — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
