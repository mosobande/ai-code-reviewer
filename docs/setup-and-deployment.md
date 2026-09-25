# Set up and deploy the reviewer

This guide takes one reviewer instance from configuration to its first review.
An instance connects to **one code host** (GitHub or GitLab) and **one model
provider** (Claude or Codex). You can change those choices through environment
variables without changing the review workflow. The repository's `.acr.yml`
controls approval policy; it does not contain credentials or deployment settings.

## 1. Choose the review trigger and scope

| Code host | Who triggers a review | Required scope setting |
| --- | --- | --- |
| GitHub | Request a login in `REVIEWER_LOGIN` as reviewer, or opt an exact repository into automatic review | `GITHUB_ALLOWED_OWNERS` and/or `GITHUB_ALLOWED_REPOSITORIES` |
| GitLab | Assign the token's bot user as reviewer or assignee | `REPOSITORY_ALLOWED_REPOSITORIES` |

On GitHub, an owner entry admits all that owner's installed repositories;
`owner/repo` entries admit named repositories. Use the exact repository list
when you want a narrow scope. `GITHUB_AUTO_REVIEW_REPOSITORIES` must contain
exact allowed `owner/repo` entries and causes reviews on open, ready, and push.
Leave it empty to require a reviewer request or an explicit review command.
Install the GitHub App only on repositories that should be reachable by it.

On GitLab, list exact `namespace/project` paths and configure one external
status check ID per path in `GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON`, for example
`{"team/service":17}`. The sets of paths must match. External status checks
require [GitLab Ultimate](https://docs.gitlab.com/api/status_checks/).

## 2. Create host credentials and webhook

For GitHub, create a private GitHub App with these **repository** permissions:

| Permission | Access | Used for |
| --- | --- | --- |
| Pull requests | Read & write | Read changes, publish reviews, reconcile the bot's approval and review threads |
| Contents | Read-only | Read `.acr.yml` at the target commit and clone the change for contextual reviews |
| Checks | Read & write | Publish the exact-head `Alátùńwò review` Check Run |
| Issues | Read & write | Read review commands and maintain the walkthrough comment |
| Metadata | Read-only | GitHub App repository metadata |

Subscribe to **Pull request**, **Issue comment**, and **Pull request review
comment** events. Point the webhook to
`https://YOUR_HOST/api/github/webhooks`. Save its webhook secret, App ID, and
private key. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `REVIEWER_LOGIN`, and the allowlist in the reviewer
environment. [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
determine which API calls and webhooks the installation can use.

For GitLab, create a Project or Group access token with `api` and
`read_repository` scopes. Its bot user must have rights to approve the merge
request and update the external status check. Create the status check for every
allowed project and record its numeric ID. On GitLab 19.1 or later, create a
webhook at `https://YOUR_HOST/api/gitlab/webhooks`, select **Merge request**
and **Comment** events, generate a **signing token**, and put its `whsec_`
value in `GITLAB_WEBHOOK_SECRET`. This service verifies the signed payload; an
old `X-Gitlab-Token` secret alone does not work. See
[GitLab webhook signing](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens).
Set `GITLAB_TOKEN`, `REPOSITORY_ALLOWED_REPOSITORIES`, and
`GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON` in the reviewer environment. Set
`GITLAB_API_URL` for a self-managed instance.

## 3. Choose model credentials

Set `AI_PROVIDER=claude` (default) or `AI_PROVIDER=codex`.

- **Claude direct mode:** install the Claude Code CLI in the runtime and set
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Do not set
  `ANTHROPIC_API_KEY` on this path because the Claude provider rejects it.
- **Codex direct mode:** the production dependency provides the Codex runtime.
  Set `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, or a logged-in `CODEX_HOME`.
  `CODEX_API_KEY` wins when several are set. Without any of them, the runtime
  reads its default Codex home.
- **Separate gateway mode:** run the optional gateway independently, keep the
  reusable credential there, and give the reviewer only its socket path and
  matching profile. Follow the [model gateway guide](model-gateway.md) before
  enabling it in a container.

The model receives a diff and, by default, a read-only checkout for context.
Set `DEEP_REVIEW=false` for a one-pass diff-only review. A `deep-review` label
can still opt one change into context. `REVIEW_TIMEOUT_SECONDS` is the shared
time budget for an attempt and its retry; the default is 1800 seconds.

## 4. Set approval policy and merge rules

The service default is `ACR_APPROVAL_MODE=human`. To let a repository choose,
merge this file at its target branch root:

```yaml
# .acr.yml
version: 2
review:
  approval: human
```

Set `approval: bot` only when the bot's approval is meant to count in that
repository. An absent `.acr.yml` uses the instance default. Source-branch
edits cannot change policy for the current review. A clean full review can
pass the check in either mode; `human` means the bot does not approve. A
blocking finding, incomplete publication, or incremental/targeted review
keeps the check non-passing. See [repository review policy](review-policy.md)
for the exact rules and the admission and terminal-success rollout gates.

If the review should block merging, require its GitHub Check Run or GitLab
external status check in the host's merge rules. Configure a separate required
human approval rule if `approval: human` is your policy. The service cannot
create those host rules for you.

## 5. Run locally or deploy with Kamal

For a local or manually managed host, copy the example, fill in **one** host
block and **one** model provider, then start the service:

```sh
cp .env.example .env
npm ci
set -a; . ./.env; set +a
npm start
```

If using the gateway, use a separate reviewer environment file that contains
the gateway socket and profile but no reusable model credentials. Start the
gateway with its own credential environment first.

Use `npm run typecheck` and `npm test` before deploying. The service listens on
`PORT` (default `3000`) and responds to `GET /health`. Set `DATABASE_PATH` to a
persistent writable location; SQLite stores review generations and delivery
deduplication there. Put the webhook endpoint behind HTTPS and make sure the
code host can reach it.

For the included production Kamal deployment:

1. Prepare a host reachable by SSH with Docker, a DNS A record for the public
   webhook hostname, access to `ghcr.io`, and a GitHub package token with
   `write:packages`. Install Kamal on the machine running the deployment.
2. Copy `.env.production.example` to `.env.production`. Set `IMAGE`, registry
   credentials, `WEB_HOSTS`, `PROXY_HOST`, and `SSH_USER`; fill the matching
   host and model block. Keep `.env.production` private and uncommitted. The
   `bin/kamal` wrapper loads it before invoking Kamal.
3. Run `bin/kamal -d production setup` for the first deployment. Use
   `bin/kamal -d production deploy` for later releases and
   `bin/kamal app logs -d production` to inspect startup and review errors.
4. Check `https://YOUR_HOST/health`, then deliver a test webhook by requesting
   the configured reviewer on a small PR/MR in an allowed repository. Confirm
   the inline or summary review and the exact-head check. Test a full review
   before considering `approval: bot` or making the check required.

`config/deploy.production.yml` supplies the HTTPS proxy and target host. The
image runs one reviewer instance as an unprivileged user. Kamal mounts the
`ai_code_reviewer_data` volume at `/data`; the service database is
`/data/reviews.db`. Preserve that volume across redeployments. The deployment
passes optional gateway settings to the reviewer but does **not** start the
gateway or mount its socket; arrange both separately before enabling gateway
mode. The included Kamal commands are documented from the configuration and
wrapper; this repository has no automated live deployment test.

## Use the reviewer after setup

Request the configured GitHub login as a reviewer, assign the GitLab bot, or
open a ready PR in a GitHub repository opted into automatic review. A full
review posts a summary and any inline findings, then updates the check for
the current head. On a later push while the reviewer remains assigned, the
service reviews the new range when the host can prove it is complete; otherwise
it falls back to a full review. GitHub also continues to review pushes after
its own bot approval clears the requested-review assignment.

The PR/MR author or a collaborator can post one of these exact top-level
comments, replacing `reviewer` with the configured GitHub reviewer login or
GitLab bot username:

```text
@reviewer review
@reviewer full review
```

The first asks for an incremental review; the second forces a full review.
Reply to one of the bot's own inline findings to request a targeted reassessment
of that conversation. Incremental and targeted feedback does not pass the
required check; use a full review when you need a terminal decision. A new
head supersedes older queued or running work. Re-request a review after a
pre-post failure; inspect host comments first if the failure occurred after
posting began because the external outcome may be ambiguous.

## When a review does not appear

| Symptom | First things to check |
| --- | --- |
| Webhook rejected with 400 | Host webhook secret/signature, selected event, and (for GitLab) signing token and timestamp |
| Webhook accepted but no review | Allowlist, reviewer login or bot assignment, GitHub auto-review scope, and `ACR_REVIEW_ADMISSION_ENABLED` |
| Service fails at startup | Required host credentials, exact GitLab status-check map, model credential mode, gateway socket/profile if enabled |
| Review posts but check does not pass | `blocker` finding, incomplete finding publication, incremental/targeted coverage, `ACR_REVIEW_TERMINAL_SUCCESS_ENABLED`, or invalid `.acr.yml` |
| Review stops after restart | Inspect the SQLite record and logs; queued work needs a new request, and a post that had already begun can have an ambiguous external outcome |

The service assumes one process and one local SQLite database. Back up the
database and inspect an ambiguous review on the code host before requesting
another review; a retry cannot retract an already posted remote comment.
