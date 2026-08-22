# GitLab

Load this branch only for `REPO_PROVIDER=gitlab`. Read the **Configure GitLab** section in the target repository's `docs/configuration.md` before acting.

## Identity and scope

The project or group access token creates the bot identity, authorizes repository access, and determines scope. Prefer a project token for one repository. Use a group token only for intended group-wide access.

The bot triggers a review when added as a reviewer, or as an assignee on a GitLab tier without review requests. GitHub reviewer and allowlist variables do not define GitLab scope.

## External setup and proof

Treat token creation, bot membership, and webhook creation as GitLab-console work. Guide these steps from `docs/configuration.md`; mutate them only with explicit authority. Confirm `GITLAB_API_URL` before starting against self-managed GitLab.

Verify the webhook secret without printing it. Require one supported merge-request delivery, resolved bot identity, and posted review. Diagnose token scope, membership, event selection, API URL, and reviewer or assignee matching separately.
