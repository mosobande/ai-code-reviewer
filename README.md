# Alátùńwò AI Code Reviewer

A self-hosted webhook service that reviews pull/merge requests with an AI provider
— Copilot-style. Install it once across your account/org; whenever a designated
reviewer is requested on a change, the service pulls the diff, runs the review on
your subscription, and posts inline review comments.

The service listens to webhooks for explicitly allowed repositories. A repository
can set review approval policy in `.acr.yml` on its target branch.

**Two pluggable seams.** The **AI provider** (the review engine) and the
**repository provider** (the code host) are both swappable:

- **AI provider** — **Claude** (via the Claude Code CLI) is the default; **Codex**
  (via the official `@openai/codex-sdk`) is also supported. Seam: `provider.ts`,
  `providers/<name>.ts`. Select with `AI_PROVIDER` (default `claude`).
- **Repository provider** — **GitHub** (a GitHub App, default) and **GitLab** (a
  bot access token). One host per deploy. Seam: `repository.ts`,
  `repositories/<name>.ts`. Select with `REPO_PROVIDER` (default `github`). The
  webhook lands on `/api/<provider>/webhooks`.

## How it works

```
PR/MR: request review, push while assigned, or use a review command
        │  (GitHub can opt exact repositories into automatic review)
        ▼
  This service  ──►  verify live head and target; durably admit; ack; enqueue
        │
        ├──►  fetch the diff (repository provider)
        │
        ├──►  selected AI provider (Claude CLI by default, Codex SDK optional)
        │            returns JSON: { summary, comments[] }
        ▼
  POST a review with inline comments; reconcile check and approval
```

## What the review covers

The reviewer is **language-agnostic** — it detects the stack from the diff and
applies that language's idioms, so the same rubric works for any codebase. Each
review weighs correctness/logic bugs, edge cases and error handling, security,
performance, API/contract changes, missing tests, and maintainability — and
deliberately skips pure formatting a linter already enforces. The PR title and
description are fed in (as untrusted data) so it can judge whether the change does
what it claims. Findings are graded `blocker` / `warn` / `info`, and the summary
leads with what matters. A read-only checkout provides surrounding context by
default. See [Deep reviews](#deep-reviews).

### Follow-up reviews

Requesting the reviewer again runs a full review. A push while the reviewer
remains assigned asks for an incremental review of the uncovered commits; if
the host cannot prove a complete range, the service runs a full review. A PR/MR
author or collaborator can leave an exact top-level `@reviewer review` command
for an incremental pass or `@reviewer full review` for a full pass. Here
`reviewer` is a configured GitHub reviewer login or the GitLab bot username.
Replying to a finding asks the bot to reassess that conversation. Incremental
and targeted passes leave the required review check non-passing until a full
review completes.

## 1. Set up the repository provider

Pick one host and set `REPO_PROVIDER` accordingly. The trigger is the same idea on
both: a designated bot account is asked to review, and the service reacts.

### GitHub (`REPO_PROVIDER=github`)

Settings → Developer settings → **GitHub Apps** → New GitHub App.

- **Webhook URL:** `https://YOUR_HOST/api/github/webhooks`
- **Webhook secret:** a long random string (also goes in `.env`)
- **Repository permissions:**
  - Pull requests: **Read & write** (read the diff, post the review)
  - Contents: **Read-only** (read `.acr.yml` and check out files)
  - Checks: **Read & write** (publish the exact-head review check)
  - Issues: **Read & write** (read commands and maintain the walkthrough)
  - Metadata: **Read-only** (mandatory)
- **Subscribe to events:** **Pull request**, **Issue comment**, and **Pull request review comment**
- After creating: note the **App ID**, generate a **private key** (.pem), then
  **Install** the App on your account and choose **All repositories**.

> **Security — keep the App private.** Set the App to **"Only on this account"**
> (not public/installable by others). The trigger is just a reviewer login, which
> is public knowledge once this repo is open-source. If anyone could install the
> App, they could open PRs requesting your reviewer login and loop them to drain
> your Claude subscription. Configure `GITHUB_ALLOWED_OWNERS` or
> `GITHUB_ALLOWED_REPOSITORIES`; automatic review additionally requires exact
> `GITHUB_AUTO_REVIEW_REPOSITORIES` entries.

### GitLab (`REPO_PROVIDER=gitlab`)

GitLab has no first-party App model; the bot is a user backed by an access token.

1. Create a **Project** or **Group access token** (Settings → Access tokens) with
   scopes **`api`** and **`read_repository`**. Its associated bot user (e.g.
   `project_<id>_bot`) is what you add as a reviewer. Put the token in `GITLAB_TOKEN`.
   The bot's identity is resolved from the token at startup (`GET /user`), so there's
   no `REVIEWER_LOGIN` on GitLab.
2. On GitLab 19.1 or later, add a **webhook** (Settings → Webhooks) → URL
   `https://YOUR_HOST/api/gitlab/webhooks`. Generate a **signing token** and put
   its `whsec_` value in `GITLAB_WEBHOOK_SECRET`. Tick **Merge request events**
   and **Comment events**.
3. Add an external status check for each allowed project. Put its ID in
   `GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON`, keyed by exact project path. Set
   `REPOSITORY_ALLOWED_REPOSITORIES` to those same paths.
4. For **self-managed** GitLab, set `GITLAB_API_URL` to your instance
   (e.g. `https://gitlab.example.com`); it defaults to `https://gitlab.com`.

**Trigger:** add the bot as a **reviewer** (GitLab Premium) **or assignee** (works on
Free tier) on a merge request. Re-requesting a review or pushing while assigned
also starts a review.

> **Security — keep the bot scoped.** The token grants whatever its project/group
> allows; prefer a Project access token over a Personal one, and scope it to the
> repos you actually review. `REPOSITORY_ALLOWED_REPOSITORIES` further limits
> which projects the service accepts.

## 2. Set up the AI provider

### Claude (`AI_PROVIDER=claude`)

On any machine with a browser:

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token        # complete the OAuth flow; copy the printed token
```

Put it in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. It's valid ~1 year and bills to
your Pro/Max plan. (On a browserless server, run `setup-token` on your laptop and
copy the token over, or SSH-forward the OAuth callback port.)

### Codex (`AI_PROVIDER=codex`)

Codex runs through the official `@openai/codex-sdk` package. The SDK wraps the
Codex runtime from `@openai/codex`, which is installed as a production dependency;
you do not need to install a separate global `codex` binary for this service.

For deep reviews, the service starts the SDK thread with the checked-out PR/MR
head as the working directory. User config loads by default; set
`CODEX_MODEL=gpt-5.5` to override the configured model.

Auth precedence:

- `CODEX_API_KEY` wins when set. This is the simplest automation mode for the SDK.
- Otherwise Codex uses CLI auth/config under `CODEX_HOME` when set.
- Otherwise `CODEX_ACCESS_TOKEN` can provide trusted automation/subscription auth.
  This is the Codex/ChatGPT access-token path, operationally closest to the
  Claude `CLAUDE_CODE_OAUTH_TOKEN` setup.
- If none are set, Codex falls back to the default `~/.codex` path, so the host
  must already be logged in with `codex login`.

Supported Codex tunables:

- `CODEX_MODEL`: model override for the review thread.
- `CODEX_REASONING_EFFORT`: one of `minimal`, `low`, `medium`, `high`, `xhigh`.
- `CODEX_WEB_SEARCH_MODE`: one of `disabled`, `cached`, `live`; deploys default
  this to `disabled`.
- `CODEX_BASE_URL`: alternate OpenAI-compatible API base URL.

The Codex docs call this token `CODEX_ACCESS_TOKEN`. For ephemeral automation,
store it as an environment secret. For persistent cached CLI auth, seed the host
once with:

```bash
printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token
```

Safety: Codex runs with a read-only sandbox, approval mode `never`, and structured
output schema support. The SDK subprocess env forwards only base infra vars plus
Codex auth/config vars (`CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_ACCESS_TOKEN`,
`CODEX_API_KEY`, `CODEX_CA_CERTIFICATE`, `RUST_LOG`); repository provider secrets
and Claude/Anthropic secrets are not forwarded. `CODEX_HOME` and
`CODEX_SQLITE_HOME` remain Codex runtime details, not app-level configuration.

## 3. Configure

```bash
cp .env.example .env      # set REPO_PROVIDER + that host's block, and one AI provider
npm install
```

## 4. Host it

The service needs Node 18+ and, for `AI_PROVIDER=claude`, the Claude Code CLI. For
`AI_PROVIDER=codex`, the Codex runtime is provided by production npm dependencies.
Use a container or a small VPS, not a thin serverless function.

```bash
npm i -g @anthropic-ai/claude-code   # on the host, for AI_PROVIDER=claude
npm start
```

Put it behind HTTPS (Caddy/nginx, or your platform's TLS). The public URL must
match the App's Webhook URL. For local testing, use a tunnel (e.g. smee.io or
cloudflared) as the Webhook URL.

## Reliability

The review path provides:

- **Durable admission + background queue:** the service verifies the live source
  and target, records the request in SQLite, then acknowledges it and runs the
  review in the background, serialised through a one-at-a-time queue so only a
  single AI provider subprocess runs at once (predictable memory on a small box).
- **Generations & audit log:** webhook delivery IDs deduplicate retries while a
  new command or newer head can create another review generation. A newer head
  cancels queued or running older work. Each generation records status, coverage,
  summary, error, and timestamps. A failure before posting can be retried by a
  new request. Set `DATABASE_PATH` (defaults
  to `./data/reviews.db`); in a container, point it at a mounted volume so it
  survives redeploys — already wired in `config/deploy.yml`.
- **Bad inline comments degrade gracefully:** if the model comments on a line
  outside the diff, GitHub rejects the whole review and the code falls back to a
  summary-only comment; GitLab posts each comment separately, so a rejected one is
  skipped and the rest (plus the summary) still land. Missing comments prevent
  terminal success.
- **Exact-head checks and policy:** GitHub Check Runs or GitLab external status
  checks track the review. The target branch `.acr.yml` can select `human` or `bot`
  approval; invalid or unreadable policy fails the review. See
  [repository review policy](docs/review-policy.md).

## Limits

- **Trigger identity:** on GitHub a custom App can't be *added* as a reviewer like
  Copilot (that's first-party only) — request **yourself** or a dedicated
  machine-user as reviewer and set that account in `REVIEWER_LOGIN`. On GitLab the
  bot **is** a user, so you add it as a reviewer/assignee directly; its identity
  comes from `GITLAB_TOKEN`. Either way the service posts under its own identity.
- **Usage:** headless reviews draw from your subscription's normal usage limits.
  Contextual reviews default to an eight-turn budget; diff-only reviews use one.
- **Single instance:** the in-process queue and the local SQLite file both assume
  exactly one running instance. Don't scale to multiple replicas without moving
  the queue and store onto shared infrastructure.
- **Unbounded, in-memory queue:** reviews run one at a time (queue concurrency 1),
  but the backlog is unbounded and lives in memory. A burst of requests grows
  memory and latency with no backpressure, and a restart drops everything still
  queued — those rows are recovered to `failed` at boot, so each dropped PR must
  be re-requested. A crash after posting starts leaves an ambiguous generation
  for manual inspection before retry. Fine for personal / small-org use; for heavier load, add a
  bounded queue that posts a "busy, please re-request" notice rather than raising
  concurrency (which trades away the predictable-memory guarantee).

## Deep reviews

By default a review clones the change head and lets the AI provider open
**surrounding files** (definitions, call sites, tests) for context. Set
`DEEP_REVIEW=false` for diff-only reviews.

- **Per change:** add the `deep-review` label to a PR/MR to use a checkout when
  the global default is off.
- **Globally:** `DEEP_REVIEW=true` makes every review contextual.

- **How it works:** the repository provider fetches the change head into a throwaway
  temp dir — shallow, fork-agnostic (`pull/<n>/head` on GitHub via a short-lived
  contents:read installation token; `merge-requests/<iid>/head` on GitLab via the
  bot token). The provider runs against that checkout with a raised turn budget
  where supported (`DEEP_REVIEW_MAX_TURNS`, default 8); the temp dir is always
  removed afterward.
- **Security:** Claude gets **read-only** tools (`Read`, `Grep`, `Glob`) — never
  `Bash`/`Write`/`Edit`; Codex runs with `--sandbox read-only` and
  `--ask-for-approval never`. Untrusted code is read, never executed. The token is
  passed via `GIT_CONFIG_*` env, so it never lands in `.git/config` or the process
  list. The worst case from a malicious change is a wrong comment, not RCE.
- **Cost:** every deep review clones a repo and uses multiple turns, drawing more
  from your subscription than a diff-only pass.
- **Requirements:** `git` on the host (bundled in the image) and read access to repo
  contents — GitHub App **Contents: Read** / GitLab token **`read_repository`**
  (already in the setup above).
