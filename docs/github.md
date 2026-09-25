# GitHub App setup

Use this page when `REPO_PROVIDER=github` (the default). The service receives
signed GitHub App webhooks and posts reviews as the App installation. GitHub
does not let a custom App be requested as a reviewer in the same way as a
person. Set `REVIEWER_LOGIN` to your own login or a dedicated account that
people can request; the App still posts under its own identity.

## Create and install the App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
If all reviewed repositories belong to one account or organization, keep the
App installable only there. If installations across accounts are necessary,
use GitHub's wider installation setting and keep this service's allowlist
strict. Install the App only on repositories you intend to review. Set its webhook URL to
`https://YOUR_HOST/api/github/webhooks` and generate a webhook secret.

Give the App these repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Pull requests | Read & write | Read PRs, post reviews, reconcile the App's approval and review threads |
| Contents | Read-only | Read target-branch `.acr.yml` and clone source heads for contextual review |
| Checks | Read & write | Publish the `Alátùńwò review` Check Run at the source head |
| Issues | Read & write | Read review commands and maintain the walkthrough comment |
| Metadata | Read-only | Read repository metadata |

Subscribe to **Pull request**, **Issue comment**, and **Pull request review
comment** events. Save the App ID and generated private key after registration.
GitHub's [App permissions guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
explains how permissions control API calls and webhook availability.

The migration includes the API calls for reviews, check runs, comments,
approval reconciliation, and read-only contents access. It cannot change an
existing App's granted permissions for you. After editing the App's permission
set, each installation owner must approve the new permissions before the
installation token can use them. Contents write is unnecessary for this
review-only service.

## Configure the reviewer

Set these in `.env` for a local process or `.env.production` for the included
Kamal deployment:

```dotenv
REPO_PROVIDER=github
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-random-webhook-secret
REVIEWER_LOGIN=your-github-login
GITHUB_ALLOWED_REPOSITORIES=your-org/service-a,your-org/service-b
```

The private key also accepts a base64-encoded PEM, which is easier to pass
through several deployment environment layers. See
[`.env.production.example`](../.env.production.example). Never commit real
credentials.

`REVIEWER_LOGIN` accepts one login or a comma-separated list. At least one of
`GITHUB_ALLOWED_OWNERS` and `GITHUB_ALLOWED_REPOSITORIES` must be nonempty.
The owner list admits every installed repository under each named owner; the
repository list admits exact `owner/repo` entries. The App installation scope
and the service allowlist both apply. Use exact entries for a narrow rollout.

The login in `REVIEWER_LOGIN` must be a requestable person or machine account
with **read** access to the repository. The person requesting that review
needs **write** access to use GitHub's reviewer picker. Those are account
permissions, separate from the GitHub App installation permissions. GitHub's
[review request guide](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review)
documents both requirements.

`GITHUB_AUTO_REVIEW_REPOSITORIES` is a separate exact `owner/repo` list. Each
entry must already be allowed. When set, a ready, open, human-authored PR in
that repository can trigger a review on open, reopen, ready-for-review, or
push without someone requesting `REVIEWER_LOGIN`. To enable this from the
repository instead, put `review.automatic: true` in the target branch's
`.acr.yml`; no server restart is needed. The App must still be installed and
the repository must still be allowed by this instance. An explicit reviewer
request also works when automatic review is off. Draft PRs and bot-authored
PRs are not automatically reviewed. An instance-level automatic list continues
to trigger reviews even when the YAML says `automatic: false`; remove that
entry to hand control to `.acr.yml`.

## Test a review

1. Start the service and confirm `GET /health` returns `ok`.
2. Open a ready PR in an installed and allowed repository. Request a login in
   `REVIEWER_LOGIN`, or use an automatic-review repository.
3. Check the GitHub App webhook delivery for a successful response. The service
   records the request before returning success and performs the review in the
   background.
4. Confirm a review, walkthrough comment, and `Alátùńwò review` Check Run at
   the current head. Require that check in branch rules only after confirming
   the behavior you want. Configure approval rules separately; a passing check
   does not itself provide human approval.

For pushes, comments, and finding replies, see the [review workflow](review-workflow.md).
For a per-repository bot approval decision, see [`.acr.yml` policy](review-policy.md).
