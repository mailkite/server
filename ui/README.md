# ui — the MailKite Server console

The web console for a self-hosted MailKite Server: domains + DNS records, the message
log (Inbox/Sent with raw view), and credentials (API keys, IMAP app-passwords). It shares
the MailKite design system — the same tokens, primitives, and dark-first look as the
[MailKite Cloud](https://mailkite.dev) dashboard — so self-hosted and hosted feel like
one product.

| | |
|---|---|
| Stack | Vite · React 19 · TypeScript (strict) · Tailwind v4 · shadcn primitives · TanStack Query |
| Served by | `backend-local` (it serves `ui/dist` with SPA fallback) — or `npm run dev` with a proxy to `:8787` |
| Data access | everything goes through a **provider driver** (`src/providers/`) — screens never call a backend directly |

## Run

```sh
npm install
npm run build          # → dist/, picked up by backend-local automatically
# or, for development (proxies /api to a local backend-local on :8787):
npm run dev
```

Open the backend's URL, pick **Local server**, and paste the `HMAC_SECRET` the backend
runs with.

## Auth model (v1) — read this

The console authenticates with the backend's **admin secret** (the same `HMAC_SECRET`
the SMTP/IMAP edges use), kept in `localStorage` after you connect. That makes this a
**single-admin console**: anyone with the secret owns the server. Keep backend-local
bound to loopback or a private network (its default is `127.0.0.1`), and front it with
TLS + your own access control if you expose it beyond that. Scoped console logins are
roadmap.

## Provider drivers

`src/providers/types.ts` defines the `MailProvider` interface; screens render from it and
gate features on `capabilities()` — that's why the local backend's missing webhook
dispatch shows as an honest roadmap card instead of a broken screen.

- `local.ts` — backend-local's `/api/admin/*` (v1, complete)
- `cloud.ts` — MailKite Cloud (experimental stub; the Connect screen shows Cloud as
  coming-soon and links to mailkite.dev)

## Deviations from the cloud dashboard (deliberate, v1)

- **Hash-based routing** instead of TanStack Router — four flat screens don't earn a
  route tree; the seam to revisit is `src/app.tsx` only.
- **No CodePanel / onboarding-card port** — both are welded to cloud SDK samples and
  cloud APIs; the console's copy-paste surface is `code-block.tsx` (CodeBlock/ValueRow).
- `page-header.tsx` drops the "</>" code-samples button, `route-error` equivalent drops
  the stale-chunk auto-reload (no hashed-chunk deploys here).

Everything else — `components/ui/*`, tokens (`index.css`), `logo`, `status-pill`,
`load-more`, `confirm-dialog`, `lib/{format,addr,theme}` — is ported from the dashboard
so improvements can flow both ways.
