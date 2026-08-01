#!/bin/sh
# Entrypoint for the MailKite submission edge (systemd). Exec Haraka in the foreground.
# Unlike the MX edge there is no host_list to sync — the submission edge accepts any recipient
# once the session is authenticated (relaying), so it just runs Haraka.
# Derive the app dir from this script's location so the path isn't hardcoded.
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Prefer the locally-installed haraka bin; fall back to a global one.
if [ -x "$APP_DIR/node_modules/.bin/haraka" ]; then
  exec "$APP_DIR/node_modules/.bin/haraka" -c "$APP_DIR"
else
  exec haraka -c "$APP_DIR"
fi
