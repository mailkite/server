# Routes — pattern-matched inbound handling (webhook / forward / agent)

**Status:** shipped in `api-local` + the web console. Deferred from this pass, in order of
likely value: a per-route outbound cap (§5.4), route-level delivery status in the console
(the `last_status` pill), and thread/sender context for the agent (L1/L2 in §"Scope").


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

One new table (`CREATE TABLE IF NOT EXISTS`, so it appears on first boot after upgrade) plus
one additive column on `deliveries`, via `migrate()`'s existing ALTER-if-missing pattern:

```sql
CREATE TABLE IF NOT EXISTS routes (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  domain        TEXT NOT NULL,               -- scope; must be a domain this server hosts
  match_pattern TEXT NOT NULL,               -- local-part glob (lib/patterns.mjs grammar)
  action        TEXT NOT NULL,               -- 'webhook' | 'forward' | 'agent'
  destination   TEXT,                        -- webhook: URL. forward: address. agent: unused.
  webhook_secret TEXT,                       -- webhook: this route's own signing secret
  agent_prompt  TEXT,                        -- agent: the owner's instructions
  agent_forward_to TEXT,                     -- agent: JSON array of extra allowed forward addresses
  ai_provider   TEXT,                        -- agent: key into lib/ai.mjs PROVIDERS
  ai_api_key_enc TEXT,                       -- agent: sealed via sealSecret() (§5.3) — never plaintext at rest
  ai_base_url   TEXT,                        -- agent: required for 'custom', else overrides the default
  ai_model      TEXT,                        -- agent: overrides the provider's default model
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routes_domain ON routes(domain);

ALTER TABLE deliveries ADD COLUMN route_id INTEGER;  -- NULL = the domain-level webhook
```

Route webhooks reuse the **existing** `deliveries` queue and its backoff/retry scanner
rather than growing a second delivery path; `route_id` is only there to pick the right
signing secret and to notice a route that was deleted or paused mid-flight.

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

**Changed during implementation:** the plan was to port MailKite Cloud's `routeMatches`,
including its `/regex/` form. But `api-local` already had
[`lib/patterns.mjs`](../api-local/lib/patterns.mjs) — the app-password address grammar,
written with the comment *"available to any future routing feature, so one grammar covers
both"*. Routes reuse it verbatim instead. One grammar with one test suite beats a second
one with a regex dialect, and it already accepts Cloud's full-address form:

| Pattern | Matches |
|---|---|
| `support` (or `support@app.com`) | exact address only |
| `*` (or `*@app.com`) | any address at that domain |
| `ticket+*` | plus-addressed prefix (`ticket+1234@app.com`) |
| `*-agent`, `support-*` | suffix / prefix globs |

Patterns are stored normalized to the local-part form, so `Support@App.Example` and
`support` are one rule. `/regex/` is **not** supported — if a real need appears, it belongs
in `patterns.mjs` for app passwords too, not in a routes-only fork of the grammar.

On ingest (`POST /api/ingest` in `server.mjs`), after the per-domain webhook dispatch: look
up `routes` for the recipient's domain, keep the ones whose `match_pattern` matches the
recipient and whose `user_id` equals the domain's owner (cross-tenant match is structurally
impossible, but `matchRoutes` checks it anyway), and run **all** matched active routes. A
domain's legacy `webhook_url` keeps firing independently — think of it as an implicit `*`
webhook route that predates this table.

Route actions are dispatched **without blocking the ingest response**: the message is
already stored, the edge gets its 2xx immediately, and a slow model call or an unreachable
forward can never turn into an SMTP tempfail. Failures are logged per route.

## Actions

### `webhook`

Same delivery/retry code as today's domain webhook (`webhooks.mjs`: signed POST, exponential
backoff, `deliveries` table), generalized to take a route id instead of a domain — the
`deliveries` table gains a nullable `route_id` column so both domain-level and route-level
webhooks share one retry queue.

### `forward`

Relay the message to `destination` through the **existing outbound pipeline**
(`deliverOutbound` → local delivery or `smarthost.mjs`; zero new deps). No second sending
path — a `forward` route is what `POST /api/admin/send` already does with the destination
pinned to the route's configured address instead of an admin-supplied one.

Note this needs an outbound path to leave the building: without `SMARTHOST` set, a forward
to an address this server doesn't host is logged and skipped, exactly like any other
outbound mail.

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

### 5.4 Outbound volume — **not yet bounded (known gap)**

An `agent` route that replies and is reachable by anyone who can guess the address is an
email-volume amplifier: send an email, get an email back. Two agent addresses pointed at
each other loop; one sender hammering one address runs up a model bill.

**This is not implemented.** Nothing here caps how often a route may run. Mitigating factors
today: the model call costs the operator's own key (so the bill is visible and self-limiting),
an agent acts at most once per inbound message, and a reply always goes to the sender rather
than fanning out. But an operator exposing an agent route publicly should assume it can be
driven at whatever rate mail arrives.

The intended fix is a per-route counter shaped like the existing `auth_fails` table (N runs
per hour, refused past the cap and logged). Worth doing before an agent route is documented
as something to put on a public, guessable address.

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

As shipped, [`lib/ai.mjs`](../api-local/lib/ai.mjs) exports a `PROVIDERS` table (the single
source of truth the admin API validates against *and* the console renders its dropdown
from), `resolveProvider()` for validation, `complete()` for the call, and `parseDecision()`
for reading the reply. Configured ids: `anthropic`, `gemini`, `openai`, `openrouter`,
`groq`, `mistral`, `together`, `xai`, `deepseek`, and `custom` (any OpenAI-compatible base
URL — Azure, Ollama, vLLM, LM Studio).

```js
await complete({
  provider: 'openrouter',            // or 'custom' + baseUrl: 'http://localhost:11434/v1'
  apiKey, system, userText,
  model: null,                       // null → the provider's default
});
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
GET    /api/admin/routes                 { routes: [...], providers: [...] }
POST   /api/admin/routes                 create — { domain, matchPattern, action, destination?,
                                            agentPrompt?, agentForwardTo?, aiProvider?, aiApiKey?,
                                            aiBaseUrl?, aiModel? }
PATCH  /api/admin/routes/:id             partial update (domain and action are immutable)
POST   /api/admin/routes/:id/rotate      new signing secret (webhook routes only)
DELETE /api/admin/routes/:id             delete
```

- `aiApiKey` is accepted on write, sealed immediately, and **never returned** — `hasAiKey:
  true|false` stands in for it, mirroring app-password reveal semantics. A PATCH that omits
  it keeps the stored key, so renaming a route never means re-pasting a secret.
- `domain` and `action` are fixed at creation: changing either turns a route into a
  different route, and doing that in place hides it from anyone reading the list. The API
  returns `domain_immutable` / `action_immutable` and suggests creating a new one.
- Validation is one function shared by create and update, so a route cannot be *edited*
  into a shape it could not have been *created* in — which is what keeps "an agent route
  always has a prompt and a resolvable provider" true for the unattended dispatch path.
- The admin API is `api-local`'s own surface, not part of [`contract.md`](contract.md):
  another backend implementing the contract is free to model routes differently or not at all.
  The console asks `capabilities.routes` before showing the screen.

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
