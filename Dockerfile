# Production image for the AI Code Reviewer webhook service.
#
# Runs the app under tsx (no separate build step) and bundles the Claude Code CLI
# so the service can shell out to `claude` at runtime. Codex support is supplied by
# the production @openai/codex-sdk dependency, which bundles @openai/codex. Auth is
# supplied at runtime; it is never baked into the image.

FROM node:22-slim

# curl is for the container HEALTHCHECK; git is for deep reviews (cloning the PR).
# ca-certificates supplies the system CA bundle git needs to verify github.com over
# HTTPS — the slim base omits it, so without this a clone fails cert verification.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production dependencies only, as a cached layer keyed on the lockfile.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Application source. Run directly via tsx — no build step. We copy specific paths
# rather than `COPY .`, so test/ and other non-runtime files are excluded by
# construction. Each source subdirectory needs its own COPY line.
COPY *.ts ./
COPY providers/ ./providers/
COPY repositories/ ./repositories/
COPY runtime/ ./runtime/

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/node \
    # Keep `claude -p` headless and offline-friendly: no autoupdate, telemetry, or error reporting.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Pre-seed Claude Code state so `claude -p` runs fully headless: skips first-run
# onboarding and the per-folder "do you trust this directory?" prompt for /app.
# Key names verified against a real ~/.claude.json. No auth lives here — the token
# is injected at runtime via CLAUDE_CODE_OAUTH_TOKEN.
RUN printf '%s' \
    '{"hasCompletedOnboarding":true,"projects":{"/app":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' \
    > /home/node/.claude.json \
  && chown -R node:node /app /home/node

# SQLite review store lives here. Created node-owned so a fresh Kamal named volume
# (Docker seeds an empty volume from the image dir's ownership) is writable by the
# unprivileged runtime user. DATABASE_PATH points here in config/deploy.yml.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["npm", "start"]
