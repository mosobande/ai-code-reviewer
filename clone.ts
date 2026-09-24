/**
 * Check out a change's head commit into a throwaway working directory so a deep
 * review can read surrounding files. Host-agnostic: the caller (a RepositoryProvider)
 * supplies the clone URL, the fetch ref, and the auth header, so the same machinery
 * serves GitHub PR heads (`pull/<n>/head`) and GitLab MR heads
 * (`merge-requests/<iid>/head`). Side-effectful (spawns git, touches the filesystem)
 * but free of top-level effects, so it's safe to import.
 *
 * Security: the access token is passed through GIT_CONFIG_* env vars, never the clone
 * URL or a `-c` CLI arg. That keeps it out of .git/config (on disk) and out of the
 * process list (`ps`). The working dir is always removed by the caller.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubprocessEnv,
  GIT_ENV_ALLOWLIST,
  spawnText,
} from "./runtime/spawn.ts";

/**
 * Build an HTTP `AUTHORIZATION: basic …` header from a username + token. GitHub uses
 * user `x-access-token`; GitLab uses `oauth2`. base64 here is HTTP Basic's encoding,
 * NOT protection — it's trivially reversible, so the returned value is a secret and
 * must never be logged. (We keep it out of the clone URL and argv for that reason; it
 * travels only via a GIT_CONFIG_* env var.)
 */
export function basicAuthHeader(user: string, token: string): string {
  const basic = Buffer.from(`${user}:${token}`).toString("base64");
  return `AUTHORIZATION: basic ${basic}`;
}

/** Run one cancellable git command without exposing its auth-only environment. */
async function git(
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<string> {
  return spawnText("git", args, env, "", { signal });
}

export type CloneSpec = {
  cloneUrl: string; // e.g. https://github.com/owner/repo.git
  fetchRef: string; // e.g. pull/42/head | merge-requests/42/head
  authHeader: string; // an AUTHORIZATION header value (see basicAuthHeader)
  expectedHeadSha: string; // admitted source SHA; reject a ref that moved during fetch
};

/**
 * Shallow-fetch a single ref into a fresh temp dir and check it out. Returns the dir.
 * Hosts expose a per-change head ref (`pull/<n>/head` on GitHub,
 * `merge-requests/<iid>/head` on GitLab) that resolves on the base repo even for fork
 * changes, so we never need to clone the fork. On any failure the partial dir is
 * cleaned up before re-throwing.
 */
export async function cloneRef(
  spec: CloneSpec,
  signal?: AbortSignal
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-"));
  // Minimal env: base infra vars only (no service secrets — the token is injected via
  // GIT_CONFIG_* below, never inherited from the parent environment).
  const env = buildSubprocessEnv(process.env, GIT_ENV_ALLOWLIST, {
    GIT_TERMINAL_PROMPT: "0", // never block on an interactive credential prompt
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: spec.authHeader,
  });
  try {
    await git(["init", "-q", dir], env, signal);
    await git(
      ["-C", dir, "remote", "add", "origin", spec.cloneUrl],
      env,
      signal
    );
    await git(
      [
        "-C",
        dir,
        "fetch",
        "--depth",
        "1",
        "--no-tags",
        "origin",
        spec.fetchRef,
      ],
      env,
      signal
    );
    await git(["-C", dir, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "FETCH_HEAD"], env, signal);
    const checkedOut = (await git(["-C", dir, "rev-parse", "HEAD"], env, signal)).trim();
    if (checkedOut.toLowerCase() !== spec.expectedHeadSha.toLowerCase()) {
      throw new Error("fetched review head differs from the admitted source SHA");
    }
    return dir;
  } catch (err) {
    await removeWorkdir(dir);
    throw err;
  }
}

/** Remove a working directory; never throws (best-effort cleanup). */
export async function removeWorkdir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
