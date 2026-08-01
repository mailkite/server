# Deploy the backend to Fly.io

Deploys `backend-local` + the built web console as one HTTP app, with SQLite on a Fly
volume. (The SMTP/IMAP edges are separate — see `mta/fly.toml` for the MX edge, and
`docs/self-hosting.md` for the full picture.)

```sh
# from the repo root
fly launch --no-deploy -c deploy/fly.toml     # accept or rename the app
fly volumes create mail_data -s 1 -c deploy/fly.toml
fly secrets set HMAC_SECRET=$(openssl rand -hex 32) -c deploy/fly.toml
fly deploy -c deploy/fly.toml
```

Open `https://<app>.fly.dev`, and paste the same `HMAC_SECRET` value into the console's
Connect screen (retrieve it from wherever you generated it — Fly won't show it again).

**Constraints to respect:**

- **One machine, always.** SQLite is a single-writer store on the attached volume;
  `deploy/fly.toml` pins `min_machines_running = 1` and disables auto-stop. Do not scale
  this app horizontally.
- **Back up the volume** (`fly volumes snapshots list mail_data`) — it holds the mail
  database and raw message blobs.
- Edges connect with `MAILKITE_API_URL=https://<app>.fly.dev` and the same `HMAC_SECRET`.
