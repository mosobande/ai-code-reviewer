# Configure the reviewer

Configure one repository provider, one reviewer identity, one AI provider, and a review deadline before you deploy the service.

## Configure GitHub

### Create the GitHub App

Open **Settings > Developer settings > GitHub Apps > New GitHub App**.

Set these values:

- Webhook URL: `https://YOUR_DOMAIN/api/github/webhooks`
- Webhook secret: a long random value
- Pull requests permission: **Read and write**
- Contents permission: **Read-only**
- Metadata permission: **Read-only**
- Event subscription: **Pull request**

Create the App, record its App ID, generate a private key, and install it on each personal account or organization whose repositories it may review. Select only the repositories that need reviews where practical.

Enable **Allow this GitHub App to be installed by any user or organization** only when you need to install the same App on both a personal account and an organization. This setting does not grant the service permission to review every installation. `GITHUB_ALLOWED_OWNERS` and `GITHUB_ALLOWED_REPOSITORIES` enforce the runtime boundary.

### Add the reviewer account

Create a normal GitHub account if you do not want to request reviews from your own account. Give the account access only to the repositories it reviews:

- For one repository, add it as a collaborator with **Read** access.
- For an organization, add it as an outside collaborator on selected repositories, or add it to a team that grants **Read** access.

The account does not need organization-owner or repository-write access. Requesting this account as a reviewer triggers the service. The GitHub App posts the review.

Set these production variables:

```dotenv
REPO_PROVIDER=github
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=BASE64_OF_THE_PEM
GITHUB_WEBHOOK_SECRET=replace-me
REVIEWER_LOGIN=atunwo
GITHUB_ALLOWED_OWNERS=quantipixels
# Optional exact scopes in addition to allowed owners:
# GITHUB_ALLOWED_REPOSITORIES=quantipixels/skills,mosobande/personal-repo
```

Generate the base64 value without a trailing newline:

```bash
base64 < your-app.private-key.pem | tr -d '\n'
```

At least one allowed owner or exact repository is mandatory. Matching is case-insensitive. The service acknowledges and ignores a signed request outside the allowlist before it creates an installation client or AI review.

## Configure GitLab

1. Create a project or group access token with `api` and `read_repository` scopes.
2. Add a webhook for **Merge request events** at `https://YOUR_DOMAIN/api/gitlab/webhooks`.
3. Set the same secret in GitLab and `GITLAB_WEBHOOK_SECRET`.
4. Add the token's bot user as a reviewer, or as an assignee on GitLab Free.

```dotenv
REPO_PROVIDER=gitlab
GITLAB_TOKEN=glpat-xxx
GITLAB_WEBHOOK_SECRET=replace-me
# For self-managed GitLab only:
# GITLAB_API_URL=https://gitlab.example.com
```

Prefer a project token when one repository is enough. A group token gives the bot the access granted by that group.

## Configure the AI provider

The production image contains pinned Claude and Codex CLIs. Do not install either CLI separately in the container.

### Configure Claude

Generate a subscription token on a trusted machine:

```bash
npm install -g @anthropic-ai/claude-code@2.1.239
claude setup-token
```

Copy the result into the production configuration:

```dotenv
AI_PROVIDER=claude
CLAUDE_CODE_OAUTH_TOKEN=claude_oauth_xxx
# CLAUDE_MODEL=claude-sonnet-4-6
```

Do not set `ANTHROPIC_API_KEY`. The service rejects that configuration because the API key takes precedence over the subscription token and changes the billing path.

### Configure Codex

Codex supports an API key, access token, or persistent CLI login. Authentication uses this precedence:

1. `CODEX_API_KEY`
2. `CODEX_ACCESS_TOKEN`
3. Persisted CLI authentication under `CODEX_HOME` or the default `~/.codex` state

```dotenv
AI_PROVIDER=codex
# CODEX_API_KEY=sk-...
# CODEX_ACCESS_TOKEN=...
# CODEX_MODEL=gpt-5.6-terra
# CODEX_REASONING_EFFORT=medium
# CODEX_WEB_SEARCH_MODE=disabled
# CODEX_BASE_URL=https://api.openai.com/v1
```

For OAuth, complete the login inside the deployed app container. Both deployment paths mount `/home/node/.codex` on persistent host storage, so replacing the container preserves the login.

Codex runs with a read-only sandbox and approval policy `never`. Its subprocess receives only infrastructure and Codex authentication or configuration variables. It does not receive GitHub, GitLab, Claude, or Anthropic secrets.

## Configure review deadlines

Every provider execution has one wall-clock budget shared by the initial attempt and its one automatic retry. Queue wait, repository checkout, and review posting are not part of this budget.

```dotenv
REVIEW_TIMEOUT_SECONDS=1800
# CLAUDE_TIMEOUT_SECONDS=1800
# CODEX_TIMEOUT_SECONDS=1800
```

The global default is 1800 seconds when the variable is omitted. A provider value overrides the global value. Values must be positive safe integers. `0` does not disable the deadline.

Timeout, caller cancellation, and invalid configuration do not retry. Other provider failures may retry once with only the remaining time. Claude receives `SIGTERM`, then `SIGKILL` after a grace period if its complete process group has not exited. Codex receives the same deadline through the SDK's `AbortSignal`.

`DEEP_REVIEW_MAX_TURNS` is a separate model-turn limit. It does not change the wall-clock budget.

## Configure deep reviews

Diff-only review is the default. Add the `deep-review` label to one change, or set `DEEP_REVIEW=true` globally, to clone the change head and let the provider read surrounding files.

```dotenv
DEEP_REVIEW=false
DEEP_REVIEW_MAX_TURNS=8
```

Claude receives only `Read`, `Grep`, and `Glob`. It does not receive `Bash`, `Write`, or `Edit`. Codex stays in its read-only sandbox. The checkout is temporary and is removed after success, failure, or cancellation.

Deep review uses more provider time and repository I/O. Keep the global setting off unless most reviews need it.
