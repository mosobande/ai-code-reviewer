# Get started

Set up one code host and one model provider for each reviewer instance. The
shortest path uses direct model credentials; the standalone gateway is
optional. This page gives the order of work and points to focused guides for
each decision. Use the [configuration reference](configuration-reference.md)
to look up every supported `.acr.yml` key and environment setting.

## 1. Choose and configure the code host

- **GitHub:** create and install a GitHub App, subscribe to the needed
  webhooks, then set `REPO_PROVIDER=github`, App credentials,
  `REVIEWER_LOGIN`, and an owner or exact-repository allowlist. See
  [GitHub setup](github.md) for permissions, scope, and automatic review.
- **GitLab:** create a bot access token, a signed webhook, and an external
  status check for every exact allowed project. Set `REPO_PROVIDER=gitlab` and
  the matching token, signing secret, allowlist, and check ID map. This path
  requires GitLab Ultimate; see [GitLab setup](gitlab.md).

Both webhooks need a public HTTPS URL. The reviewer accepts a delivery only
after verifying its signature and repository scope.

## 2. Choose and configure the model

Set `AI_PROVIDER=claude` (default) or `AI_PROVIDER=codex` and provide its
credential. Claude direct mode uses the Claude Code CLI and
`CLAUDE_CODE_OAUTH_TOKEN`; Codex direct mode uses the installed SDK runtime
and Codex auth or an API key. See [model providers](model-providers.md) for
credential precedence, read-only context, model settings, and time budgets.

For separate credential ownership, run the optional
[model gateway](model-gateway.md) first, then give the reviewer only its socket
path and matching profile. The included Kamal config does not provision that
process or mount its socket.

## 3. Set approval policy

The service defaults to `ACR_APPROVAL_MODE=human`. A repository can override
that by merging `.acr.yml` into its target branch:

```yaml
version: 2
review:
  approval: human
```

Use `approval: bot` only when bot approval is intended for that repository.
Configure required checks and approval rules in GitHub or GitLab separately.
Read the [policy guide](review-policy.md) before enabling bot approval or
changing the admission and terminal-success rollout gates.

## 4. Run the service

For a local or manually managed host, fill in one host and model block:

```sh
cp .env.example .env
npm ci
set -a; . ./.env; set +a
npm start
```

The HTTP service listens on `PORT` (default `3000`) and serves `GET /health`.
Use a persistent writable `DATABASE_PATH`. For the included production image,
copy `.env.production.example` to `.env.production` and follow the
[Kamal deployment guide](deployment.md) for host, registry, DNS, volume, and
command details. Run `npm run typecheck` and `npm test` before deployment.

## 5. Verify and use it

Open a small PR/MR in an allowed repository and request the configured
reviewer. Confirm a successful webhook delivery, posted review, and check on
the current head. Keep the repository on human approval while validating this
path. Then configure the host's required check or bot approval if desired.

The [review workflow](review-workflow.md) explains incremental pushes, exact
review commands, targeted finding replies, and retry boundaries. If a review
does not appear or the check cannot pass, use [troubleshooting](troubleshooting.md).
