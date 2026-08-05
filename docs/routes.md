# Routes — pattern-matched inbound handling (webhook / forward / agent)

Today `api-local` has exactly one inbound dispatch primitive: a domain's `webhook_url`
receives every message addressed to that domain. **Routes** generalize that to
address-level pattern matching with three actions — `webhook` (today's behavior, scoped to
a pattern instead of a whole domain), `forward` (relay the message to another address), and
`agent` (hand the message to a small LLM that decides whether to reply or forward it, using
a key *you* supply — any provider). A domain with no routes keeps working exactly as it does
today; routes are additive, not a replacement for `domains.webhook_url`.

This mirrors a feature that already shipped and hardened on MailKite Cloud (routes with
`webhook`/`forward`/`agent` actions, the L0 inbox-agent security model). This doc adapts
that design to `api-local`'s constraints — zero npm dependencies, single SQLite file,
Node's built-in `fetch`/`crypto` only — rather than reinventing it.

## Prior art (why this design)

- **Address-pattern routing ahead of delivery** is the standard shape — Postfix
  `virtual`/`transport` maps, Sieve `if header :matches "to"`, Haraka's own
  `recipient-routes` plugin. Same idea, HTTP/LLM actions instead of MTA hops.
- **Fan-out, not first-match-wins.** MailKite Cloud's tested semantics (see its
  `route-matching.test.ts`) run **every** active route that matches, not just the highest
  priority one — a `support@` address can have a webhook *and* an agent *and* a forward all
  fire off one inbound message. This is the more useful default for "notify several
  systems" and is what this doc adopts.
- **The inbox agent is Level-0-only, by construction, from day one.** MailKite Cloud
  shipped its inbox agent without this and had to retrofit it after finding the sender of
  an agent-routed email could ride a full account-privileged tool loop (the "lethal
  trifecta": private data + attacker-controlled content + an exfil channel — see
  [EchoLeak, CVE-2025-32711](https://www.cve.org/CVERecord?id=CVE-2025-32711) for a
  production-grade version of this exact bug class in Microsoft 365 Copilot). `api-local`
  has no dashboard tool-loop to reuse in the first place, so there's no excuse to add one
  here just to widen the agent later — §5 designs it out from the start.

## Data model

New table, additive migration (`migrate()`'s existing `ALTER TABLE`-if-missing pattern):

```sql
CREATE TABLE IF NOT EXISTS routes (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  domain        TEXT NOT NULL,              -- must be a domain this user owns (routes.domain → domains.domain)
  match_pattern TEXT NOT NULL,               -- exact | *@domain | local+*@domain | /regex/
  action        TEXT NOT NULL,               -- 'webhook' | 'forward' | 'agent'
  destination   TEXT,                        -- webhook: URL. forward: address. agent: unused.
  webhook_secret TEXT,                       -- webhook only; own HMAC secret (see webhooks.mjs signPayload)
  agent_prompt  TEXT,                        -- agent only; free-text instructions
  agent_forward_to TEXT,                     -- agent only; JSON array — addresses its forward tool may use
  ai_provider   TEXT,                        -- agent only; 'anthropic' | 'openai' | 'gemini' | 'openai-compatible'
  ai_api_key_enc TEXT,                       -- agent only; sealed via sealSecret() (see §5.3) — never plaintext at rest
  ai_base_url   TEXT,                        -- agent only; required for 'openai-compatible', ignored otherwise
  ai_model      TEXT,                        -- agent only; falls back to the provider's built-in default
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routes_domain ON routes(domain);
```

- **Per-route AI credentials, not per-install.** A single self-hosted server can serve
  several users (the `users` table is already multi-tenant); a global `AI_API_KEY` env var
  would leak one user's key to every other user's agent routes. Each `agent` route carries
  its own sealed key, matching how `app_passwords` already store per-row secrets.
- `action IS agent` validates `agent_prompt` non-empty and `ai_provider` set, exactly like
  `webhook`/`forward` validate `destination` non-empty — enforced in the `POST
  /api/admin/routes` handler, not just the UI.
- No `last_status`/`last_status_code` columns in v1 — that's a proven follow-on
  (MailKite Cloud's `docs/architecture/logging-and-route-status.md` pattern) once routes
  themselves are stable, not a v1 requirement.

## Matching semantics

Ported directly from MailKite Cloud's `routeMatches` (already has a passing test suite to
mirror, not just a description to reimplement from scratch):

| Pattern | Matches |
|---|---|
| `support@app.com` | exact address only |
| `*@app.com` | any address at that domain |
| `ticket+*@app.com` | plus-addressed prefix (`ticket+1234@app.com`) |
| `/^inv-\d+@app\.com$/` | JS-regex body between the slashes; **invalid regex matches nothing** (never throws — a typo in a pattern must not take down ingest) |

On ingest (`api/ingest`'s handler in `server.mjs`), after today's per-domain webhook
dispatch: look up `routes` for the recipient's domain, keep the ones whose `match_pattern`
matches the recipient and whose `user_id` equals the domain's owner (cross-tenant match is
structurally impossible, but check it anyway — belt and suspenders, see MailKite Cloud's
own test for exactly this), and run **all** matched active routes. A domain's legacy
`webhook_url` keeps firing independently — think of it as an implicit `*@domain` webhook
route that predates this table.

## Actions

### `webhook`

Same delivery/retry code as today's domain webhook (`webhooks.mjs`: signed POST, exponential
backoff, `deliveries` table), generalized to take a route id instead of a domain — the
`deliveries` table gains a nullable `route_id` column so both domain-level and route-level
webhooks share one retry queue.

### `forward`

Relay the message to `destination` using the **existing outbound path**
(`smarthost.mjs` — `SMARTHOST=cloud` or any `smtp(s)://` relay; zero new deps, `node:net`/
`node:tls` only, already shipped). No new sending code — a `forward` route is a
programmatic version of what `POST /api/admin/send` already does, with the destination
pinned to the route's configured address instead of an admin-supplied one.

### `agent` — the BYO-key LLM action

On match: build one user-role message from the email (from/subject/text, truncated), one
system message = the route's `agent_prompt` wrapped in the same rules-of-engagement framing
MailKite Cloud uses (§5.2), call the configured provider **once** (no tool-use loop — see
§5.1 for why), and act on the single structured decision it returns: reply, forward, or do
nothing.

## §5 Security notes

### 5.1 No tool loop in v1 — by construction, not by omission

MailKite Cloud's inbox agent originally ran the **same tool-using loop as its dashboard
assistant**, scoped down after the fact once it was clear that any tool array grants a
capability the sender's crafted email can try to invoke via prompt injection —
"least privilege" only works if the privilege doesn't exist to begin with.
`api-local` has no dashboard agent/tool-loop to reuse, so building one here — even a
supposedly-restricted one — would be introducing the exact vulnerability class MailKite
Cloud spent a security pass removing, on a fresh surface, in v1. Instead:

- The agent call is a **single non-streaming completion**, not an agentic loop. It receives
  the email and the route's prompt and returns one JSON decision:
  `{"action": "reply"|"forward"|"none", "to"?: "…", "subject"?: "…", "body": "…"}`.
- **Enforcement lives in code, never in the prompt.** After the model responds:
  - `reply` — `from`/`to`/`In-Reply-To` are pinned server-side to
    `{from: <the receiving address>, to: <the original sender>, inReplyTo: <original
    Message-ID>}`. The model supplies only `subject`/`body`. It cannot choose a
    different recipient or sending domain.
  - `forward` — the destination is checked against an allowlist built from **owner-
    controlled data only**: the route owner's account email, any address on a domain that
    owner has verified, and the route's own `agent_forward_to` list. Anything else is
    silently refused (logged, not sent) — a prompt injection in the email body cannot name
    an outside address and have it accepted.
  - `none` — no side effect.
- No `list_messages`/`list_domains`/`create_route`/`set_webhook`/arbitrary send exists to
  give the model in the first place, because there is no tool array — the model can only
  ever emit that one JSON object, which the code above treats as untrusted input to
  validate, not as instructions to execute. This closes the "lethal trifecta" by removing
  the third leg (an exfiltration channel) rather than by asking the model not to use it.
- The email body is the least-trusted input in the system: it is echoed into the model's
  context, but the *destinations* it can act on are never taken from that body — only from
  data the route owner configured ahead of time. This is the load-bearing invariant; every
  future widening (thread context, per-sender history, more actions) must preserve it.

### 5.2 System prompt framing

Mirrors MailKite Cloud's `inboxSystemPrompt`: the route's `agent_prompt` is presented as
"authoritative instructions from the account owner"; the email body is presented as
untrusted data; the model is told explicitly which destinations `forward` will actually
accept (so it doesn't waste a turn proposing one that gets silently dropped) and instructed
to prefer `none` over guessing when uncertain.

### 5.3 Keys at rest

`ai_api_key_enc` reuses `sealSecret`/`openSecret` (`lib/db.mjs`) unchanged — AES-256-GCM
under a key derived from `HMAC_SECRET` via `scryptSync`. Same threat model as app-password
secrets: the risk that matters is a copied SQLite file, and the sealed value is useless
without the server's own environment. Rotating `HMAC_SECRET` makes existing route keys
unshowable in the UI (same as app passwords today) — the operator re-enters them, no
different from rotating any other credential. Keys are never logged; provider HTTP errors
are surfaced to the console with the response body truncated and any string matching the
stored key redacted before it's persisted to `last_status_message`-equivalent fields.

### 5.4 Outbound is rate/volume bounded

An `agent` route that both replies and is reachable by anyone who can guess or find the
address is itself a moderate email-volume amplifier (send an email, get an email back).
`runDue`-style backoff doesn't apply here since this is synchronous per-message, not
queued — so the agent action gets its own **per-route** cap (e.g. N runs/hour, matching the
shape of `auth_fails`'s existing per-key counters) to blunt a loop where two agent addresses
reply to each other, or a single sender hammers one address. Exact numbers are a config
default, not a hard architectural constraint — call this out for review, not baked in yet.

## The provider module (BYO — any LLM)

Zero-dependency, `node:fetch`/global `fetch` only — no vendor SDK, matching `api-local`'s
existing style (`smarthost.mjs` talks raw SMTP over `node:net`; this talks raw HTTP to a
model API the same way). Lives at `api-local/lib/ai.mjs`.

**Why not a 3rd-party router (evaluated and rejected — see conversation for the full
comparison):** LiteLLM is a Python sidecar process — a second daemon to operate, which
directly contradicts this project's "one VPS, `docker compose up`" self-hosting pitch.
Vercel AI SDK / LangChain / Portkey pull in a real dependency tree for a problem that turns
out to need three small hand-written wire adapters. MailKite Cloud already proved this at
`web-monorepo/api/src/agent/providers/` — zero LLM SDK dependencies, a `Backend` interface,
and per-vendor files of ~150–250 lines each. Port that pattern, don't replace it with a
library.

Three backends cover the major providers because most of them share one of three wire
formats:

| Backend | Wire format | Covers |
|---|---|---|
| `anthropic` | Anthropic Messages API | Claude |
| `gemini` | Google GenAI `generateContent` | Gemini |
| `openai-compatible` | OpenAI chat-completions (parameterized by `base_url`) | OpenAI, Groq, Mistral, Together, Fireworks, **OpenRouter** (one key → ~300 models, so this alone is close to "any provider" without more code), Azure OpenAI, xAI/Grok, Perplexity, self-hosted Ollama/vLLM/LM Studio |

```js
// api-local/lib/ai.mjs — sketch
export async function complete({ provider, apiKey, model, baseUrl, system, userText }) {
  switch (provider) {
    case 'anthropic': return completeAnthropic({ apiKey, model, system, userText });
    case 'gemini': return completeGemini({ apiKey, model, system, userText });
    case 'openai':
    case 'openai-compatible':
    case 'openrouter':
      return completeOpenAiCompatible({ apiKey, model, baseUrl: baseUrl || DEFAULTS[provider], system, userText });
    default: throw new Error(`unknown ai_provider "${provider}"`);
  }
}
```

`complete()` is intentionally **non-streaming** — this runs in the background after ingest
returns (mirroring how webhook delivery already happens off the SMTP transaction), so there
is no SSE/UI consumer to stream to, unlike MailKite Cloud's interactive dashboard chat. That
drops a substantial amount of the wire-format complexity MailKite Cloud's `streamTurn` needs
(chunked SSE parsing, incremental tool-call accumulation) — a route's agent action only ever
needs one JSON object back per email.

No health/failover cache (MailKite Cloud's `providers/index.ts`) in v1: a route has exactly
one operator-supplied key for exactly one provider, so there is nothing to fail over *to* —
a failed call just means the route logs an error and does nothing for that message (fails
open to "no action", never to "leak the email elsewhere").

## Console (`ui/`)

New `ui/src/screens/routes.tsx`, structurally parallel to `webhooks.tsx`: a table of routes
per domain, add/edit form (pattern, action, and action-specific fields), and a masked
"configured / not configured" indicator for the AI key (never displayed in full after
creation — matches `credentials.tsx`'s existing app-password reveal-once pattern).

## API surface

```
GET    /api/admin/routes                 list routes for the signed-in admin's domains
POST   /api/admin/routes                 create — { domain, matchPattern, action, destination?,
                                            agentPrompt?, agentForwardTo?, aiProvider?, aiApiKey?, aiBaseUrl?, aiModel? }
POST   /api/admin/routes/:id             update (same body shape, partial)
DELETE /api/admin/routes/:id             delete
```

`aiApiKey` is accepted on create/update, sealed immediately, never returned by `GET` (a
`hasKey: true/false` boolean stands in for it, same as `app-passwords` reveal semantics).

## Scope / non-goals for v1

- No thread/sender-history context for the agent (MailKite Cloud's L1/L2) — L0 only.
  Widening this later must go through the same identity-gate reasoning MailKite Cloud's
  `inbox-agent-security.md` documents; it is explicitly not "port L1/L2 too" work for this
  pass.
- No route-level delivery-status dashboard pill (`last_status`) — v2, once routes have
  real-world usage to observe.
- No streaming console UI for watching an agent run live — the action either already
  happened (reply sent / forward relayed) or didn't by the time the console would show
  anything; this isn't an interactive chat.
- Multi-backend (`docs/multi-backend.md`) domains and routes compose without special-casing:
  routes are looked up after a domain's owning backend is already resolved, on that
  backend's own `routes` table.
