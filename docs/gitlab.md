# GitLab setup

Use this page when `REPO_PROVIDER=gitlab`. The service acts as the user behind
`GITLAB_TOKEN`; add that user as a merge request reviewer or assignee to request
a review. This implementation always updates a GitLab external status check,
which is a [GitLab Ultimate feature](https://docs.gitlab.com/api/status_checks/).

## Create the bot token and external check

Create a Project or Group access token with `api` and `read_repository` scopes.
Prefer the narrowest project scope that covers the changes you want reviewed.
Give the token's bot user at least the **Developer** role on every allowed
project. GitLab's [status-check API](https://docs.gitlab.com/api/status_checks/)
requires the responding user to have Developer, Maintainer, or Owner access
and the right to approve the MR. In `bot` approval mode, the user must also
be an [eligible approver](https://docs.gitlab.com/api/merge_request_approvals/)
under that project's approval rules; settings such as required re-authentication
can prevent automated approval. The service resolves its user ID through
`GET /user` when it starts, so there is no `REVIEWER_LOGIN` on GitLab.

Create an external status check in **each** allowed project and record its
numeric ID. List the same exact `namespace/project` paths in
`REPOSITORY_ALLOWED_REPOSITORIES` and as keys in
`GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON`. For example:

```dotenv
REPOSITORY_ALLOWED_REPOSITORIES=team/service-a,team/service-b
GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON='{"team/service-a":17,"team/service-b":29}'
```

The map must have one positive integer ID for every allowed project and no
extra projects. This check is required by the service even if you do not make
it a merge requirement in GitLab. An operator with project settings access
creates the check under **Settings → Merge requests → Status checks**. GitLab
shows it as a non-blocking widget by default; select **Status checks must
succeed** in the same settings if it should prevent merging. The
[status-check guide](https://docs.gitlab.com/user/project/merge_requests/status_checks/)
documents this switch. Creating a check is a separate host action; the
reviewer only sends responses to its configured ID.

## Create a signed webhook

On GitLab 19.1 or later, add a project or group webhook at
`https://YOUR_HOST/api/gitlab/webhooks`. Select **Merge request events** and
**Comment events**. Generate a **signing token** and set its `whsec_` value as
`GITLAB_WEBHOOK_SECRET`. This service verifies the signed body and a recent
timestamp. A legacy `X-Gitlab-Token` header by itself cannot authenticate to
this endpoint. See [GitLab signing tokens](https://docs.gitlab.com/user/project/integrations/webhooks/#signing-tokens).

Set `GITLAB_WEBHOOK_MAX_AGE_SECONDS` only when you need a different timestamp
window; it defaults to 300 and accepts an integer from 1 to 3600. Set
`GITLAB_API_URL` to the base URL of a self-managed instance; it defaults to
`https://gitlab.com`.

Creating a project webhook requires Maintainer or Owner access; a group
webhook requires Group Owner access. This is the operator's setup permission,
separate from the bot token's runtime role. GitLab's
[webhook guide](https://docs.gitlab.com/user/project/integrations/webhooks/)
documents these requirements.

## Configure and test the reviewer

The minimum host-specific settings are:

```dotenv
REPO_PROVIDER=gitlab
GITLAB_TOKEN=your-project-or-group-token
GITLAB_WEBHOOK_SECRET=whsec_your-signing-token
REPOSITORY_ALLOWED_REPOSITORIES=team/service-a
GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON='{"team/service-a":17}'
```

Start the service and confirm `GET /health` returns `ok`. Add the bot as a
reviewer or assignee to a merge request in an allowed project. Check the
webhook delivery, then confirm the review summary, inline discussions, and
external status check at the current source head. If you want the check to
block merging, select **Status checks must succeed**. Approval rules are
separate; see [repository policy](review-policy.md).

For pushes, commands, and finding replies, see the [review workflow](review-workflow.md).
