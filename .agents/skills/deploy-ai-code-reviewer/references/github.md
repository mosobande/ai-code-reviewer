# GitHub

Load this branch only for `REPO_PROVIDER=github`. Read the **Configure GitHub** section in the target repository's `docs/configuration.md` before acting.

## Identities and scope

Keep three identities separate:

- the GitHub App receives signed webhooks and posts reviews;
- a normal GitHub user is the requested reviewer that triggers the service; and
- the selected AI account executes the review.

Never request `<app-name>[bot]` as the reviewer. `REVIEWER_LOGIN` must name a normal user with repository access. A dedicated user needs neither owner nor write access.

The App installation controls repository API access. `GITHUB_ALLOWED_OWNERS` and `GITHUB_ALLOWED_REPOSITORIES` independently restrict runtime review scope. Require at least one runtime scope.

## External setup and proof

Treat App creation, permissions, event subscription, private-key generation, installation, user access, and webhook inspection as GitHub-console work. Guide these steps from `docs/configuration.md`; mutate them only with explicit authority.

Verify that an in-scope `pull_request.review_requested` delivery receives HTTP 200 and produces a review. HTTP 200 without a review can be correct for an unmatched event, action, reviewer, owner, or repository. Diagnose these fields separately without printing payloads or signatures.
