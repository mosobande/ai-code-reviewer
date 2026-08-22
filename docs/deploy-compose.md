# Deploy with Docker Compose and Caddy

Use this path to build and run the service on one Linux VM without an application registry. Caddy terminates TLS and renews certificates.

## Prerequisites

- One Linux VM with Docker Engine and the Compose plugin
- A non-root deployment user that can run Docker
- An `A` record for `PROXY_HOST` that points to the VM
- Inbound TCP 80 and 443, and optionally UDP 443, allowed by the provider firewall
- A configured GitHub or GitLab integration
- A configured Claude or Codex provider

See [Configure the reviewer](configuration.md) for repository and AI provider settings.

## Deploy the service

Clone and configure the service on the VM:

```bash
reviewer_repository=YOUR_REPOSITORY_URL
reviewer_candidate=$(git ls-remote "$reviewer_repository" refs/heads/main | cut -f1)
test -n "$reviewer_candidate"
sudo install -d -o "$USER" -g "$USER" /srv/ai-code-reviewer
git clone --no-checkout "$reviewer_repository" /srv/ai-code-reviewer
git -C /srv/ai-code-reviewer checkout --detach "$reviewer_candidate"
git -C /srv/ai-code-reviewer rev-parse --verify "${reviewer_candidate}^{commit}"
cd /srv/ai-code-reviewer
cp .env.production.example .env.production
chmod 600 .env.production
```

Record `reviewer_candidate` in the deployment handoff. This pins the build to one commit if `main` moves during setup.

Edit `.env.production`. Set `PROXY_HOST`, the repository provider, the AI provider, and the GitHub allowlist when GitHub is selected.

Validate and build:

```bash
docker compose --env-file .env.production -f compose.production.yml config --quiet
docker compose --env-file .env.production -f compose.production.yml build app
```

For Codex OAuth, prepare the host mounts and start the device login before the app:

```bash
docker compose --env-file .env.production -f compose.production.yml run --rm prepare
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps app \
  npm exec -- codex login --device-auth
```

Start the service:

```bash
docker compose --env-file .env.production -f compose.production.yml up -d
reviewer_app=$(docker compose --env-file .env.production -f compose.production.yml ps -q app)
for reviewer_check in $(seq 1 60); do
  reviewer_health=$(docker inspect --format '{{.State.Health.Status}}' "$reviewer_app")
  case "$reviewer_health" in
    healthy) break ;;
    unhealthy) break ;;
  esac
  sleep 2
done
test "$reviewer_health" = healthy || {
  docker compose --env-file .env.production -f compose.production.yml logs --tail 200 app
  exit 1
}
curl -fsS "https://$(grep '^PROXY_HOST=' .env.production | cut -d= -f2)/health"
```

The `prepare` service makes `./data` and `./codex` writable by container UID and GID 1000. The app runs as that unprivileged user. Caddy stores certificates in named volumes. The app stores SQLite under `./data` and Codex state under `./codex`.

To run Compose from another directory, provide absolute paths:

```bash
docker compose \
  --project-directory /srv/ai-code-reviewer \
  --env-file /srv/ai-code-reviewer/.env.production \
  -f /srv/ai-code-reviewer/compose.production.yml ps
```

Follow [Verify and operate the reviewer](operations.md) after the service becomes healthy.

## Update the deployment

```bash
cd /srv/ai-code-reviewer
reviewer_old_commit=$(git rev-parse --short HEAD)
reviewer_app=$(docker compose --env-file .env.production -f compose.production.yml ps -q app)
reviewer_old_image=$(docker inspect --format '{{.Image}}' "$reviewer_app")
docker image tag "$reviewer_old_image" "ai-code-reviewer:rollback-${reviewer_old_commit}"
git fetch origin main
reviewer_candidate=$(git rev-parse --verify origin/main^{commit})
git checkout --detach "$reviewer_candidate"
docker compose --env-file .env.production -f compose.production.yml config --quiet
docker compose --env-file .env.production -f compose.production.yml up -d --build
```

Run the bounded health check from the initial deployment. If it fails, restore the retained tag:

```bash
docker image tag ai-code-reviewer:rollback-OLD_COMMIT ai-code-reviewer:local
docker compose --env-file .env.production -f compose.production.yml up -d --no-build app
```

The rollback changes only the app image. The `data`, `codex`, `caddy_data`, and `caddy_config` mounts survive image and container replacement.
