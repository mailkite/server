# Railway template — publish spec

Everything needed to publish **MailKite Server** as a Railway template. The deployable half
(`railway.json`, the Dockerfile, the volume contract) is in the repo; only the publish click needs
a human, because a template can only be created from a Railway workspace.

> **Read this first:** Railway cannot host the SMTP/IMAP edges. Port 25 inbound is not available and
> outbound SMTP is Pro-plan-only, so `mta/`, `mta-submit/`, and `imap/` need a VPS or Fly.io. What
> this template deploys is the **backend + web console** (`api-local` + `ui`): the API your app calls,
> the storage you own, and the console you manage it from. Say that in the listing — a template that
> promises a mail server and delivers half of one is the review that kills the listing.

## Publishing (5 minutes, in the Railway dashboard)

1. **Workspace → Templates → New Template.**
2. **Add service → GitHub repo** → `https://github.com/mailkite/server` (branch `main`).
   `railway.json` at the repo root selects `api-local/Dockerfile` and health-checks `/` — do not set
   the Dockerfile path by hand.
3. **Variables** (Settings → Variables). Add exactly these:

   | Variable | Value | Notes |
   |---|---|---|
   | `HMAC_SECRET` | `${{secret(64, "abcdef0123456789")}}` | required; signs backend ↔ edge calls |
   | `HOST` | `0.0.0.0` | the image default; keep explicit |
   | `DATA_DIR` | `/data` | must match the volume mount |
   | `SMARTHOST` | *(optional)* `cloud` or `smtp://user:pass@host:587` | without it, external recipients are skipped and logged |
   | `MAILKITE_SEND_KEY` | *(optional)* `mk_live_…` | required when `SMARTHOST=cloud` |
   | `ADMIN_EMAIL` | *(optional)* | pins the admin instead of first-email-claims |

4. **Attach a volume** mounted at **`/data`**. The SQLite database and message blobs live there;
   without it, a redeploy wipes every message. `railway.json` sets `requiredMountPath: "/data"`,
   so a deploy without the volume fails loudly instead of booting on ephemeral disk.
5. **Networking → Generate domain** (HTTP). The service listens on `$PORT`, which Railway injects.
6. **Healthcheck path:** `/` (already in `railway.json`), timeout 120s.
7. **Replicas: 1.** SQLite is single-writer; `railway.json` already pins `numReplicas: 1` and
   `sleepApplication: false` (a sleeping container delays inbound webhooks).
8. **Publish**, then paste the template URL into `deploy/railway.md` and the marketing pages.

## Marketplace copy

**Name:** MailKite Server

**Short description (≤140 chars):**
Self-hosted, MailKite-API-compatible email backend with a web console. SQLite on a volume, zero npm
dependencies at runtime.

**Long description:**

> Run MailKite Server's backend and console on Railway in one click. You get a REST API that speaks
> the same surface as MailKite Cloud (`POST /v1/send`, `GET /api/messages`, signed inbound webhooks),
> routes that can forward mail, POST it to your URL, or hand it to an AI agent with your own key, and
> a web console for domains, messages, routes, and credentials — all stored on your Railway volume.
>
> Outbound goes through MailKite Cloud (`SMARTHOST=cloud` + a free API key) or any SMTP relay. The
> SMTP and IMAP edges need port 25, which Railway does not provide; run them on a VPS or Fly.io and
> point them at this backend — one MX can serve several backends, so a shared edge works too.

**Category:** Developer Tools · **Tags:** email, api, self-hosted, sqlite

## Post-deploy (what the README should tell the user)

1. Open the generated domain. **The first email entered claims the install** — that becomes the admin.
2. The console asks for the `HMAC_SECRET` on its Connect screen; copy it from Railway → Variables.
3. Set `SMARTHOST` + `MAILKITE_SEND_KEY` to send, or leave them unset to receive/route only.
4. Point an edge's `MAILKITE_API_URL` at this domain with the same secret to deliver inbound mail.

## Verification before publishing

Run locally (no Railway needed):

```bash
docker build -f api-local/Dockerfile -t mailkite-server .
docker run --rm -p 8787:8787 -e HMAC_SECRET=$(openssl rand -hex 32) -v mkdata:/data mailkite-server
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/          # 200, console HTML
curl -s http://127.0.0.1:8787/api/messages                               # 401 bad_key
```

Checked in this repo on 2026-11-11 (the image stages and the runtime, without Docker):

- `ui/` builds (`npm run build` → `dist/index.html` + assets) — the only failing-prone stage.
- `node api-local/server.mjs` with `HMAC_SECRET` + `DATA_DIR` + `UI_DIR` listens, serves the console
  (`200 text/html`), and answers `/api/messages` with `401 bad_key`.
- `DATA_DIR` is created with `mail.db` + `blobs/`; with no `HMAC_SECRET` the process exits with
  `api-local: HMAC_SECRET is required`.
