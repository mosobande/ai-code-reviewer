---
name: deploy-ai-code-reviewer
description: Deploy, update, or verify one Alátùńwò AI Code Reviewer instance on a named server through Docker Compose/Caddy or Kamal/GHCR. Use for GitHub or GitLab integration, reviewer identity, Claude or Codex authentication, persistent state, and end-to-end webhook proof. Exclude feature development and AI-provider implementation.
---

# Deploy AI Code Reviewer

Own one server deployment from an exact source commit through operational proof. The target repository's `README.md`, `docs/`, environment examples, and deployment files own current commands and configuration. This skill owns routing, authority, safety, proof, and handoff.

## Route the request

Pin these inputs before changing a host:

- operation: `deploy`, `update`, or read-only `verify`;
- repository URL and requested branch or commit;
- host, SSH user, installation path, and public domain;
- repository provider: `github` or `gitlab`;
- AI provider: `claude` or `codex`;
- deployment path: `compose` or `kamal`;
- reviewer identity and GitHub runtime scope when applicable; and
- existing credential and provider-login state.

Resolve a branch through its remote to an immutable commit SHA. Keep that SHA fixed for the operation. Do not infer a host, domain, account, scope, identity, or secret.

Load one repository-provider reference and one deployment reference:

- GitHub: [references/github.md](references/github.md)
- GitLab: [references/gitlab.md](references/gitlab.md)
- Compose/Caddy: [references/compose.md](references/compose.md)
- Kamal/GHCR: [references/kamal.md](references/kamal.md)

Load both branches of one kind only to compare them or verify both at the user's request.

## Respect authority and state

- Never print, commit, or return a private key, token, webhook secret, registry password, provider credential, or complete production environment file.
- Treat DNS, firewalls, provider consoles, registries, organization membership, App installation, and user creation as separate authority boundaries. Guide and verify user-owned work unless the request explicitly includes the mutation.
- Preserve unrelated Git changes and existing `.env.production`, SQLite data, Codex state, proxy state, images, containers, and volumes. Do not use a global Docker prune or destructive cleanup as a setup step.
- When the operator uses a provider firewall, report required ports without configuring UFW or another host firewall.
- For `verify`, inspect and report without changing local, remote, provider, installed, active, or published state.

## Deliver the selected path

For `verify`, run the read-only parts of **Inspect**, **Preflight**, and **Prove**, then report. Skip **Prepare** and **Integrate and deploy**.

1. **Inspect.** Read `README.md`, `docs/configuration.md`, the selected deployment guide under `docs/`, `.env.production.example`, `Dockerfile`, and the selected deployment configuration. Inspect the live service without revealing environment values. Complete when the exact source and current deployment state are recorded.
2. **Preflight.** Check SSH, Docker, disk and memory headroom, DNS, required inbound ports, installation-path ownership, and port conflicts. Complete when every prerequisite passes. Otherwise stop with the failed check and the next safe action.
3. **Prepare.** Clone or update without discarding work, verify the pinned commit object, and check out that commit detached. Create `.env.production` from the current example only when absent, set mode `0600`, and collect only missing values. Complete when the rendered configuration passes and persistent paths are confirmed.
4. **Integrate and deploy.** Guide the selected provider setup, then follow the selected deployment reference and target-repository guide. Build on the server, retain configured resource limits, run as the unprivileged container user, and preserve live state. For Codex OAuth, authenticate inside the application container and confirm that `/home/node/.codex` maps to persistent host storage.
5. **Prove.** Require container health, public HTTPS health, a successful signed webhook, one in-scope review request, a posted review, request clearing, retained SQLite state, and retained Codex authentication when Codex is selected. Verify persistence after container replacement. A healthy endpoint alone is not an end-to-end pass.
6. **Handoff.** Return the exact source commit and the chosen paths. Include update, login, logs, health, rollback, and review re-request commands from the target repository. Name the retained rollback point and every external action or evidence gap.

After one corrected retry for the same diagnosed failure, stop. Report the failing command, a secret-safe error summary, unchanged live state, and the next action.

## Report independent states

Report each applicable layer as `not attempted`, `configured`, `built`, `running`, `externally verified`, `failed`, or `blocked`:

- source and rendered configuration;
- image, container, and public health;
- DNS, webhook, review, and request clearing;
- SQLite and AI-auth persistence; and
- rollback and remaining external work.

Evidence for one layer does not prove another. Separate actions performed from state observed.
