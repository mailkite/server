# Outbound through Amazon SES — an API-key adapter

> Status: **live** in `api-local` (`SMARTHOST=ses`). Code:
> [`api-local/lib/ses.mjs`](../api-local/lib/ses.mjs) (request + errors),
> [`api-local/lib/sigv4.mjs`](../api-local/lib/sigv4.mjs) (signing),
> dispatch in [`api-local/lib/smarthost.mjs`](../api-local/lib/smarthost.mjs).

## The job

A self-hoster already pays AWS and already has an access key. They want outbound mail to
leave through SES **using that key** — not by generating a second credential at
`email-smtp.<region>.amazonaws.com`, storing it next to the first, and hoping the host
allows outbound SMTP.

The existing smarthost seam already covers MailKite Cloud, any SMTP relay, and "nothing".
SES via SMTP worked only the long way round, and on hosts that block 587 (Railway, most
serverless platforms) not at all. This adds the short way: SES's API over HTTPS 443.

## Prior art

- **SES SMTP credentials** are an IAM access key transformed into an SMTP username/password
  (`SigV4`-derived). They are a *second* secret with the same power as the first, and SES's
  own docs warn they can't be scoped independently of the IAM user. That is the friction
  this adapter removes.
- **AWS's own SDKs** sign `SendRawEmail` with Signature Version 4. The signature is a
  handful of HMACs over a canonical request — no SDK, no dependency, and the algorithm is
  published with test vectors, which is what makes a zero-dependency implementation safe
  to trust (see `api-local/test/ses.test.mjs`, the `get-vanilla` vector).

## Options considered

| | **A — SES SMTP endpoint** | **B — `SendRawEmail` + SigV4** ✅ | **C — SES v2 `SendEmail`** | **D — bundle the AWS SDK** |
|---|---|---|---|---|
| Credential | separate derived SMTP user/password | the access key pair you already have | same as B | same as B |
| Transport | TCP 587/465 | HTTPS 443 | HTTPS 443 | HTTPS 443 |
| Works where SMTP egress is blocked | no | yes | yes | yes |
| Max message | 10 MB | 10 MB | 40 MB | 40 MB |
| New dependency | none | none (`node:crypto`) | none | ~10 MB of SDK |
| Code | already shipped | ~120 lines + tests | ~120 lines, JSON shape | not acceptable (`api-local` is zero-dependency) |

**Decision: B.** It is the smallest step that satisfies the request, it matches the SMTP
ceiling self-hosters already live with, and it reuses the same raw MIME the submission edge
hands over — one path for API sends, console compose and relayed submissions.

**C is deferred, not rejected.** The only thing it buys is 40 MB messages, and attachments
are refused by `api-local`'s own JSON API (`400 unsupported`); the 10 MB ceiling only
applies to mail relayed in from the submission edge. If attachments land, revisit.

## Configuration

```sh
SMARTHOST=ses                 # or ses://eu-west-1 to pin the region inline
SES_ACCESS_KEY_ID=AKIA…
SES_SECRET_ACCESS_KEY=…
# optional
SES_SESSION_TOKEN=…           # temporary credentials (assumed role, SSO)
SES_REGION=eu-west-1
MAILKITE_SES_ENDPOINT=…       # override the regional endpoint (tests / compatible gateways)
```

| Setting | Precedence |
|---|---|
| Region | `ses://<region>` → `SES_REGION` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1` |
| Access key | `SES_ACCESS_KEY_ID` → `AWS_ACCESS_KEY_ID` |
| Secret | `SES_SECRET_ACCESS_KEY` → `AWS_SECRET_ACCESS_KEY` |
| Session token | `SES_SESSION_TOKEN` → `AWS_SESSION_TOKEN` |

An unusable configuration (no key pair, impossible region, unparseable endpoint) logs the
reason and behaves exactly like `SMARTHOST` unset: no outbound path, external recipients
skipped and logged. It never boots half-configured and fails message by message.

## Semantics

- **Request:** `POST https://email.<region>.amazonaws.com/` with
  `Action=SendRawEmail`, `Version=2010-12-01`, `Source=<envelope sender>`,
  `Destinations.member.N=<rcpt>` and `RawMessage.Data=<base64 MIME>`.
- **Envelope over headers.** `Destinations` is authoritative, so a Bcc recipient is
  delivered without ever appearing in the message, and a relayed message keeps the To/Cc
  its author wrote. Locally-hosted recipients are never sent to SES at all — the split
  happens before the smarthost is called.
- **Bytes are preserved.** The MIME is base64ed as-is; no re-encoding, header folding or
  line-ending normalisation. DKIM signatures a customer applied before submission survive.
- **DKIM is SES's job.** `api-local` does not sign; SES signs when the From identity has
  Easy DKIM configured. Without it, mail goes unsigned or under `d=amazonses.com` and fails
  alignment — hence the setup checklist in `api-local/README.md`.
- **No retries inside the adapter.** A failure raises a 502 on the backend API, which the
  submission edge maps to a tempfail so the *sender* retries. Retrying here would turn a
  timeout into a duplicate message.
- **One key, one operator.** This is operator-level configuration, not per-tenant
  credentials: a multi-tenant install sending on behalf of customers should route through a
  backend that owns that policy (the contract exists for exactly that).

## Failure modes

| Symptom | SES code | Reported as | Fix |
|---|---|---|---|
| From domain not verified, or sandbox recipient | `MessageRejected` | `ses_rejected` | Verify the identity; leave the sandbox |
| IAM user lacks permission | `AccessDenied` | `ses_credentials` | Grant `ses:SendRawEmail` |
| Unknown access key | `InvalidClientTokenId` | `ses_credentials` | Check `SES_ACCESS_KEY_ID` |
| Secret does not match | `SignatureDoesNotMatch` | `ses_credentials` | Check `SES_SECRET_ACCESS_KEY` |
| Expired session token | `ExpiredToken` | `ses_credentials` | Refresh `SES_SESSION_TOKEN` |
| Sending rate exceeded | `Throttling` | `rate_limited` | Wait; the caller retries |
| Account paused for bounces/complaints | `AccountSendingPausedException` | `ses_paused` | Fix the list, resume in the SES console |
| SES 5xx | — | `provider_down` | Upstream; retry shortly |
| Endpoint unreachable / DNS / TLS | — | `connect_refused` / `dns` / `tls` | Check egress, `MAILKITE_SES_ENDPOINT` |

The SES message is attached as `detail`; the access key, secret and `Authorization` header
are never logged.

## Security notes

- The key pair lives in the environment like every other secret here (`AGENTS.md` rule 4);
  nothing new is written to disk or to a config file.
- Least privilege is one action: `ses:SendRawEmail`. Scope the resource to the identity ARNs
  you send from if you want the key to be useless against the rest of the account.
- Signing covers every header the request sends, so a proxy cannot rewrite `Content-Type`
  or `Host` unnoticed. `x-amz-security-token` is signed whenever it is present.
- The transport is HTTPS to Amazon's endpoint; nothing configurable can downgrade it, and
  `MAILKITE_SES_ENDPOINT` is refused unless it is HTTPS or loopback (which exists so the
  tests can run without an AWS account).

## Verification

`api-local/test/ses.test.mjs` covers: the AWS `get-vanilla` signing vector, header-set
signing (including session tokens), determinism, env precedence, region/endpoint rejection,
byte-preserved MIME, envelope-vs-Bcc splitting, and end-to-end sends against a stub SES
endpoint for success, `MessageRejected`, `Throttling`, `SignatureDoesNotMatch` and 5xx →
both `/api/relay` and `/v1/send` response shapes.

A live smoke test, once the identity is verified:

```sh
SMARTHOST=ses SES_ACCESS_KEY_ID=… SES_SECRET_ACCESS_KEY=… \
  HMAC_SECRET=… node api-local/server.mjs

# then, with a key from `node cli.mjs add-key`:
curl -sS localhost:8787/v1/send -H "authorization: Bearer mk_local_…" \
  -H 'content-type: application/json' \
  -d '{"from":"you@your-verified-domain.com","to":"you@example.net","subject":"ses test","text":"hello"}'
# → {"id":"msg_…","status":"sent"}
```

## Known gaps

- No `ConfigurationSetName` (set the default configuration set on the identity instead),
  so SES event publishing is configured at the AWS account level.
- 10 MB ceiling, inherited from `SendRawEmail` — see option C above.
- Forwarded mail keeps its original envelope sender, exactly as SMTP `MAIL FROM` did, so
  SES refuses it unless that sender is a verified identity. Fixing that is envelope
  rewriting/SRS, a separate design.
- **No bounce or complaint processing.** Bounces arrive at the envelope sender like they do
  over SMTP; nothing here reads them. Point SES event publishing at an SNS topic (or a
  stream you monitor) if deliverability matters, and suppress hard bounces yourself.
- **Console sign-in is not wired to this adapter.** The magic-link method is proven and
  stored separately (MailKite Cloud key, SMTP, or OAuth); `SMARTHOST=ses` does not switch
  the console to email sign-in. Someone running SES-only still has to prove a sign-in
  method — a natural follow-up is an `email_ses` method that reuses `relayViaSes`.
