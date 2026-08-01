# Contributing to MailKite Server

Thanks for helping build an open, programmable mail server.

## Ground rules

- **CLA required.** Before your first PR is merged you'll be asked to sign our individual
  Contributor License Agreement (via cla-assistant on the PR). It lets the project
  relicense and dual-license in the future while you keep full rights to your work.
- **License:** all contributions land under AGPL-3.0-only.
- **One change per PR**, with a clear description of the problem it solves. For anything
  non-trivial, open an issue first so the approach can be agreed before you build.

## Development

Each component is a standalone Node.js project (`npm ci` inside `mta/`, `mta-submit/`,
`imap/`). See each component's README for local run instructions. End-to-end smoke tests
against the reference backend arrive with `backend-local/`.

## Known dependency quirks (please don't "fix" these)

- `imap/` depends on `redis` even though nothing imports it directly: `imap-core` requires
  it unconditionally at module load without declaring it. Removing it kills the daemon at
  startup. See `imap/README.md`.
- `npm audit` in `imap/` reports `semver` ReDoS advisories via `imap-core → utf7`. The
  vulnerable path only ever receives `process.version` (a Node-supplied constant), so it is
  not reachable by untrusted input, and force-resolving semver risks breaking `utf7`.
  Assessed and accepted — see `imap/README.md` for the full analysis.

PRs that only bump/force-resolve these will be closed with a pointer here.

## Security

Please report vulnerabilities privately — see `SECURITY.md` (do not open public issues for
security reports).
