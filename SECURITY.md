# Security policy

## Reporting a vulnerability

**Do not open a public issue for security reports.** Use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability), or email
bucabay@gmail.com with details and a proof of concept if you have one.

You'll get an acknowledgment within a few days. Please give us a reasonable window to
ship a fix before public disclosure; we'll credit you in the release notes unless you
prefer otherwise.

## Scope

- The SMTP edges (`mta/`, `mta-submit/`), the IMAP edge (`imap/`), the reference backend
  (`backend-local/`), and the UI (`ui/`).
- The hosted MailKite Cloud service is **out of scope here** — report cloud issues to
  bucabay@gmail.com directly, not via this repository.

## Known, assessed advisories (not vulnerabilities in this project)

`npm audit` in `imap/` reports `semver` ReDoS advisories via `imap-core → utf7`. The
vulnerable code path only ever receives `process.version` (a Node-supplied constant), so
no untrusted input can reach it. Full analysis in `imap/README.md`. PRs that only
force-resolve `semver` will be declined — see `CONTRIBUTING.md`.
