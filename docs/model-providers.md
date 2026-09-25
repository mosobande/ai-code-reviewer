# Model provider setup

Set `AI_PROVIDER=claude` (the default) or `AI_PROVIDER=codex`. One provider runs
per reviewer instance. In direct mode, the reviewer receives the model
credential. To keep that reusable credential in a separate process, follow
the [model gateway guide](model-gateway.md) instead.

## Claude direct mode

The service invokes the Claude Code CLI. The included Docker image installs
it; install it yourself on a non-container host:

```sh
npm i -g @anthropic-ai/claude-code
claude setup-token
```

Complete the token flow on a machine with a browser, then set
`CLAUDE_CODE_OAUTH_TOKEN` in the reviewer environment. For a browserless host,
generate the token on your laptop and transfer it through your secret manager.
Do not set `ANTHROPIC_API_KEY` in Claude direct mode: the provider rejects it
to avoid switching this path to API-key billing. Set `CLAUDE_MODEL` to override
the default model. Claude's contextual review uses only `Read`, `Grep`, and
`Glob` tools; diff-only review uses one pass.

## Codex direct mode

The production `@openai/codex-sdk` dependency supplies the Codex runtime; a
separate global binary is not needed for the reviewer. Set one of these auth
sources:

1. `CODEX_API_KEY` for API-key automation. It takes precedence when set.
2. `CODEX_ACCESS_TOKEN` for an access-token flow.
3. `CODEX_HOME` pointing to existing Codex CLI auth/config.
4. The runtime's default `~/.codex` login when none of the above is set.

For a persistent CLI home, log in on the host with `codex login`. The reviewer
does not accept `CODEX_PROFILE`; use the supported settings below. In gateway
mode the reviewer must receive none of these reusable credentials or `CODEX_HOME`.

| Setting | Purpose |
| --- | --- |
| `CODEX_MODEL` | Override the review model |
| `CODEX_REASONING_EFFORT` | `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `CODEX_WEB_SEARCH_MODE` | `disabled`, `cached`, or `live`; Kamal defaults to `disabled` |
| `CODEX_BASE_URL` | Alternate OpenAI-compatible API base URL in direct mode |

The Codex thread uses a read-only sandbox and never asks for approval to run
commands. The SDK subprocess receives only selected infrastructure and Codex
variables, not the code-host token or Claude credential.

## Context, time budget, and model output

`DEEP_REVIEW=true` (default) checks out the admitted source head and lets the
provider read surrounding files. Set `DEEP_REVIEW=false` for a diff-only pass;
the `deep-review` label still opts an individual PR/MR into context. Deep
reviews need `git` and repository contents access. The checkout is temporary,
read-only to the model, and removed afterward. `DEEP_REVIEW_MAX_TURNS` defaults
to 8; diff-only reviews use one pass.

`REVIEW_TIMEOUT_SECONDS` defaults to 1800 and is a shared wall-clock budget for
the initial attempt and its one automatic retry. `CLAUDE_TIMEOUT_SECONDS` or
`CODEX_TIMEOUT_SECONDS` overrides the global value for the selected provider.
Values must be positive integers; zero does not disable the deadline. A
timeout or caller cancellation is not retried.

The model must return a structured summary and findings with path, line,
severity (`blocker`, `warn`, or `info`), and explanation. The prompt evaluates
correctness, edge cases, security, performance, API contracts, tests, and
maintainability, while skipping formatting a linter can enforce. The PR/MR
title and description are supplied as untrusted context. Invalid model output
is not published as a review.
