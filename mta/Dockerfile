# MailKite MX edge — Haraka on Node 22.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. Haraka is a prod dependency.
# `npm ci` (not install) so the image gets the exact tree the VPS runs — package-lock.json
# is committed, so it is always present; the old `package-lock.json*` glob tolerated its
# absence and quietly resolved whatever was newest at build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App: Haraka config, plugins, and scripts.
COPY config ./config
COPY plugins ./plugins
COPY scripts ./scripts
RUN chmod +x scripts/entrypoint.sh

# Haraka listens on SMTP :25 (Fly forwards external :25 here — see fly.toml).
EXPOSE 25

# Run Haraka via npx-resolved bin from local node_modules.
ENV PATH="/app/node_modules/.bin:${PATH}"

# Best-effort host_list sync, then exec Haraka in the foreground.
CMD ["sh", "/app/scripts/entrypoint.sh"]
