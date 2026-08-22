# Verify and operate the reviewer

Use these checks after deployment and when diagnosing a failed review.

## Verify a deployment

Check all four layers:

1. Confirm that `https://YOUR_DOMAIN/health` returns `ok`.
2. Confirm that the GitHub App or GitLab webhook delivery receives HTTP 200.
3. Request the configured reviewer on an in-scope pull or merge request.
4. Confirm that the service posts a review and clears the request.

Expected startup output includes:

```text
Alátùńwò AI reviewer listening on :3000 (repo: github, ai: codex)
```

During a review, logs show the provider, effective execution budget, attempt number, remaining time, checkout mode, and final disposition. The service does not log prompts or credentials.

## Read application logs

For Compose, use the service name instead of a generated container name:

```bash
docker compose --env-file .env.production -f compose.production.yml logs -f --tail 200 app
```

Generated names can change across Compose versions and project directories.

For Kamal, run:

```bash
bin/kamal app logs --tail 200 -d production
```

## Reliability limits

- The service acknowledges webhooks before provider execution and processes reviews through a concurrency-one queue.
- SQLite reserves each repository, change number, and head SHA. Duplicate webhook deliveries do not post duplicate reviews.
- Failed reviews remain retryable. Request the reviewer again on the same commit.
- Pending rows left by a crash become failed at startup so they can be retried.
- GitHub falls back to a summary-only review if an inline comment cannot be anchored.
- The in-memory queue is unbounded. A burst increases memory and latency, and a restart loses queued work. This deployment suits personal and small-organization use, not a high-volume public service.
- Reviews use the selected AI account's normal subscription or API limits.

## Troubleshoot GitHub reviewer selection

The requested reviewer must be a normal GitHub user with repository access. Request `atunwo`, not `atunwo[bot]`. The App bot posts the result but cannot be the requested reviewer.

## Troubleshoot an ignored signed webhook

Confirm these values:

- The event is `pull_request` with action `review_requested`.
- `requested_reviewer.login` is listed in `REVIEWER_LOGIN`.
- The repository owner is in `GITHUB_ALLOWED_OWNERS`, or the exact `owner/repo` is in `GITHUB_ALLOWED_REPOSITORIES`.
- The App is installed on that repository.

Look for `ignored review request outside allowlist` in application logs.

## Troubleshoot webhook connectivity

Confirm that DNS resolves to the VM, HTTPS works outside the private network, and the webhook URL ends in the correct path:

- GitHub: `/api/github/webhooks`
- GitLab: `/api/gitlab/webhooks`

Tailscale-only access is not enough for GitHub.com or GitLab.com webhooks.

## Restore a Codex login

Compose must mount `./codex:/home/node/.codex`. Kamal must mount `CODEX_STATE_PATH:/home/node/.codex`. Confirm that the host directory is owned by UID and GID 1000, then repeat the container login command from the applicable deployment guide.

## Respond to a review timeout

The failure notice is expected, and the same commit stays retryable. Increase `REVIEW_TIMEOUT_SECONDS`, or increase only the selected provider override. Redeploy, then request the reviewer again. A provider override always wins over the global value.
