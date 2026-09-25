# Configuration reference

The reviewer reads instance settings from environment variables. Use
[`.env.example`](../.env.example) for a manual process or
[`.env.production.example`](../.env.production.example) with Kamal. Set one
repository provider and one AI provider per instance. Values in `.acr.yml`
are a separate, narrower repository policy described below; they cannot
provide credentials or change host permissions.

## Repository policy: `.acr.yml`

This is the **entire** supported repository YAML schema:

```yaml
version: 2
review:
  approval: human # or bot
  automatic: false # GitHub only; true enables eligible PR event reviews
  depth: contextual # or diff-only; omit for instance and label behavior
```

Place it at the repository root on the **target branch**. `version: 2` and
`review` are required; all three review keys are optional. `approval` inherits
`ACR_APPROVAL_MODE` (`human` by default); `automatic` defaults to `false`, and
`depth` inherits `DEEP_REVIEW` plus the `deep-review` label. An absent file
uses those defaults. `approval` accepts `human` or `bot`; `automatic` must be
a YAML boolean; `depth` accepts `contextual` or `diff-only`. Unknown fields,
including `builder`, `jobs`, model, and command settings, are invalid.
The file is capped at 16 KiB and is parsed strictly. See the
[policy guide](review-policy.md) for the decision and failure behavior.

The `temi` v2 policy also contained `builder.enabled` and
`builder.verification_profile`. They control build work and are intentionally
excluded here. `review.approval` was its only review-specific YAML key.
`automatic` and `depth` are review-only additions here.

## Code host settings

| Setting | Default | Requirement and purpose |
| --- | --- | --- |
| `REPO_PROVIDER` | `github` | Select `github` or `gitlab`; one host per process. |
| `GITHUB_APP_ID` | none | Required for GitHub App authentication. |
| `GITHUB_APP_PRIVATE_KEY` | none | Required PEM or base64-encoded PEM for the App. |
| `GITHUB_WEBHOOK_SECRET` | none | Required to verify GitHub webhook signatures. |
| `REVIEWER_LOGIN` | none | Required GitHub login or comma-separated logins that can be requested for review. |
| `GITHUB_ALLOWED_OWNERS` | empty | Owner allowlist; at least this or exact repositories must have an entry. |
| `GITHUB_ALLOWED_REPOSITORIES` | empty | Exact `owner/repo` allowlist; supplements owner entries. |
| `GITHUB_AUTO_REVIEW_REPOSITORIES` | empty | Legacy instance-level exact `owner/repo` automatic review entries. A target-branch `.acr.yml` can instead set `review.automatic: true` for an already allowed repository. |
| `GITLAB_TOKEN` | none | Required Project or Group token for the GitLab bot. |
| `GITLAB_WEBHOOK_SECRET` | none | Required `whsec_` signing token, not `X-Gitlab-Token`. |
| `REPOSITORY_ALLOWED_REPOSITORIES` | empty | Required comma-separated exact GitLab `namespace/project` paths. |
| `GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON` | none | Required JSON object mapping every allowed GitLab project to its positive numeric check ID, with no extras. |
| `GITLAB_API_URL` | `https://gitlab.com` | Base URL for self-managed GitLab; omit `/api/v4`. |
| `GITLAB_WEBHOOK_MAX_AGE_SECONDS` | `300` | Signed delivery timestamp tolerance, integer 1–3600. |

See [GitHub setup](github.md) and [GitLab setup](gitlab.md) for current
permission and event requirements. Host settings for the unselected provider
are ignored by the selected implementation; keep unused secrets unset.

## Model settings

| Setting | Default | Requirement and purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `claude` | Select `claude` or `codex`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | Direct Claude subscription token; omit in gateway mode. |
| `CLAUDE_MODEL` | provider default | Override the Claude model. |
| `CODEX_API_KEY` | none | Direct Codex API key; takes precedence over `CODEX_ACCESS_TOKEN`. |
| `CODEX_ACCESS_TOKEN` | none | Direct Codex access token. |
| `CODEX_HOME` | Codex default home | Optional existing direct-mode Codex login/config directory. |
| `CODEX_MODEL` | Codex configured default | Override the Codex model. |
| `CODEX_REASONING_EFFORT` | Codex configured default | `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `CODEX_WEB_SEARCH_MODE` | Codex default; Kamal sets `disabled` | `disabled`, `cached`, or `live`. |
| `CODEX_BASE_URL` | Codex default | Alternate API base URL in direct mode. |
| `MODEL_GATEWAY_SOCKET_PATH` | unset | Enable gateway mode using an absolute Unix control socket path. |
| `MODEL_GATEWAY_ANTHROPIC_PROFILE` | none | Required matching profile when Claude uses the gateway. |
| `MODEL_GATEWAY_OPENAI_PROFILE` | none | Required matching profile when Codex uses the gateway. |

In Claude direct mode, `ANTHROPIC_API_KEY` is rejected because it could
override subscription auth. In gateway mode, reusable model credentials must
be absent from the reviewer environment. `CODEX_PROFILE` is unsupported.
See [model providers](model-providers.md) and [model gateway](model-gateway.md).

## Review behavior and process

| Setting | Default | Purpose |
| --- | --- | --- |
| `ACR_APPROVAL_MODE` | `human` | Instance approval default; target-branch `.acr.yml` can override it. |
| `ACR_REVIEW_ADMISSION_ENABLED` | `true` | `false` or empty acknowledges matching webhooks without recording new work. |
| `ACR_REVIEW_TERMINAL_SUCCESS_ENABLED` | `true` | `false` or empty lets reviews post but prevents a passing check or bot approval. |
| `DEEP_REVIEW` | `true` | Default read-only checkout context; `false` uses diff only unless the change has the `deep-review` label. Explicit repository `review.depth` overrides both. |
| `DEEP_REVIEW_MAX_TURNS` | `8` | Positive turn budget for contextual reviews. |
| `REVIEW_TIMEOUT_SECONDS` | `1800` | Positive shared wall-clock seconds for an attempt and its retry. |
| `CLAUDE_TIMEOUT_SECONDS` | inherits global | Claude-specific positive timeout override. |
| `CODEX_TIMEOUT_SECONDS` | inherits global | Codex-specific positive timeout override. |
| `BOT_NAME` | `Alátùńwò AI` | Display name in the review header. |
| `DATABASE_PATH` | `./data/reviews.db` | SQLite generation and delivery history; use persistent storage. |
| `PORT` | `3000` | HTTP listener port. |

The two `ACR_REVIEW_*` gates accept literal `true` or `false`; an empty value
also means false. Other values fail startup. See [policy](review-policy.md),
[workflow](review-workflow.md), and [deployment](deployment.md) before changing
them on a live service.

## Gateway process settings

These settings belong to the **standalone gateway process**, not the
reviewer, except for `MODEL_GATEWAY_SOCKET_PATH` and the selected provider
profile, which both processes must agree on:

| Setting | Default | Purpose |
| --- | --- | --- |
| `MODEL_GATEWAY_SOCKET_PATH` | `~/.acr/model-gateway.sock` | Absolute Unix control socket path. |
| `MODEL_GATEWAY_HOST` | `127.0.0.1` | HTTP model proxy bind address. |
| `MODEL_GATEWAY_PORT` | `8080` | HTTP model proxy port. |
| `MODEL_GATEWAY_PUBLIC_BASE_URL` | `http://127.0.0.1:<port>` | Proxy URL returned to the reviewer in attempt grants. |
| `MODEL_GATEWAY_ANTHROPIC_AUTH_MODE` | none | `oauth` or `api-key` for Claude. |
| `MODEL_GATEWAY_ANTHROPIC_PROFILE` | none | Stable name for the Claude gateway credential. |
| `MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE` | none | Private token file in Claude OAuth mode. |
| `ANTHROPIC_API_KEY` | none | Gateway-owned Claude API key in API-key mode. |
| `MODEL_GATEWAY_OPENAI_AUTH_MODE` | none | `oauth` or `api-key` for Codex. |
| `MODEL_GATEWAY_OPENAI_PROFILE` | none | Stable name for the Codex gateway credential. |
| `MODEL_GATEWAY_OPENAI_CODEX_HOME` | none | Private Codex home with `auth.json` in OAuth mode. |
| `OPENAI_API_KEY` | none | Gateway-owned OpenAI API key in API-key mode. |
| `MODEL_GATEWAY_CODEX_BINARY_PATH` | installed `node_modules/.bin/codex` | Optional override for the pinned Codex auth companion. |

The gateway requires at least one complete provider credential configuration.
Its socket and proxy must both be reachable from the reviewer. Setting the
public URL alone does not change the proxy bind address. Follow the
[gateway guide](model-gateway.md) for private file modes, cross-user socket
access, and separate-container networking.

## Kamal-only settings

The [deployment guide](deployment.md) covers `IMAGE`,
`KAMAL_REGISTRY_USERNAME`, `KAMAL_REGISTRY_PASSWORD`, `WEB_HOSTS`, `PROXY_HOST`,
and `SSH_USER`. These are read by the deployment wrapper/configuration rather
than the review process. The included config fixes `DATABASE_PATH` to
`/data/reviews.db` and `PORT` to `3000` in the container.
