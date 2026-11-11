# Deploy the backend to Railway

<!-- Publish the template (deploy/railway-template.md), then replace the code below and move this
     badge to the top of the file / README. Left fenced until then so nothing renders a dead link.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/REPLACE_WITH_TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=mailkite-server)
-->

Deploys `api-local` + the built web console as one HTTP service with SQLite on a Railway
volume. `railway.json` at the repo root selects the Dockerfile and health-checks `/api/health`, so
"Deploy from GitHub repo" needs no build configuration.

> **What Railway can and cannot run.** Railway cannot host the mail edges: port 25 inbound
> is not available, and outbound SMTP is Pro-plan-only. This template deploys the **backend
> and console** — the API your app calls, the messages you store, the routes and agents that
> act on them. Run `mta/`, `mta-submit/`, and `imap/` on a VPS or Fly.io (`deploy/fly.md`),
> or point a shared edge at this backend; one MX can serve several backends
> (`docs/multi-backend.md`).

## One click (after the template is published)

1. **Deploy on Railway** — the template provisions the service, a `/data` volume, and a
   generated `HMAC_SECRET`.
2. Open the generated domain. **The first email entered claims the install** (that becomes the
   admin); paste the `HMAC_SECRET` from Railway → Variables into the console's Connect screen.

Publisher checklist: [`deploy/railway-template.md`](railway-template.md).

## Manual deploy

1. **New project → Deploy from GitHub repo** (your fork/clone of this repo).
2. **Build** — nothing to set: `railway.json` points at `api-local/Dockerfile`, with the repo
   root as the build context.
3. **Volumes:** add a volume mounted at **`/data`** — this holds the SQLite DB and message
   blobs. Without it, a redeploy wipes your mail.
4. **Variables:**
   - `HMAC_SECRET` — generate one: `openssl rand -hex 32` (required; the process exits without it)
   - `HOST=0.0.0.0` (already the image default)
   - `DATA_DIR=/data` (already the image default; must match the volume)
   - Railway injects `PORT` automatically and the server honors it; no override needed
   - Optional: `SMARTHOST` (`cloud` or `smtp://user:pass@host:587`), `MAILKITE_SEND_KEY`
     (needed for `SMARTHOST=cloud`), `ADMIN_EMAIL`, `MESSAGE_ID_HOST`, `CORS_ORIGIN`
5. **Networking:** generate a public domain for the service.
6. **Replicas: 1**, and the volume is mandatory: `railway.json` pins `numReplicas: 1`,
   disables sleep, and sets `requiredMountPath: "/data"` so a deploy without the volume fails
   instead of quietly running on ephemeral disk.

Open the domain and paste `HMAC_SECRET` into the console's Connect screen.

## Sending and receiving

- **Outbound** — `SMARTHOST=cloud MAILKITE_SEND_KEY=mk_live_…` sends through MailKite Cloud
  (the cloud still applies its own From-domain verification), or point `SMARTHOST` at any
  SMTP relay. Without a smarthost, external recipients are skipped and logged.
- **Inbound** — an edge delivers `/api/ingest` to this backend. Set the edge's
  `MAILKITE_API_URL=https://<your-railway-domain>` and the same `HMAC_SECRET`.

**Constraints:** single replica only; the volume is the database — include it in your backup
plan. Railway also blocks outbound SMTP unless you are on the Pro plan, so `SMARTHOST` must be
an HTTPS API (`cloud`) or a relay reachable on Pro.

## Verified

- `ui/` builds to `dist/` (the only failing-prone image stage).
- `node api-local/server.mjs` with `HMAC_SECRET` + `DATA_DIR` + `UI_DIR` serves the console
  (`200 text/html`), answers `/api/messages` with `401 bad_key`, and creates `mail.db` + `blobs/`.
- With no `HMAC_SECRET` the process exits with `api-local: HMAC_SECRET is required` — which is
  why the template generates one rather than defaulting it.
