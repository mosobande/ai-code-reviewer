# Review workflow and follow-ups

The code host sends a signed webhook when the configured reviewer is requested,
or when an opted-in GitHub repository receives an eligible PR event. The
service verifies the webhook and allowlist, checks the live source head and
target, reads the target branch's `.acr.yml`, records a review generation in
SQLite, and then acknowledges the delivery. Model work runs in a one-at-a-time
background queue.

## First review and pushes

A new reviewer request starts a full review. It reads the current diff and,
by default, a temporary read-only checkout for surrounding context. The model
returns a summary and inline findings. The service posts feedback only for
the admitted head, updates its walkthrough comment, reconciles its own
approval, and updates the host check.

A push while the configured reviewer remains assigned requests an incremental
review of commits since the last recorded coverage. If the host cannot prove
a complete forward comparison at the current head, the service uses a full
review. On GitHub, a prior bot approval may clear the requested reviewer;
the service also recognizes that approved state for later pushes. A new head
supersedes queued or running work for the previous head. Webhook redeliveries
for the same request do not start duplicate reviews.

GitHub can enable automatic review per repository with target-branch
`review.automatic: true`, or through the legacy instance list
`GITHUB_AUTO_REVIEW_REPOSITORIES`. This covers open, reopen, ready-for-review,
and push events for ready human PRs. See [GitHub setup](github.md).

## Ask for another pass

The PR/MR author or a collaborator can post an exact top-level comment,
replacing `reviewer` with a configured GitHub `REVIEWER_LOGIN` or the GitLab
bot username:

```text
@reviewer review
@reviewer full review
```

The first asks for an incremental pass. The second forces a full pass. A new
reviewer request also runs a full review. Replying to one of this bot's own
inline findings requests a targeted reassessment of that conversation. The
bot resolves that finding when it determines the issue is fixed. An unrelated
comment or a reply to someone else's finding does not trigger a targeted pass.

## Read the result

| Result | Meaning |
| --- | --- |
| Passing check | A full review completed, all selected findings were published, no `blocker` finding remained, and terminal success was enabled. |
| Non-passing check after incremental or targeted pass | Feedback was posted, but a full review is still needed for a terminal decision. |
| Non-passing check after full pass | Review failed, a `blocker` remains, some findings could not be published, policy was invalid/unreadable, or terminal success is disabled. Inspect the check and logs. |
| Bot approval | The target branch policy selected `bot` and a clean full review completed. In `human` mode, a passing check does not grant bot approval. |

The bot removes its prior approval before reassessing a head. It never removes
another person's approval. GitHub posts a summary-only review if an invalid
inline comment causes the batch review to be rejected. GitLab posts comments
individually and can skip a rejected comment. Missing comments prevent a
passing check or bot approval. For policy details, see [`.acr.yml`](review-policy.md).

## Failure and restart boundaries

SQLite stores delivery identity, generation status, coverage, summary, error,
and timestamps. A failed review before posting can be retried with a new
request. A process restart marks queued or running pre-post work failed; it
does not silently resume it. Once posting has begun, the external result can
be ambiguous. Inspect the host's review and comments before re-requesting;
automatic replay could create duplicates. The queue is unbounded in memory,
and the local store assumes one reviewer instance. See
[deployment](deployment.md) for persistence and [troubleshooting](troubleshooting.md)
for common symptoms.
