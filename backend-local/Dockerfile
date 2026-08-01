# MailKite Server — backend-local + built UI in one image.
#
# Build context is the REPO ROOT (the image needs ui/ and backend-local/):
#   docker build -f backend-local/Dockerfile -t mailkite-server .
# Run:
#   docker run -d -p 8787:8787 -e HMAC_SECRET=$(openssl rand -hex 32) \
#     -v mail-data:/data mailkite-server
#
# node:24-alpine — backend-local needs Node >= 22.5 (node:sqlite); zero npm deps at runtime.

# --- stage 1: build the UI -------------------------------------------------------
FROM node:24-alpine AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# --- stage 2: runtime ------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
COPY backend-local/ ./backend-local/
COPY --from=ui /build/ui/dist ./ui/dist

# DATA_DIR is the only writable state (SQLite + blobs) — keep it on a volume.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    UI_DIR=/app/ui/dist
# HMAC_SECRET is required and deliberately has no default — pass it at run time.

EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/').then(()=>process.exit(0),()=>process.exit(1))"
CMD ["node", "backend-local/server.mjs"]
