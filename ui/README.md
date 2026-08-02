# ui — the MailKite Server web console

The web console for a self-hosted MailKite Server: domains + DNS records, the message
log (Inbox/Sent with raw view), and credentials (API keys, IMAP app-passwords). It shares
the MailKite design system — the same tokens, primitives, and dark-first look as the
[MailKite Cloud](https://mailkite.dev) dashboard — so self-hosted and hosted feel like
one product.

| | |
|---|---|
| Stack | Vite · React 19 · TypeScript (strict) · Tailwind v4 · shadcn primitives · TanStack Query |
| Served by | `api-local` (it serves `ui/dist` with SPA fallback) — or `npm run dev` with a proxy to `:8787` |
| Data access | everything goes through a **provider driver** (`src/providers/`) — screens never call a backend directly |

## Run

```sh
npm install
npm run build          # → dist/, picked up by api-local automatically
# or, for development (proxies /api to a local api-local on :8787):
npm run dev
```

Open the backend's URL and sign in with your admin email — a one-time **magic link**
arrives by email (or in the server log if sending isn't configured yet).

## Auth model

Default is **magic-link sign-in**: enter an allowed admin email (`ADMIN_EMAIL` env, the
/setup first-boot claim, or an invited admin), click the emailed link, and the browser
holds an **httpOnly session cookie** (30-day rolling; hashed server-side; `Secure` under
TLS; a custom `x-mailkite-ui` header doubles as the CSRF gate). Nothing sensitive lives
in `localStorage`, and sign-out revokes the session server-side.

**Advanced:** the sign-in screen still accepts the backend's `HMAC_SECRET` as a Bearer
(kept in `localStorage`) for loopback/scripted setups — treat that path as
root-credential handling, and prefer magic links anywhere the web console is reachable
beyond localhost. Backend auth details: `../api-local/README.md` §web console auth.

## Provider drivers

`src/providers/types.ts` defines the `MailProvider` interface; screens render from it and
gate features on `capabilities()` — that's why the local backend's missing webhook
dispatch shows as an honest roadmap card instead of a broken screen.

- `local.ts` — api-local's `/api/admin/*` (v1, complete)
- `cloud.ts` — MailKite Cloud (experimental stub; the Connect screen shows Cloud as
  coming-soon and links to mailkite.dev)

## Deviations from the cloud dashboard (deliberate, v1)

- **Hash-based routing** instead of TanStack Router — four flat screens don't earn a
  route tree; the seam to revisit is `src/app.tsx` only.
- **No CodePanel / onboarding-card port** — both are welded to cloud SDK samples and
  cloud APIs; the web console's copy-paste surface is `code-block.tsx` (CodeBlock/ValueRow).
- `page-header.tsx` drops the "</>" code-samples button, `route-error` equivalent drops
  the stale-chunk auto-reload (no hashed-chunk deploys here).

Everything else — `components/ui/*`, tokens (`index.css`), `logo`, `status-pill`,
`load-more`, `confirm-dialog`, `lib/{format,addr,theme}` — is ported from the dashboard
so improvements can flow both ways.
