# Run and deploy the reviewer

The service needs a public HTTPS webhook endpoint, outbound access to its code
host and model provider, and a persistent writable SQLite path. It runs one
code host and one model provider per process. The included deployment uses
Kamal, a Node 22 container, and one reviewer replica. See [getting started](setup-and-deployment.md)
for the order of setup decisions.

## Local or manually managed host

Choose a [GitHub](github.md) or [GitLab](gitlab.md) configuration and a
[model provider](model-providers.md). Fill in the corresponding settings:

```sh
cp .env.example .env
npm ci
set -a; . ./.env; set +a
npm run typecheck
npm test
npm start
```

Use a persistent `DATABASE_PATH` (default `./data/reviews.db`) and keep only
one instance running against it. `PORT` defaults to `3000`; `GET /health`
returns `ok` when the HTTP process is listening. The health endpoint does not
prove that a webhook or model review will succeed. On a non-container host,
install `git` for contextual reviews and the Claude Code CLI if using Claude.
Put the service behind HTTPS and set the host webhook URL to
`https://YOUR_HOST/api/github/webhooks` or
`https://YOUR_HOST/api/gitlab/webhooks`.

## Production with Kamal

The included `Dockerfile` installs the Claude CLI, Git, and production npm
dependencies. The container runs as the unprivileged `node` user. Kamal's
production override supplies a TLS proxy and health check. Before deploying,
prepare:

- A server reachable by SSH with Docker and outbound access to `ghcr.io`, the
  code host, and the selected model provider.
- A DNS A record mapping the public webhook hostname to the server.
- Kamal installed on the deployment machine and a GitHub package token with
  `write:packages` for the GHCR image.
- Host credentials and one model provider credential. Keep them out of Git.

Copy `.env.production.example` to `.env.production` and fill in the matching
host and provider blocks. The deployment values are:

| Setting | Meaning |
| --- | --- |
| `IMAGE` | GHCR namespace/image name without the registry hostname |
| `KAMAL_REGISTRY_USERNAME`, `KAMAL_REGISTRY_PASSWORD` | Registry account and package token |
| `WEB_HOSTS` | Comma-separated target server IPs or hostnames |
| `PROXY_HOST` | Public HTTPS webhook hostname |
| `SSH_USER` | Remote SSH user; defaults to `deploy` |

The `bin/kamal` wrapper loads `.env.production` before invoking Kamal. The
production configuration builds on the first remote host and pushes the image
to GHCR. From the repository root, run:

```sh
bin/kamal -d production setup       # first deployment
bin/kamal -d production deploy      # later deployments
bin/kamal app logs -d production    # inspect startup and review errors
```

Check `https://YOUR_HOST/health`, then request a full review on a small PR/MR
in an allowed repository. Confirm the webhook delivery, posted review, and
current-head check before making the check required or enabling bot approval.
The commands above follow the checked-in wrapper and configuration; this
repository has no automated live Kamal deployment test.

## Data and gateway placement

`config/deploy.yml` mounts the `ai_code_reviewer_data` named volume at `/data`
and sets `DATABASE_PATH=/data/reviews.db`. Preserve that volume across
deployments. Losing it loses delivery deduplication and generation history;
remote reviews and comments remain on the code host. The in-process queue and
SQLite store assume exactly one reviewer replica. A restart does not resume
queued work; see the [review workflow](review-workflow.md) before retrying a
post that might already have reached the host.

The Kamal config forwards `MODEL_GATEWAY_SOCKET_PATH` and provider profile
settings to the reviewer but does not start a gateway or mount a socket. For
gateway mode, independently provision the gateway process, a shared Unix
socket path, and a private proxy network reachable from the reviewer. See
[model gateway setup](model-gateway.md). Do not pass the gateway's reusable
model credentials into the reviewer container.
