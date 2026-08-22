# Deploy with Kamal and GHCR

Use this path for registry-backed releases managed by Kamal 2. Kamal builds on the first target server, pushes the image to GHCR, and deploys it through Kamal Proxy.

## Prerequisites

- Kamal 2
- A GHCR package-write token
- The DNS and firewall requirements from [Deploy with Docker Compose and Caddy](deploy-compose.md#prerequisites)
- A configured repository and AI provider from [Configure the reviewer](configuration.md)

## Deploy the service

Copy and fill the production file on the machine where you run Kamal:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Set the Kamal-only values:

```dotenv
IMAGE=your-ghcr-namespace/ai-code-reviewer
KAMAL_REGISTRY_USERNAME=your-github-login
KAMAL_REGISTRY_PASSWORD=ghp_xxx
WEB_HOSTS=203.0.113.10
PROXY_HOST=reviewer.example.com
SSH_USER=deploy
# CODEX_STATE_PATH=/home/deploy/.ai-code-reviewer/codex
```

Before a Codex deployment, create the persistent host directory as UID and GID 1000:

```bash
ssh deploy@SERVER_IP 'sudo install -d -m 700 -o 1000 -g 1000 /home/deploy/.ai-code-reviewer/codex'
```

Validate and deploy:

```bash
bin/kamal config -d production >/dev/null
bin/kamal setup -d production
```

For Codex OAuth, log in through the running container and reuse its persistent mount:

```bash
bin/kamal app exec -i --reuse 'npm exec -- codex login --device-auth' -d production
```

Follow [Verify and operate the reviewer](operations.md) after the service becomes healthy.

## Deploy a later release

```bash
git fetch origin main
reviewer_candidate=$(git rev-parse --verify origin/main^{commit})
git checkout --detach "$reviewer_candidate"
bin/kamal deploy -d production
```

See the official [Kamal deployment commands](https://kamal-deploy.org/docs/commands/deploy/) and [interactive app execution](https://kamal-deploy.org/docs/commands/running-commands-on-servers/) for command details.
