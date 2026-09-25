# Separate model gateway for reviews

The model gateway runs as its own process. It owns the reusable Claude or Codex
credential and proxies only the model operations the review clients use. The
review service asks over a Unix socket for one opaque, short-lived grant per
attempt, passes that grant to the model client, and revokes it afterward. A
trusted upstream `429` pauses that credential profile across later grants.

The gateway is optional. Without `MODEL_GATEWAY_SOCKET_PATH`, the reviewer keeps
its existing direct Claude or Codex authentication. Start with direct mode for
the shortest setup path; use the gateway when the reviewer process should not
hold a reusable provider credential or when several review attempts must share
one provider rate-limit cooldown.

## Gateway process

Install dependencies with `npm install`. Configure one of the provider rows
below in the **gateway process environment**, then run
`npx tsx runtime/model-gateway-main.ts` independently from `npm start`.
For example, a gateway serving Claude with an API key needs:

```sh
export MODEL_GATEWAY_ANTHROPIC_AUTH_MODE=api-key
export MODEL_GATEWAY_ANTHROPIC_PROFILE=review
export ANTHROPIC_API_KEY='your-key-from-a-secret-store'
npx tsx runtime/model-gateway-main.ts
```

The control socket defaults to `~/.acr/model-gateway.sock`; set the same
absolute `MODEL_GATEWAY_SOCKET_PATH` in both processes if you change it. The
default expands under the **gateway user's** home, so use an explicit shared
path when the processes run as different users. The
HTTP proxy defaults to `127.0.0.1:8080`. `MODEL_GATEWAY_HOST` and
`MODEL_GATEWAY_PORT` set its listening address. `MODEL_GATEWAY_PUBLIC_BASE_URL`
sets the address returned in grants, which the reviewer must be able to reach.
Changing that public URL does **not** change the bind address.

Choose one credential mode for each provider the gateway serves:

| Provider | Gateway environment |
| --- | --- |
| Claude OAuth | `MODEL_GATEWAY_ANTHROPIC_AUTH_MODE=oauth`, `MODEL_GATEWAY_ANTHROPIC_PROFILE=review`, `MODEL_GATEWAY_ANTHROPIC_OAUTH_TOKEN_FILE=/absolute/private/token-file` |
| Claude API key | `MODEL_GATEWAY_ANTHROPIC_AUTH_MODE=api-key`, `MODEL_GATEWAY_ANTHROPIC_PROFILE=review`, `ANTHROPIC_API_KEY=...` |
| Codex OAuth | `MODEL_GATEWAY_OPENAI_AUTH_MODE=oauth`, `MODEL_GATEWAY_OPENAI_PROFILE=review`, `MODEL_GATEWAY_OPENAI_CODEX_HOME=/absolute/codex/home` |
| OpenAI API key | `MODEL_GATEWAY_OPENAI_AUTH_MODE=api-key`, `MODEL_GATEWAY_OPENAI_PROFILE=review`, `OPENAI_API_KEY=...` |

Set only the rows you intend to serve; the gateway needs at least one provider.
The profile is a name for one configured credential. Use the same name in the
reviewer configuration; it is not a provider model name. Do not mix API key and
OAuth settings for one provider.

The Claude OAuth token file and Codex `auth.json` must be regular private files
owned by the gateway user, with no group or world permissions.
The Codex home must contain a valid Codex CLI login and the installed Codex
version must match the gateway's pinned `0.142.4` version. Keep reusable
credentials visible only to the gateway process.

For stronger isolation, run the gateway as a different Unix user. Place the
socket in a gateway-owned directory with no world access or group-write access.
The gateway sets socket mode `0660`. Give the reviewer user a shared group that
can traverse the directory and connect to the socket. Preprovision the directory
with that group and its setgid bit so the new socket inherits the group. The
gateway checks directory ownership and permissions at startup. The Unix socket
must be on the same host or a shared mount visible to both processes; it is not
a network socket.

## Review service

Set `MODEL_GATEWAY_SOCKET_PATH` and the matching
`MODEL_GATEWAY_ANTHROPIC_PROFILE` or `MODEL_GATEWAY_OPENAI_PROFILE` in the review
service environment. For the example above, set `AI_PROVIDER=claude`,
`MODEL_GATEWAY_SOCKET_PATH` to the gateway socket, and
`MODEL_GATEWAY_ANTHROPIC_PROFILE=review`. Start the reviewer with a separate
environment that has the host credentials but none of the gateway's reusable
model credentials. In particular, do not supply `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `CODEX_HOME` to
the reviewer process. The
service checks gateway capabilities at startup and fails if its selected
provider and profile are unavailable. The gateway process can be restarted
independently; a restart invalidates outstanding attempt grants, so an active
review attempt may fail and be retried through the usual review path.

If the reviewer runs in another container, mount the control socket directory
into it. The reviewer must also reach the HTTP proxy URL returned by the
gateway. If loopback is not shared, bind the proxy with `MODEL_GATEWAY_HOST` to
an interface on a private network and set `MODEL_GATEWAY_PUBLIC_BASE_URL` to
the address reachable from the reviewer. Keep this proxy off the public
Internet. The gateway also needs outbound access to the provider API. The
existing [Kamal config](../config/deploy.yml) passes reviewer gateway settings
but does not provision a gateway process, shared mount, or private network;
arrange those before enabling gateway mode in a container deployment. The
gateway does not run builders or jobs.
