# AGENTS.md — how to work on MailKite Server

Guidance for coding agents (and humans) extending this repo. Read before changing
anything non-trivial.

## Architecture in one paragraph

Everything hangs off **one HTTP service interface** — [`docs/contract.md`](docs/contract.md).
**Backends** implement it and own all state/policy: [`api-local/`](api-local/) (Node +
SQLite, zero npm deps) and MailKite Cloud (`api.mailkite.dev`) are the two implementations.
**Edges** are stateless protocol adapters that terminate SMTP/IMAP and call a backend:
[`mta/`](mta/) (Haraka MX, :25), [`mta-submit/`](mta-submit/) (Haraka submission,
:587/:465), [`imap/`](imap/) (imap-core, :993). The **web UI** ([`ui/`](ui/)) is a React
SPA over `api-local`'s `/api/admin/*` routes. One MX can serve several backends at once
via [`docs/multi-backend.md`](docs/multi-backend.md). Terminology: "local API", "web UI"
— never bare "console".

## Rules that keep changes safe

1. **The contract is the SSOT.** Any change to request/response shapes updates
   `docs/contract.md` *and* the conformance suite (`api-local/test/contract.test.mjs`) in
   the same commit. Additive fields any time; breaking changes bump the major version.
2. **Edges stay stateless.** No persistent state in edge processes — short-TTL caches
   only. New edge behavior that needs state belongs behind a contract endpoint.
3. **`api-local` stays zero-dependency** (`node:sqlite`, Node ≥ 22.5). A PR adding an npm
   dependency to it needs an exceptional reason. Schema changes must be **additive
   migrations** (`ALTER TABLE` guarded by inspection) — live installs upgrade in place.
4. **Secrets live in env, never on disk or in config files.** Config files hold
   non-secret defaults; `secretEnv` indirection for multi-backend. Never commit
   hostnames/IPs of private infrastructure, TLS material, or DKIM private keys
   (`config/dkim/*/` and `config/tls/` are git-ignored by design).
5. **Verify before claiming done** (all must be green):
   `cd api-local && npm test` · `cd mta && npm test` · `node scripts/e2e-imap.mjs` ·
   `cd ui && npm run build` (strict tsc). CI mirrors these.

## Adding a Haraka plugin / edge behavior

- Follow the existing plugin shape: `mta*/plugins/*.js` — CommonJS, config via
  `this.config.get('mailkite.ini', reload-cb)` with env-first overrides, timeouts guarded
  (no AbortController in Haraka's plugin VM), non-2xx backend responses map to
  `DENYSOFT` (inbound: never lose mail) or `DENY` only for permanent user errors.
- Pure logic goes in a Haraka-free lib file (`mta/lib/`) so it's unit-testable with
  `node --test` and **no Haraka install** (CI runs edge tests dependency-free).
- **Anything under `mta*/plugins/` or `mta/lib/` also ships in
  [`packages/haraka-plugin-mailkite`](packages/haraka-plugin-mailkite)** — run
  `node packages/haraka-plugin-mailkite/scripts/sync.mjs` after edits; the `--check` mode
  fails tests/CI/prepack on drift. Repo files are authoritative.
- **DKIM-adjacent code is special:** a mistake doesn't throw, it silently unsigns mail.
  Prove byte-parity (sign the same message with old + new code, compare) before shipping
  anything that touches signing. See `mta-submit/README.md`.

## Known landmines (do not "fix")

- `imap/` depends on `redis` that nothing imports — `imap-core` requires it undeclared.
  Removing it kills the daemon in production. See `imap/README.md`.
- The `semver` advisories via `imap-core → utf7` are assessed unreachable — don't
  force-resolve. See `imap/README.md` + `SECURITY.md`.
- Don't regenerate `mta/package-lock.json` casually; `npm audit fix` breaks
  `@haraka/ocsp`. See `mta/README.md`.

## Process

- Non-trivial features: check `docs/` for an existing design doc; write one for new
  architecture (see `docs/multi-backend.md` as the template — problem, prior art,
  semantics, security notes).
- UI work follows the existing design system (`ui/src/index.css` tokens, `components/ui`
  primitives, dark-first + light verified, keyboard/reduced-motion floor).
- Contributions require the CLA (`CLA.md`); license is AGPL-3.0-only; the MailKite name
  and logo are trademarked (`TRADEMARK.md`).
- Releases: semver tags + GitHub release notes; the cloud deployment consumes this repo
  as a pinned submodule, so keep `main` releasable.
