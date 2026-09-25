# Repository review policy

The reviewer reports an exact-head check on each admitted pull or merge request.
Its approval decision is separate: by default, a person still approves the change.
Use `.acr.yml` to choose approval, GitHub automatic review, and context depth
per repository. The file does not opt a repository into the service or grant it access;
the host allowlist and installation/token permissions still control that.

## Configure a repository

Copy [`.acr.yml.example`](../.acr.yml.example) to `.acr.yml` in the root of the
repository you want reviewed, then merge it into the **target branch**:

```yaml
version: 2
review:
  approval: human
  automatic: false
  depth: contextual
```

| `review.approval` | Effect after a clean full review |
| --- | --- |
| `human` | The check can pass, but the reviewer bot does not approve. Require a human approval in the host's branch or merge rules if you want one. |
| `bot` | The check can pass and the reviewer bot grants its own approval. Configure the host's approval rule to count that bot if you want its approval to satisfy the rule. |

| Key | Values | Effect |
| --- | --- | --- |
| `review.automatic` | `true`, `false` | On GitHub, `true` reviews eligible ready, human-authored PRs when opened, reopened, marked ready, or pushed, without a reviewer request. `false` is the default. Existing `GITHUB_AUTO_REVIEW_REPOSITORIES` entries still trigger automatic reviews independently. GitLab ignores this key because its webhook path uses reviewer or assignee requests. |
| `review.depth` | `contextual`, `diff-only` | `contextual` checks out the source head read-only for surrounding file context; `diff-only` sends the patch without a checkout. Omit to use `DEEP_REVIEW` and the `deep-review` label. Targeted finding replies always use context. |

`human` is the instance default. You can set `ACR_APPROVAL_MODE=bot` on the
service to make `bot` the default instead. An absent `.acr.yml`, or a file with
`review: {}` and no `approval`, uses that instance value. An explicit value in
`.acr.yml` wins for that repository. The bot reconciles only its own approval;
it does not remove a person's approval.

The service reads the file at the exact target branch commit observed for the
review. A change to `.acr.yml` in the source branch cannot change policy for
that same pull or merge request. To change policy, merge it into the target
branch first and request another review. An invalid or incompletely read file
stops review work and produces a failing check; it does not silently fall back
to the instance default. Only `version: 2` and the `review` mapping are
supported. `review.approval` accepts `human` or `bot`. Unknown or duplicate keys,
aliases, anchors, invalid YAML, unsupported versions, and files over 16 KiB are
rejected. Builder, job, and maintenance settings are outside this schema.
This is the complete `.acr.yml` schema in the review-only service. The
`temi` policy's other section was `builder`, which is intentionally excluded.
`automatic` and `depth` are new review-only controls. Model choice, deadlines,
credentials, and rollout gates are instance environment settings; see the
[configuration reference](configuration-reference.md).

## Understand the check and approval

A **full** review can pass the exact-head check when it publishes all findings
and has no `blocker` finding. `warn` and `info` findings do not block the check.
An incremental review after a push, or a targeted reply to a finding, posts
feedback but leaves the check non-passing until a full review completes. The
same clean-full rule controls bot approval when `review.approval: bot` is in
effect. At the start of a new review, the service removes its prior approval so
an old decision cannot stand while the new head is being assessed.

Configure the host's required check and approval rule independently. A passing
review check does not itself supply a human approval. On GitHub, require the
reviewer's Check Run in the branch rules if it should block merges. On GitLab,
configure an external status check for every allowed project; the service
requires its ID even if you do not make that check a merge requirement. GitLab
external status checks are an [Ultimate feature](https://docs.gitlab.com/api/status_checks/).

## Operator controls

These instance settings are for service operators, not `.acr.yml`:

| Setting | Default | Effect when `false` |
| --- | --- | --- |
| `ACR_REVIEW_ADMISSION_ENABLED` | `true` | A valid review webhook is acknowledged without recording or running a new review. Re-enable it before expecting new requests; requests received while disabled are not queued. |
| `ACR_REVIEW_TERMINAL_SUCCESS_ENABLED` | `true` | Reviews still run and post feedback, but their check is non-passing and the bot does not grant approval. |

Both gates accept `true` or `false`; an empty value also disables the gate.
They are useful during a rollout:
start with human approval, confirm the check and comments on a test change,
then enable bot approval only where the host rules and operator intent permit
it. Turning admission off does not erase already posted reviews or approvals.
