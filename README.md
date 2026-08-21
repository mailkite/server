# MailKite Server

**An open-source, programmable mail server for apps and AI agents.**
Haraka-based SMTP (MX + submission) and a thin IMAP head, designed around one small HTTP
backend contract — run it fully self-hosted, or point the same components at
[MailKite Cloud](https://mailkite.dev) and skip the ops.

> Status: **pre-1.0.** The SMTP/IMAP edges here run MailKite's production mail; the
> reference SQLite backend and web console are new (first public release 2026-08-01,
> now v0.5.0) and pass the conformance + end-to-end suites.

## What's in the box

| Component | What it is |
|---|---|
| [`mta/`](mta/) | Inbound MX edge — [Haraka](https://haraka.github.io/) + plugins that POST accepted mail to your backend as a webhook, with live anti-open-relay recipient checks |
| [`mta-submit/`](mta-submit/) | Submission edge (587/465) — authenticated send with DKIM signing, relayed through your backend |
| [`imap/`](imap/) | IMAP4 head (993, implicit TLS) — a stateless protocol daemon on `imap-core`; all storage lives behind the backend contract |
| [`api-local/`](api-local/) | Reference REST API: Node + SQLite + file blobs implementing the contract below — zero npm dependencies. Inbound webhooks with signing + retries, [routes](docs/routes.md), smarthost outbound (`SMARTHOST=cloud` or any SMTP relay), and the [developer API](docs/v1.md) — the same `POST /v1/send` + `GET /api/messages` JSON surface as MailKite Cloud, so SDKs point at your server instead of `api.mailkite.dev` |
| [`ui/`](ui/) | Web console for domains, DNS records, message log, routes, webhooks, and credentials — magic-link sign-in, pluggable providers (local or MailKite Cloud) |

### Routes — do something with the mail

Past "store it and expose it over IMAP", an address can carry a rule
([`docs/routes.md`](docs/routes.md)): POST it to a **webhook**, **forward** it somewhere, or
hand it to an **AI agent** that replies or escalates. Matching fans out, so one message can
do all three.

Agent routes are **bring-your-own-key** — Anthropic, Gemini, OpenAI, OpenRouter, Groq,
Mistral, Together, xAI, DeepSeek, or any OpenAI-compatible endpoint including a local
Ollama/vLLM. Your key is encrypted at rest and only ever leaves for the provider you named;
no dependency and no MailKite account is involved. The agent runs deliberately
narrow — it can reply to the sender or forward to an address **you** nominated, and nothing
else — because the mail it reads is attacker-controlled input. See
[`docs/routes.md` §5](docs/routes.md) for the threat model and the one known gap (no
per-route rate cap yet).

## The backend contract

Every component is a dumb protocol head. State lives behind a handful of HMAC-authenticated
HTTP endpoints (`/api/imap/{auth,status,list,flags,raw}`, an inbound ingest hook, and a
submission inject endpoint). Implement that contract over any store and every edge here
works unchanged — the reference SQLite backend and MailKite Cloud are just two
implementations of it. One MX edge can even serve **several backends at once**, routing
each recipient domain to its owner — see [`docs/multi-backend.md`](docs/multi-backend.md).
See [`docs/contract.md`](docs/contract.md) and [`docs/app-passwords.md`](docs/app-passwords.md)
(mailbox credentials: one domain, an address pattern, IMAP and/or API access); the conformance suite
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
