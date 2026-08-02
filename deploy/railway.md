# Deploy the backend to Railway

Deploys `api-local` + the built web console as one HTTP service with SQLite on a
Railway volume.

1. **New project → Deploy from GitHub repo** (your fork/clone of this repo).
2. In the service **Settings**:
   - **Build → Dockerfile path:** `api-local/Dockerfile` (Railway builds from the
     repo root, which is the context the Dockerfile expects).
   - **Volumes:** add a volume mounted at **`/data`** — this holds the SQLite DB and
     message blobs.
3. **Variables:**
   - `HMAC_SECRET` — generate one: `openssl rand -hex 32`
   - `HOST=0.0.0.0` (already the image default)
   - Railway injects `PORT` automatically and the server honors it; no override needed.
4. **Networking:** generate a public domain for the service.

Open the domain and paste `HMAC_SECRET` into the console's Connect screen.

**Constraints:** single replica only (SQLite is single-writer); the volume is the
database — include it in your backup plan. Edges connect with
`MAILKITE_API_URL=https://<your-domain>` and the same `HMAC_SECRET`.
