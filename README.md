# MailKite Server

**An open-source, programmable mail server for apps and AI agents.**
Haraka SMTP (MX + submission) and a thin IMAP head, wrapped around one small HTTP backend
contract. Run the whole thing on your own box.

![One core — the backend contract — with three protocol heads around it: an inbound MX intake, a reading slot, an outbound emitter](brand-assets/readme-hero.png)

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-6ea8fe)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-7c6cff)](https://nodejs.org)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-f5b544)](#status)
[![CI](https://github.com/mailkite/server/actions/workflows/ci.yml/badge.svg)](https://github.com/mailkite/server/actions/workflows/ci.yml)

## Run it

```sh
git clone https://github.com/mailkite/server && cd server
cp .env.example .env          # then set HMAC_SECRET: openssl rand -hex 32
docker compose up -d          # backend + web console on http://localhost:8787
```

That is the whole install: a Node + SQLite backend, a React console, and a bearer-token API
on `POST /v1/send` / `GET /api/messages`. No account, no key, no cloud dependency.

Add the SMTP edge when you want inbound mail — this is the part that needs a public IP,
port 25, a PTR record and TLS material:

```sh
docker compose --profile edges up    # + Haraka MX on :25
```

Prebuilt images publish to `ghcr.io/mailkite/server` from the release tags, so you can skip
the build entirely:

```sh
docker run -d -p 8787:8787 -e HMAC_SECRET=$(openssl rand -hex 32) \
  -v mail-data:/data ghcr.io/mailkite/server:v0.5.0
```

Point an existing Resend-style SDK at your own base URL and it works unchanged.

## Or hand it to an agent

The repo ships a setup skill — the same runbook, written for a coding agent. Paste this
into Claude Code, Codex, Cursor, or any agent with shell access:

> Read https://raw.githubusercontent.com/mailkite/server/main/skills/mailkite-server-setup/SKILL.md
> and set up MailKite Server on this machine. Ask me for the domain and who controls DNS
> before changing anything, then tell me which outbound path you picked and why.

It walks the agent through the stack, DNS and domain verification, inbound, and choosing
an outbound path — Amazon SES, MailKite Cloud, or any SMTP relay. Source:
[`skills/mailkite-server-setup/SKILL.md`](skills/mailkite-server-setup/SKILL.md).

## What's in the box

| Component | What it is |
|---|---|
| [`mta/`](mta/) | Inbound MX edge — [Haraka](https://haraka.github.io/) + plugins that POST accepted mail to your backend as a webhook, with live anti-open-relay recipient checks |
| [`mta-submit/`](mta-submit/) | Submission edge (587/465) — authenticated send with DKIM signing, relayed through your backend |
| [`imap/`](imap/) | IMAP4 head (993, implicit TLS) — a stateless protocol daemon on `imap-core`; all storage lives behind the backend contract |
| [`api-local/`](api-local/) | Reference REST API: Node + SQLite + file blobs implementing the contract below — zero npm dependencies. Inbound webhooks with signing + retries, [routes](docs/routes.md), smarthost outbound (MailKite Cloud, [Amazon SES by API key](docs/ses-outbound.md), or any SMTP relay), and the [developer API](docs/v1.md) |
| [`ui/`](ui/) | Web console for domains, DNS records, message log, routes, webhooks, and credentials — magic-link sign-in, pluggable providers |

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
works unchanged — the reference SQLite backend is just the default implementation of it.
One MX edge can even serve **several backends at once**, routing each recipient domain to
its owner — see [`docs/multi-backend.md`](docs/multi-backend.md).
Opt in with `config/backends.json` (example: `mta/config/backends.example.json`); without
it the edge is single-backend.

See [`docs/contract.md`](docs/contract.md) and [`docs/app-passwords.md`](docs/app-passwords.md)
(mailbox credentials: one domain, an address pattern, IMAP and/or API access); the
conformance suite in `api-local/test/` is its executable form, and `scripts/e2e-imap.mjs`
proves the full stack (signed ingest → backend → the real IMAP daemon → a TLS IMAP client).

## Deploying

**Runs on any Node ≥ 22.5 host** — VPS (systemd), Docker, Fly.io, Railway. Serverless
(Workers/Vercel) is intentionally out of scope: those runtimes can't hold SQLite state or
raw-TCP mail ports.

- Docker: [`compose.yaml`](compose.yaml) — `docker compose up -d`; `--profile edges` adds the MX edge
- Fly.io: [`deploy/fly.md`](deploy/fly.md) · Railway: [`deploy/railway.md`](deploy/railway.md)
- Bare VPS (full mail stack incl. IMAP/submission): [`docs/self-hosting.md`](docs/self-hosting.md)
  — DNS records, TLS provisioning, and systemd units. Short version: one VPS, three
  daemons, your backend URL in one env var.

## Documentation

| Doc | Read it when |
|---|---|
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running the full stack on a VPS — DNS, TLS, systemd |
| [`docs/contract.md`](docs/contract.md) | Writing your own backend instead of using `api-local` |
| [`docs/routes.md`](docs/routes.md) | Wiring webhook, forward, or AI-agent rules to an address |
| [`docs/v1.md`](docs/v1.md) | Calling the developer API (`POST /v1/send`) |
| [`docs/multi-backend.md`](docs/multi-backend.md) | One MX serving several backends, one per domain |
| [`docs/app-passwords.md`](docs/app-passwords.md) | Mailbox credentials for IMAP and API access |
| [`docs/auth-setup.md`](docs/auth-setup.md) | Magic-link sign-in and OAuth for the console |

## Status

**Pre-1.0, and deliberately honest about it.** The SMTP and IMAP edges here carry MailKite's
production mail; the reference SQLite backend and web console are newer (first public
release 2026-08-01, now v0.5.0) and pass the conformance + end-to-end suites in CI. Where a
piece is unproven, [`docs/`](docs/) says so rather than implying otherwise. The contract is
the stable part; the reference backend is the part still settling.

## Hosted alternative

If you would rather not run mail infrastructure — DNS, PTR, TLS renewal, deliverability,
retention — [MailKite Cloud](https://mailkite.dev) is the hosted backend and dashboard. It
consumes this same repository as a pinned submodule, so self-hosted and hosted stay in
lockstep. It is an option, not a dependency: nothing here requires an account.

## License

Code is licensed under **AGPL-3.0-only** — see [`LICENSE`](LICENSE).
The **MailKite name and logo are not covered by the code license**; see
[`TRADEMARK.md`](TRADEMARK.md) and [`brand-assets/`](brand-assets/). Forks must use their
own name and branding.

Contributions require a signed CLA — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
