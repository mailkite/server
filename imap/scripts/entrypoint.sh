#!/bin/sh
# Entrypoint for the MailKite IMAP edge (systemd). Exec the imap-core daemon in the foreground.
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$APP_DIR/server.js"
