# Separate model gateway for reviews

The model gateway runs as its own process. It owns the reusable Claude or Codex
credential and proxies only the model operations the review clients use. The
review service asks over a Unix socket for one opaque, short-lived grant per
attempt, passes that grant to the model client, and revokes it afterward. A
trusted upstream `429` pauses that credential profile across later grants.

The gateway is optional. Without `MODEL_GATEWAY_SOCKET_PATH`, the reviewer keeps
its existing direct Claude or Codex authentication.

## Gateway process

Install dependencies with `npm install`. Run the gateway independently with
`npx tsx runtime/model-gateway-main.ts`. Its HTTP proxy binds to
`127.0.0.1:8080` by default. Set `MODEL_GATEWAY_PUBLIC_BASE_URL` if the reviewer
reaches the proxy at a different address. Set `MODEL_GATEWAY_SOCKET_PATH` in
both processes to the same absolute socket path; the default is
`~/.acr/model-gateway.sock`.

Choose one credential mode for each provider the gateway serves:

| Provider | Gateway environment |
| --- | --- |
| Claude OAuth | `MODEL_GATEWAY_ANTHROPIC_AUTH_MODE=oauth`, `MODEL_GATEWAY_ANTHROPIC_PROFILE=review`, `MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE=/absolute/private/token-file` |
| Claude API key | `MODEL_GATEWAY_ANTHROPIC_AUTH_MODE=api-key`, `MODEL_GATEWAY_ANTHROPIC_PROFILE=review`, `ANTHROPIC_API_KEY=...` |
| Codex OAuth | `MODEL_GATEWAY_OPENAI_AUTH_MODE=oauth`, `MODEL_GATEWAY_OPENAI_PROFILE=review`, `MODEL_GATEWAY_OPENAI_CODEX_HOME=/absolute/codex/home` |
| OpenAI API key | `MODEL_GATEWAY_OPENAI_AUTH_MODE=api-key`, `MODEL_GATEWAY_OPENAI_PROFILE=review`, `OPENAI_API_KEY=...` |

The Claude OAuth token file and Codex `auth.json` must be regular private files.
The Codex home must contain a valid Codex CLI login and the installed Codex
version must match the gateway's pinned version. Keep reusable credentials
visible only to the gateway process. For stronger isolation, run it as a
different Unix user and share only the control socket with the reviewer. The
socket directory must be gateway-owned, inaccessible to other users, and not
writable by its group; the socket itself is mode `0660`.

## Review service

Set `MODEL_GATEWAY_SOCKET_PATH` and the matching
`MODEL_GATEWAY_ANTHROPIC_PROFILE` or `MODEL_GATEWAY_OPENAI_PROFILE` in the review
service environment. Do not supply `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `CODEX_HOME` to that process. The
service checks gateway capabilities at startup and fails if its selected
provider and profile are unavailable. The gateway process can be restarted
independently; a restart invalidates outstanding attempt grants, so an active
review attempt may fail and be retried through the usual review path.

The gateway process and HTTP proxy need a reachable network path between the
reviewer and the provider API. The gateway does not run builders or jobs.
