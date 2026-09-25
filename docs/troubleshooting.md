# Troubleshoot reviews

Start with the service logs, the code host's webhook delivery record, and the
check on the current PR/MR head. `GET /health` confirms only that the HTTP
process is listening. For the included deployment, read logs with
`bin/kamal app logs -d production`.

| Symptom | Check |
| --- | --- |
| Service fails to start | Required GitHub App or GitLab token values, host allowlist, GitLab external-check map, selected model credentials, and gateway socket/profile if configured |
| Webhook returns 400 | GitHub webhook secret or GitLab signing token, delivery event and payload, and GitLab timestamp window |
| Webhook returns 503 | Live-head admission or policy read failed before durable acceptance; inspect logs and allow the host to retry the delivery |
| Webhook returns 200 but no review starts | Repository allowlist, requested GitHub login or GitLab bot assignment, target-branch `review.automatic` or the GitHub automatic-review list, and `ACR_REVIEW_ADMISSION_ENABLED` |
| Review starts but model attempt fails | Provider credentials, CLI/SDK availability, timeout, gateway capabilities/profile, and model API connectivity |
| Review posts but check stays non-passing | `blocker` finding, incomplete finding publication, incremental/targeted pass, `ACR_REVIEW_TERMINAL_SUCCESS_ENABLED`, or invalid `.acr.yml` |
| Review does not resume after restart | Re-request pre-post work; inspect host comments first if posting had begun |

## Check whether the trigger is in scope

For GitHub, the App must be installed on the repository, the repository must
match `GITHUB_ALLOWED_OWNERS` or `GITHUB_ALLOWED_REPOSITORIES`, and an event
must request a configured `REVIEWER_LOGIN`, have target-branch
`review.automatic: true`, or match an exact
`GITHUB_AUTO_REVIEW_REPOSITORIES` entry. Automatic review ignores drafts and
bot-authored PRs. Exact top-level review commands require the PR author or a
collaborator. For GitLab, the project path must be in
`REPOSITORY_ALLOWED_REPOSITORIES`, the bot token must belong to the assigned
reviewer/assignee, and its external status check ID must be configured.

If `ACR_REVIEW_ADMISSION_ENABLED=false` or empty, the service acknowledges a
matching webhook without storing or running a review. Those requests are not
queued for later. Re-enable admission and issue a new trigger.

## Check policy and completion

`.acr.yml` is read from the target branch commit, not the PR/MR source branch.
An invalid or unreadable file fails closed. Confirm `version: 2`, a `review`
mapping, and optional `approval`, `automatic`, and `depth` values. See the
[policy guide](review-policy.md) for rejected YAML forms and precedence.

A passing check requires a complete full review, no `blocker` finding, all
selected findings published, and terminal success enabled. `warn` and `info`
do not block it. If `ACR_REVIEW_TERMINAL_SUCCESS_ENABLED=false` or empty, the
service still posts feedback but cannot pass the check or grant bot approval.
After an incremental or targeted pass, request `@reviewer full review` for a
terminal decision. The host's own merge rules determine whether the check
and approval block merging.

## Retry safely

If work failed before posting, a new reviewer request or full-review command
can retry it. If posting had begun, the service cannot know from a crash
whether the host accepted a comment or review. Inspect the PR/MR activity and
the stored generation/log error before requesting another pass. Automatic
replay across that boundary is deliberately absent because it could duplicate
remote effects. SQLite should be on a persistent volume, and only one reviewer
instance should use it. See [deployment](deployment.md) and the
[workflow](review-workflow.md).
