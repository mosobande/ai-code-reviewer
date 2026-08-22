# Compose and Caddy

Load this branch only for `compose`. Read `docs/deploy-compose.md` and `compose.production.yml` in the target repository before acting.

## Preconditions

Require Docker Engine with Compose and Buildx, an unprivileged deployment user with Docker access, public DNS for `PROXY_HOST`, available TCP ports 80 and 443, and enough disk and memory for a server-local build. UDP 443 is optional.

If authorized to install Docker on Ubuntu, use Docker's current official apt-repository procedure. Do not use an unreviewed `curl | sh` installer. Stop when the OS, sudo authority, package source, Docker access, or port ownership cannot be established safely.

## State and deployment

Preserve `./data`, `./codex`, and the Caddy named volumes. The app and both bind mounts must remain writable by container UID and GID 1000.

Validate the rendered Compose configuration before building. Build `app` on the target server, run `prepare`, complete Codex device login when selected, and start the services through the commands maintained in `docs/deploy-compose.md`.

Use Compose service names for logs and execution. Use `--project-directory` with absolute paths when operating outside the installation directory. Do not rely on a generated container name.

For an update, retain the current app image under a commit-derived rollback tag before switching source. Rollback may replace only the app image. It must preserve application, provider, and proxy state.

## Proof

Require a healthy UID-1000 app, writable bind mounts, public HTTPS, retained Caddy certificates, and state persistence after container replacement. Keep the rollback image until one webhook-triggered review passes.
