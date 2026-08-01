#!/bin/sh
# Entrypoint for both Docker (/app) and a plain VM (systemd): refresh the
# accepted-domain host_list (best-effort), then exec Haraka in the foreground.
# Derive the app dir from this script's location so the path isn't hardcoded.
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

node "$APP_DIR/scripts/sync-host-list.mjs" || true

# Prefer the locally-installed haraka bin; fall back to a global one.
if [ -x "$APP_DIR/node_modules/.bin/haraka" ]; then
  exec "$APP_DIR/node_modules/.bin/haraka" -c "$APP_DIR"
else
  exec haraka -c "$APP_DIR"
fi
