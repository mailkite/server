---
name: mailkite-server-setup
description: "Set up a self-hosted MailKite Server end to end, on this machine or on a remote host over SSH: backend + web console, DNS and domain verification, optional inbound MX and IMAP edges, and an outbound path through Amazon SES, MailKite Cloud, or any SMTP relay. Use when the user asks to install, self-host, run, or migrate to MailKite Server, on a chosen target machine."
version: 1.0.0
author: mailkite
license: AGPL-3.0-only
tags:
  - mailkite
  - self-hosting
  - email
  - smtp
  - imap
  - ses
  - ssh
---

# Set up MailKite Server

You are installing an open-source mail server for applications: a Node + SQLite backend,
a web console, and optional SMTP/IMAP edges. Receiving runs on the target machine.
Sending is a plugin — Amazon SES, MailKite Cloud, or any SMTP relay — because outbound
deliverability depends on IP reputation, not code.

**The target is not assumed.** It may be the machine you are running on, or a remote host
you reach over SSH. Confirm which one before touching anything.

Read `docs/self-hosting.md` and `api-local/README.md` in the repo when a detail here is
not enough. This skill is the runbook; those files are the reference.

## Ground rules

1. **Ask before assuming.** You need: the **target machine** (this host or an SSH target),
   the domain (or `*.mailk.us` subdomain), who controls DNS, whether mail must be
   *received* on the target, and how outbound should leave (SES / Cloud / relay). Do not
   invent a domain, key, credential, or host.
2. **Never print secrets.** Generate `HMAC_SECRET`, API keys and passwords, write them to
   the env file on the target, and refer to them by name afterwards.
3. **Do not touch DNS without confirmation.** Print the exact records and let the user
   apply them, unless they have given you API access on purpose.
4. **A running container is not a working mail server.** Do not claim success until a real
   message has been received and a real message has been sent.
5. **Do not open port 25 on a host that blocks it.** Use the hosted MX or a relay instead
   (steps 5 and 6).

## 0. Pick the target machine

Ask which machine MailKite Server should run on. It does not have to be the machine you
are running on.

- **This machine** — run the commands directly, check prerequisites locally.
- **A remote host over SSH** — run the same commands through `ssh <user>@<host>`, and check
  the prerequisites (Node ≥ 22.5 or Docker) on the target, not on your own machine.

If the target is remote:

- Keep secrets out of the local shell and history. Create the env file on the target, e.g.
  `ssh <host> 'umask 077; cat > /etc/mailkite/api-local.env' <<'EOF' … EOF`; never echo the
  values back into the conversation.
- Reach the console through a tunnel: `ssh -L 8787:127.0.0.1:8787 <user>@<host>`, then open
  `http://127.0.0.1:8787` locally.
- DNS belongs to the user's provider either way; SSH does not change who applies the
  records.
- Verify from both ends: `curl` on the target, then a real message from an outside mailbox.
- Do not overwrite an existing remote `data/` directory. If one exists, stop and ask; back
  it up before any migration.

## 1. Check the host

On the **target machine**:

```sh
node -v            # need >= 22.5, or use Docker
docker --version   # either is fine
```

Ask whether the target can accept inbound SMTP on port 25. Most home ISPs and several
clouds block it; if it is blocked, skip the local MX edge and use the hosted MX (step 5b).
PTR/reverse DNS for the edge hostname is set at the hosting provider.

Outbound: **do not plan on direct delivery from a VPS.** Pick SES now (recommended, HTTPS
on 443), MailKite Cloud, or an SMTP relay the user already pays for.

## 2. Start the backend and console

On the **target machine**:

```sh
git clone https://github.com/mailkite/server && cd server
cp .env.example .env
# set HMAC_SECRET in .env:  openssl rand -hex 32
docker compose up -d
```

Without Docker:

```sh
cd api-local
HMAC_SECRET="$(openssl rand -hex 32)" node server.mjs   # 127.0.0.1:8787
```

Set `HOST=0.0.0.0` and a real `CORS_ORIGIN` if the console must be reachable remotely.
Put `ADMIN_EMAIL=<user's address>` in the environment before exposing the install, so the
admin identity is pinned rather than claimed by the first visitor.

## 3. Claim the console

Open the console — `http://<host>:8787`, or through the tunnel from step 0 when the target
is remote. The first email entered claims the install; with `ADMIN_EMAIL` set, that address
is the admin. If the user wants magic-link sign-in, prove an email method in the setup
screen (MailKite Cloud key or SMTP) and enter the 6-digit code.

Headless alternative (no console), on the target:

```sh
node api-local/cli.mjs add-user "Name"
node api-local/cli.mjs add-domain example.com "Name"
node api-local/cli.mjs add-key "Name"          # prints an mk_local_… key once
node api-local/cli.mjs list
```

## 4. Add the domain and its DNS

In the console: **Domains → add**, or the CLI above. The server generates the DKIM key
and shows the records. Print them exactly, then ask the user to apply them:

| Record | Purpose |
|---|---|
| `MX` → the edge host | inbound routing |
| `TXT` SPF | outbound authorisation |
| `TXT <selector>._domainkey` | DKIM (generated by the server) |
| `TXT _dmarc` | policy + reports |
| `A` for `mx.<domain>` / `smtp.<domain>` | the edge hosts |
| PTR on the VPS IP | reverse DNS for the edge host |

Verify in the console (or `node api-local/cli.mjs list`) and wait for the MX/SPF/DKIM
checks to pass. Do not continue with sending until the From domain is verified.

## 5. Receiving

**5a. Local MX edge** (only if port 25 is reachable):

```sh
docker compose --profile edges up -d      # Haraka MX on :25
```

**5b. No port 25?** Point the domain's MX at MailKite's hosted MX and attach this backend
as a destination — the same edge code runs there and delivers to the local backend. See
`docs/multi-backend.md`. Nothing else changes.

Test: send a message from an outside mailbox to an address on the domain. Confirm it is
in the console's message log and that a webhook (if configured) received a signed POST.

## 6. Sending

Choose one and set it in the backend's environment (`/etc/mailkite/api-local.env`,
`.env` for compose, or the platform's variables). Restart the backend afterwards.

| Mode | Env | Notes |
|---|---|---|
| **Amazon SES** (recommended) | `SMARTHOST=ses`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, optional `SES_REGION` | Uses the AWS access key pair, not SMTP credentials. HTTPS 443, so blocked port 587 does not matter. |
| **MailKite Cloud** | `SMARTHOST=cloud`, `MAILKITE_SEND_KEY=mk_live_…` | The From domain must also be verified in that Cloud account. |
| **Any SMTP relay** | `SMARTHOST=smtp://user:pass@host:587` or `smtps://…:465` | STARTTLS with AUTH PLAIN/LOGIN. |

SES prerequisites — check these before blaming the server:

1. The From domain (or address) is a verified identity, with **Easy DKIM** enabled. This
   server does not sign outbound DKIM itself.
2. The IAM user has `ses:SendRawEmail`.
3. The account has left the SES sandbox, or every recipient is verified.

Verify:

```sh
curl -sS -X POST http://127.0.0.1:8787/v1/send \
  -H "authorization: Bearer mk_local_…" -H 'content-type: application/json' \
  -d '{"from":"you@example.com","to":"a-real-inbox@example.net","subject":"setup test","text":"hello"}'
# -> {"id":"msg_…","status":"sent"}   and the message arrives
```

If the response is `502` with `code: "ses_rejected"`, read `detail` — it is the SES error.
`ses_credentials` means the key pair or IAM policy, `rate_limited` means throttling,
`ses_paused` means the account is paused in SES.

## 7. Verify the whole thing

- Inbound: external sender → domain → console log + webhook.
- Outbound: `/v1/send` → `202`/`sent`, message arrives, headers show the right `From`.
- Health: `GET /api/health` answers and reports the data directory.
- Restart the backend once and re-check: an env var that only lives in the current shell
  is the most common "it worked yesterday" bug.

## Failure map

| Symptom | Cause | Fix |
|---|---|---|
| `400 no_smarthost` | no outbound path configured | set `SMARTHOST` (step 6) |
| `502 smarthost_failed` on `/api/relay` | provider rejected or unreachable | read the attached cause; see the SES table above |
| `403 from_domain` | the API key's account does not own the From domain | add the domain to that account, or send from one it owns |
| `535` from an SMTP relay | bad relay username/password | re-check the URL credentials |
| Mail lands in spam | no DKIM / SPF / DMARC, or a cold IP | verify records; prefer SES/Cloud for outbound |
| Nothing in the message log | MX not pointed at the edge, or port 25 blocked | step 5 |

## Hand-off

Tell the user: the console URL, the admin address, the outbound mode, which DNS records
are live, and what is still pending (e.g. DNS propagation, SES production access). Do not
paste secrets into the final message.
