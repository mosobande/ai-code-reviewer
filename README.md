# Alátùńwò AI Code Reviewer

A self-hosted webhook service that reviews pull and merge requests with Claude or Codex. Install the service across an account or organization, then request a designated reviewer on a change. The service retrieves the diff, runs the AI review, and posts inline comments.

Unlike a CI workflow, the reviewer does not require a configuration file in each repository. One service receives webhooks for every repository on which its GitHub App or GitLab integration is installed.

## How reviews work

```text
review requested
      |
      v
GitHub App or GitLab webhook -> verify -> scope check -> reserve head SHA -> queue
                                                                     |
                                                                     v
                                                        Claude CLI or Codex SDK
                                                                     |
                                                                     v
                                               post review -> record in SQLite
```

The identities have separate jobs:

- The GitHub App receives signed webhooks, reads repository contents, and posts the review as `<app-name>[bot]`.
- A normal GitHub account is the requested reviewer that triggers the service. A GitHub App bot cannot be selected as a pull-request reviewer. Use your account or a dedicated machine user such as `atunwo`.
- On GitLab, the project or group access token creates a bot user. That bot can be the reviewer or assignee and can post the review.
- Claude or Codex supplies the review result. The service does not pass repository credentials to the AI subprocess.

The service runs one instance and one provider execution at a time. Do not scale it to multiple replicas without replacing the in-process queue and local SQLite store.

## Choose a deployment path

Both paths run the same image and preserve the same application state.

| Choose | Build and delivery | TLS proxy | Application registry |
| --- | --- | --- | --- |
| [Docker Compose and Caddy](docs/deploy-compose.md) | Build on the server | Caddy | None |
| [Kamal and GHCR](docs/deploy-kamal.md) | Build on the server and push through GHCR | Kamal Proxy | GHCR and a package-write token |

Use Compose for one VM and the shortest setup. Use Kamal for registry-backed releases and Kamal's deployment lifecycle.

Production deployment requires a domain. Point an `A` record, such as `reviewer.example.com`, to the VM before you start the proxy. GitHub and GitLab must reach a public HTTPS webhook endpoint. Local development can run without a domain.

## Documentation

- [Configure GitHub, GitLab, Claude, Codex, deadlines, and deep reviews](docs/configuration.md)
- [Deploy with Docker Compose and Caddy](docs/deploy-compose.md)
- [Deploy with Kamal and GHCR](docs/deploy-kamal.md)
- [Verify, operate, and troubleshoot the reviewer](docs/operations.md)
- [Use the portable deployment skill](.agents/skills/deploy-ai-code-reviewer/SKILL.md)

## Local development

```bash
cp .env.example .env
npm install
npm test
npm run typecheck
npm start
```

Set a public webhook tunnel only for development. Do not put production credentials in a shared tunnel configuration.
