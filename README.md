# Alátùńwò AI Code Reviewer

A self-hosted webhook service that reviews GitHub pull requests or GitLab merge
requests with Claude or Codex. It reads the change, posts a summary and inline
findings, and updates a check for the current source head. Repositories can
choose approval, automatic GitHub review, and context depth in a target-branch
`.acr.yml` file.

The service runs one code host and one model provider per instance. It admits
only explicitly allowed repositories. Model credentials can stay in the
reviewer or live in a separate, optional `.acr` gateway process.

## Start here

Follow the [getting-started path](docs/setup-and-deployment.md) to choose a
host and model, configure credentials, run the service, and verify a first
review. Use [.env.example](.env.example) for a manual host or
[.env.production.example](.env.production.example) for Kamal.

| Need | Guide |
| --- | --- |
| Create a GitHub App, set permissions and repository scopes | [GitHub setup](docs/github.md) |
| Configure a GitLab bot, signed webhook and external checks | [GitLab setup](docs/gitlab.md) |
| Choose Claude or Codex auth, context and time budgets | [Model providers](docs/model-providers.md) |
| Keep model credentials in a separate process | [Model gateway](docs/model-gateway.md) |
| Set `.acr.yml`, checks and approval behavior | [Repository policy](docs/review-policy.md) |
| Look up every YAML key and environment setting | [Configuration reference](docs/configuration-reference.md) |
| Understand pushes, commands, finding replies and retries | [Review workflow](docs/review-workflow.md) |
| Run locally or deploy with Kamal | [Deployment](docs/deployment.md) |
| Diagnose missing reviews and non-passing checks | [Troubleshooting](docs/troubleshooting.md) |

## Review at a glance

```text
Signed host webhook → verify repository and live head → store a review generation
                    → read diff and optional read-only checkout
                    → run Claude or Codex → post findings
                    → reconcile check and bot-owned approval
```

Request a configured GitHub login as reviewer, assign the GitLab bot to an
MR, or opt an exact GitHub repository into automatic review. A push can review
the newly uncovered range; an exact `@reviewer full review` comment forces a
full pass. A clean full review can pass the check. Whether the bot also approves
comes from the target branch's `.acr.yml` or the instance default of `human`.
See the [workflow](docs/review-workflow.md) and [policy](docs/review-policy.md)
for the exact conditions.

The included deployment assumes one reviewer instance with a persistent
SQLite database. A restart makes queued work retryable by a new request; a
crash after posting begins may need manual inspection before retrying. See
[deployment](docs/deployment.md) and [troubleshooting](docs/troubleshooting.md).
