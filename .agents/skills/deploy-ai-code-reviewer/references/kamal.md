# Kamal and GHCR

Load this branch only for `kamal`. Read `docs/deploy-kamal.md` and `config/deploy*.yml` in the target repository before acting.

## Preconditions

Require Kamal 2, a GHCR namespace and package-write token, SSH access to every target, Docker on the remote builder, public DNS for `PROXY_HOST`, and available TCP ports 80 and 443. Confirm required configuration without printing secret values.

The configured remote builder owns the build. Do not fall back silently to a local cross-build. Validate the merged destination configuration before `setup` or `deploy`.

## State and deployment

Preserve the named SQLite volume and host-mounted Codex state across releases. Before the first Codex deployment, make the host state directory mode `0700` and writable by UID and GID 1000. Run Codex OAuth through the application container so authentication reaches that mount.

Use `bin/kamal` and the commands maintained in `docs/deploy-kamal.md`. Record the current app version before replacement. Do not remove registry, proxy, application, image, or volume state as an update shortcut.

## Proof

Require Kamal Proxy health, public HTTPS, one successful webhook-triggered review, retained SQLite state, and retained Codex state when Codex is selected. Verify persistence after a later deployment. A successful GHCR push proves publication only.
