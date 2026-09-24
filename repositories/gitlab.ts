/**
 * GitLab provider — drives the GitLab Merge Request webhook + REST API (api/v4).
 * Pure construction: createGitlabProvider takes the env so it's testable without the
 * real environment. The webhook-parsing, diff-assembly, comment-position, and
 * reviewer-math logic is factored into exported pure helpers so it's unit-testable
 * without a live GitLab.
 *
 * GitLab differs from GitHub in ways this file absorbs:
 *  - Standard Webhooks signs each delivery with an HMAC and timestamp.
 *  - There's no `review_requested` event: a reviewer/assignee change rides on a
 *    generic `update` action, detected by diffing `changes.reviewers/assignees`.
 *  - There's no batched "review" object: inline comments are individual discussion
 *    threads (each needs a `position` with the MR's base/start/head SHAs); the summary
 *    is a separate note.
 *  - Auth is one static access token; the bot's own user id is resolved via GET /user.
 *  - The diff comes back as paginated per-file JSON, reassembled into a unified diff.
 */

import type { IncomingHttpHeaders } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RepositoryProvider, ReviewRequest } from "../repository.ts";
import { headerValue, refKey } from "../repository.ts";
import type { PrIntent, ReviewComment } from "../review.ts";
import { basicAuthHeader, cloneRef } from "../clone.ts";

class GitlabApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    detail: string
  ) {
    super(`${method} /api/v4${path} failed: ${status} ${detail.slice(0, 300)}`);
  }
}

/** The three SHAs that anchor an inline comment to the diff, from the MR's `diff_refs`. */
export type DiffRefs = { base_sha: string; start_sha: string; head_sha: string };

/** Provider-private payload carried on a GitLab ReviewRequest. */
type GitlabContext = {
  projectId: number;
  mrIid: number;
  diffRefs?: DiffRefs;     // filled in fetchDiff, used by postReview
};

export type GitlabTrustedFileObservation =
  | { state: "observed"; blobSha: string; content: string }
  | { state: "absent" }
  | { state: "incomplete"; reason: string };

export type GitlabReviewProvider = RepositoryProvider & {
  readTrustedFile(
    req: ReviewRequest,
    input: { path: string; targetHeadSha: string },
    signal?: AbortSignal,
  ): Promise<GitlabTrustedFileObservation>;
};

/** One file's entry from `GET .../merge_requests/:iid/diffs`. */
export type GitlabDiffFile = {
  old_path: string;
  new_path: string;
  diff: string;            // the per-file hunk body (no `diff --git`/`---`/`+++` headers)
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
};

/** Normalized MR-event fields extracted from a webhook payload. */
export type ParsedMrEvent = {
  ref: { owner: string; repo: string; pull_number: number; head_sha: string };
  projectId: number;
  mrIid: number;
  labels: string[];
  intent: PrIntent;
  reviewerIds: number[];
  assigneeIds: number[];
  triggeredBy: "reviewer" | "assignee";
  pushed: boolean;
};

const MR_TRIGGER_ACTIONS = new Set(["open", "reopen", "update"]);

/** Collect numeric ids from an array of GitLab user objects, dropping anything malformed. */
function userIds(arr: unknown): number[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((u) => (u as { id?: unknown })?.id).filter((id): id is number => typeof id === "number");
}

/**
 * Decide whether an MR webhook payload means "the bot was just asked to review", and
 * if so extract the normalized fields. Returns null when it's not a trigger for us.
 *
 * Trigger = the bot is newly present (vs. the `changes` previous set) as a reviewer or
 * assignee, the bot's reviewer entry is flagged `re_requested`, the bot remains
 * assigned after a push update (`oldrev`), or the bot is assigned on open/reopen.
 * Pure, so the trigger logic is unit-testable.
 */
export function parseMergeRequestEvent(payload: any, botUserId: number): ParsedMrEvent | null {
  if (payload?.object_kind !== "merge_request") return null;
  const attrs = payload.object_attributes ?? {};
  if (!MR_TRIGGER_ACTIONS.has(attrs.action)) return null;

  const reviewers = payload.reviewers ?? [];
  const reviewerIds = Array.isArray(attrs.reviewer_ids) ? attrs.reviewer_ids : userIds(reviewers);
  const assigneeIds = Array.isArray(attrs.assignee_ids) ? attrs.assignee_ids : userIds(payload.assignees);
  const changes = payload.changes ?? {};

  const newlyAdded = (change: any): boolean => {
    if (!change) return false;
    const prev = new Set(userIds(change.previous));
    const curr = new Set(userIds(change.current));
    return curr.has(botUserId) && !prev.has(botUserId);
  };
  const reRequested = reviewers.some(
    (r: any) => r?.id === botUserId && r?.re_requested === true,
  );

  let triggeredBy: "reviewer" | "assignee" | null = null;
  let pushed = false;
  if (newlyAdded(changes.reviewers) || reRequested) triggeredBy = "reviewer";
  else if (newlyAdded(changes.assignees)) triggeredBy = "assignee";
  else if (attrs.action === "update" && typeof attrs.oldrev === "string" && attrs.oldrev.trim()) {
    if (reviewerIds.includes(botUserId)) {
      triggeredBy = "reviewer";
      pushed = true;
    } else if (assigneeIds.includes(botUserId)) {
      triggeredBy = "assignee";
      pushed = true;
    }
  }
  else if (attrs.action === "open" || attrs.action === "reopen") {
    if (reviewerIds.includes(botUserId)) triggeredBy = "reviewer";
    else if (assigneeIds.includes(botUserId)) triggeredBy = "assignee";
  }
  if (!triggeredBy) return null;

  const project = payload.project ?? {};
  const path: string = project.path_with_namespace ?? "";
  const slash = path.lastIndexOf("/");
  const owner = slash >= 0 ? path.slice(0, slash) : path;
  const repo = slash >= 0 ? path.slice(slash + 1) : path;

  const labels: string[] = (attrs.labels ?? payload.labels ?? [])
    .map((l: any) => l?.title ?? l?.name)
    .filter((t: unknown): t is string => typeof t === "string" && t.length > 0);

  return {
    ref: { owner, repo, pull_number: attrs.iid, head_sha: attrs.last_commit?.id ?? "" },
    projectId: project.id,
    mrIid: attrs.iid,
    labels,
    intent: { title: attrs.title, body: attrs.description },
    reviewerIds,
    assigneeIds,
    triggeredBy,
    pushed,
  };
}

/**
 * Reassemble GitLab's paginated per-file diff JSON into a single unified-diff string.
 * GitLab returns only the hunk body per file, so we synthesize the `diff --git` /
 * `--- a/…` / `+++ b/…` headers (using `/dev/null` for added/deleted files). Pure.
 */
export function assembleUnifiedDiff(files: GitlabDiffFile[]): string {
  return files
    .map((f) => {
      const body = f.diff.endsWith("\n") ? f.diff : `${f.diff}\n`;
      // GitLab returns a bare hunk body. Be defensive: if a representation ever already
      // carries the `diff --git`/`---` file headers, don't synthesize a second set.
      if (/^(diff --git |--- )/.test(f.diff)) return body;
      const oldSide = f.new_file ? "/dev/null" : `a/${f.old_path}`;
      const newSide = f.deleted_file ? "/dev/null" : `b/${f.new_path}`;
      return `diff --git a/${f.old_path} b/${f.new_path}\n--- ${oldSide}\n+++ ${newSide}\n${body}`;
    })
    .join("");
}

/**
 * Build the GitLab discussion `position` object for an inline comment. A RIGHT-side
 * (added/changed) comment anchors on `new_line`; a LEFT-side (removed) one on
 * `old_line`. The AI gives a single file path, used for both old/new paths (rename
 * edge cases may mis-anchor and are caught at post time). Pure.
 */
export function buildPosition(comment: ReviewComment, diffRefs: DiffRefs): Record<string, unknown> {
  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    old_path: comment.path,
    new_path: comment.path,
  };
  if ((comment.side ?? "RIGHT") === "LEFT") position.old_line = comment.line;
  else position.new_line = comment.line;
  return position;
}

function safeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function gitlabWebhookKey(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("GITLAB_WEBHOOK_SECRET must be a valid GitLab signing token.");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("GITLAB_WEBHOOK_SECRET must be a valid GitLab signing token.");
  }
  return key;
}

function canonicalRepository(path: string): string {
  const value = path.trim().toLowerCase();
  if (value.split("/").length < 2 || value.split("/").some((part) => !part || !/^[a-z0-9_.-]+$/.test(part))) {
    throw new Error(`invalid GitLab repository path: ${JSON.stringify(path)}`);
  }
  return value;
}

const STATUS_CHECK_CONFIG_ERROR =
  "GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON must map every allowed GitLab repository to a positive safe integer and contain no other repositories.";

function statusCheckIds(raw: string | undefined): Map<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? "{}"); }
  catch { throw new Error(STATUS_CHECK_CONFIG_ERROR); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(STATUS_CHECK_CONFIG_ERROR);
  const ids = new Map<string, number>();
  for (const [path, id] of Object.entries(parsed)) {
    let key: string;
    try { key = canonicalRepository(path); }
    catch { throw new Error(STATUS_CHECK_CONFIG_ERROR); }
    if (ids.has(key) || !Number.isSafeInteger(id) || (id as number) <= 0) throw new Error(STATUS_CHECK_CONFIG_ERROR);
    ids.set(key, id as number);
  }
  return ids;
}

const WALKTHROUGH_MARKER = "<!-- acr:walkthrough -->";

function parseReviewCommand(body: string, botUsername: string): "full" | "incremental" | null {
  const match = /^\s*@([^\s@]+)\s+(?:(full)\s+)?review\s*$/i.exec(body);
  if (!match || match[1]!.toLowerCase() !== botUsername.toLowerCase()) return null;
  return match[2] ? "full" : "incremental";
}

/** Build a GitLab provider bound to the configured token, API URL, and webhook secret. */
export function createGitlabProvider(env: NodeJS.ProcessEnv): GitlabReviewProvider {
  const token = env.GITLAB_TOKEN ?? "";
  const webhookSecret = env.GITLAB_WEBHOOK_SECRET ?? "";
  const webhookMaxAgeSeconds = Number(env.GITLAB_WEBHOOK_MAX_AGE_SECONDS ?? "300");
  const rawRepositoryScopes = (env.REPOSITORY_ALLOWED_REPOSITORIES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const allowedRepositories = new Set(rawRepositoryScopes.flatMap((scope) => {
    try { return [canonicalRepository(scope)]; } catch { return []; }
  }));
  const externalStatusCheckIds = statusCheckIds(env.GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON);
  // Base URL with no /api/v4 suffix (we add it per-call). It doubles as the git base
  // for clone URLs, so a subpath-hosted instance (e.g. https://host/gitlab) is honored
  // verbatim rather than collapsed to its origin.
  const apiUrl = (env.GITLAB_API_URL?.trim() || "https://gitlab.com").replace(/\/+$/, "");

  // Resolved in init() via GET /user; -1 never matches a real reviewer id.
  let botUserId = -1;
  let botUsername = "";

  /** One JSON REST call against api/v4. Fails loudly with method, path, and status. */
  const api = async (
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      json?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<any> => {
    const url = new URL(`${apiUrl}/api/v4${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { "PRIVATE-TOKEN": token };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const resp = await fetch(url, { method, headers, body, signal: opts.signal });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new GitlabApiError(resp.status, method, path, detail);
    }
    return resp.status === 204 ? null : resp.json();
  };

  /** Page through a list endpoint via the `x-next-page` header until exhausted. */
  const getAllPages = async (
    path: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<any[]> => {
    const out: any[] = [];
    let page = 1;
    for (;;) {
      const url = new URL(`${apiUrl}/api/v4${path}`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const resp = await fetch(url, { headers: { "PRIVATE-TOKEN": token }, signal });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`GET /api/v4${path} failed: ${resp.status} ${detail.slice(0, 300)}`);
      }
      out.push(...((await resp.json()) as unknown[]));
      // GitLab signals "no more pages" with an empty x-next-page; guard "0" too so a
      // stray sentinel can't drive page=0 (an invalid request / potential loop).
      const next = resp.headers.get("x-next-page");
      if (!next || next === "0") break;
      page = Number(next);
    }
    return out;
  };

  const mrPath = (ctx: GitlabContext): string =>
    `/projects/${ctx.projectId}/merge_requests/${ctx.mrIid}`;

  const assertCurrentHead = async (req: ReviewRequest, signal?: AbortSignal): Promise<void> => {
    const mr = await api("GET", mrPath(req.context as GitlabContext), { signal });
    if ((mr?.diff_refs?.head_sha ?? mr?.sha) !== req.ref.head_sha || mr?.state !== "opened") {
      throw new Error("GitLab review source head or MR state changed");
    }
    if (!req.target || mr?.target_branch !== req.target.ref.replace(/^refs\/heads\//, "")) {
      throw new Error("GitLab review target branch changed");
    }
    const target = await currentTarget(req.context as GitlabContext, signal);
    if (target.head_sha !== req.target.head_sha || target.ref !== req.target.ref) {
      throw new Error("GitLab review target head changed");
    }
  };

  const currentTarget = async (ctx: GitlabContext, signal?: AbortSignal): Promise<{ ref: string; head_sha: string }> => {
    const mr = await api("GET", mrPath(ctx), { signal });
    const branch = mr?.target_branch;
    if (typeof branch !== "string" || !branch) throw new Error("GitLab MR target branch is unavailable");
    const target = await api("GET", `/projects/${ctx.projectId}/repository/branches/${encodeURIComponent(branch)}`, { signal });
    const sha = target?.commit?.id;
    if (typeof sha !== "string" || !sha) throw new Error("GitLab MR target head is unavailable");
    return { ref: `refs/heads/${branch}`, head_sha: sha };
  };

  return {
    name: "gitlab",
    webhookPath: "/api/gitlab/webhooks",
    changeNoun: "merge request",

    validateConfig(e: NodeJS.ProcessEnv): void {
      if (!e.GITLAB_TOKEN) throw new Error("GITLAB_TOKEN must be set for REPO_PROVIDER=gitlab.");
      if (!e.GITLAB_WEBHOOK_SECRET) {
        throw new Error("GITLAB_WEBHOOK_SECRET must be set for REPO_PROVIDER=gitlab.");
      }
      gitlabWebhookKey(e.GITLAB_WEBHOOK_SECRET);
      const configuredMaxAge = Number(e.GITLAB_WEBHOOK_MAX_AGE_SECONDS ?? "300");
      if (!Number.isSafeInteger(configuredMaxAge) || configuredMaxAge < 1 || configuredMaxAge > 3600) {
        throw new Error("GITLAB_WEBHOOK_MAX_AGE_SECONDS must be an integer from 1 to 3600.");
      }
      const configuredScopes = (e.REPOSITORY_ALLOWED_REPOSITORIES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      const invalidScopes = configuredScopes.filter((scope) => {
        try { canonicalRepository(scope); return false; } catch { return true; }
      });
      if (invalidScopes.length > 0) {
        throw new Error(`REPOSITORY_ALLOWED_REPOSITORIES must contain exact namespace/repository paths; invalid: ${invalidScopes.join(", ")}`);
      }
      if (configuredScopes.length === 0) {
        throw new Error("REPOSITORY_ALLOWED_REPOSITORIES must list at least one exact repository for REPO_PROVIDER=gitlab.");
      }
      const configuredIds = statusCheckIds(e.GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON);
      const scopes = new Set(configuredScopes.map(canonicalRepository));
      if (configuredIds.size !== scopes.size || [...scopes].some((scope) => !configuredIds.has(scope))) {
        throw new Error(STATUS_CHECK_CONFIG_ERROR);
      }
    },

    async init(): Promise<void> {
      // Resolve the bot's own user id from the token, so reviewer/assignee detection
      // and unassignment key off the right account. Fails boot if the token is invalid.
      const me = await api("GET", "/user");
      if (typeof me?.id !== "number") {
        throw new Error("could not resolve GitLab bot user id from GET /user (check GITLAB_TOKEN)");
      }
      botUserId = me.id;
      botUsername = typeof me.username === "string" && me.username.trim() ? me.username : String(me.id);
    },

    async parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<ReviewRequest | null> {
      if (!Number.isSafeInteger(webhookMaxAgeSeconds) || webhookMaxAgeSeconds < 1 || webhookMaxAgeSeconds > 3600) {
        throw new Error("invalid GITLAB_WEBHOOK_MAX_AGE_SECONDS");
      }
      const id = headerValue(headers, "webhook-id")?.trim();
      const timestamp = headerValue(headers, "webhook-timestamp")?.trim();
      const supplied = headerValue(headers, "webhook-signature")?.trim();
      if (!id) throw new Error("missing webhook-id");
      if (!timestamp || !/^\d+$/.test(timestamp)) throw new Error("invalid webhook-timestamp");
      if (!supplied) throw new Error("missing webhook-signature");
      const seconds = Number(timestamp);
      if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > webhookMaxAgeSeconds) {
        throw new Error("stale webhook-timestamp");
      }
      const material = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), rawBody]);
      const expected = `v1,${createHmac("sha256", gitlabWebhookKey(webhookSecret)).update(material).digest("base64")}`;
      if (!supplied.split(" ").some((candidate) => safeEqual(candidate, expected))) {
        throw new Error("invalid webhook-signature");
      }
      const event = headerValue(headers, "x-gitlab-event");
      if (event !== "Merge Request Hook" && event !== "Note Hook") return null;

      const payload = JSON.parse(rawBody.toString("utf8"));
      let repository: string;
      try { repository = canonicalRepository(String(payload.project?.path_with_namespace ?? "")); }
      catch { return null; }
      if (!allowedRepositories.has(repository)) {
        console.warn(`[gitlab] ignored review request outside allowlist: ${repository}`);
        return null;
      }
      if (event === "Merge Request Hook") {
        const parsed = parseMergeRequestEvent(payload, botUserId);
        if (!parsed) return null;
        const ctx: GitlabContext = { projectId: parsed.projectId, mrIid: parsed.mrIid };
        return {
          ref: parsed.ref,
          target: await currentTarget(ctx),
          reviewer: String(botUserId),
          labels: parsed.labels,
          intent: parsed.intent,
          deepCapable: true,
          trigger: { kind: "assignment", requestedMode: parsed.pushed ? "incremental" : "full", id },
          context: ctx,
        };
      }

      if (payload?.object_kind !== "note") return null;
      const attrs = payload.object_attributes ?? {};
      const actor = payload.user ?? {};
      if (attrs.action !== "create" || attrs.noteable_type !== "MergeRequest"
        || !Number.isSafeInteger(payload.merge_request?.iid) || !Number.isSafeInteger(payload.project?.id)
        || !Number.isSafeInteger(actor.id) || actor.id === botUserId || actor.bot === true
        || (attrs.created_at && attrs.created_at !== attrs.updated_at)) return null;
      const discussionId = typeof attrs.discussion_id === "string" ? attrs.discussion_id : undefined;
      const command = discussionId ? null : parseReviewCommand(String(attrs.note ?? ""), botUsername);
      if (!command && !discussionId) return null;

      const user = await api("GET", `/users/${actor.id}`);
      if (user?.id !== actor.id || user?.bot !== false) return null;
      const ctx: GitlabContext = { projectId: payload.project.id, mrIid: payload.merge_request.iid };
      const mr = await api("GET", mrPath(ctx));
      let allowed = actor.id === mr?.author?.id;
      if (!allowed) {
        try {
          const member = await api("GET", `/projects/${ctx.projectId}/members/all/${actor.id}`);
          allowed = typeof member?.access_level === "number" && member.access_level >= 30;
        } catch (error) {
          if (!(error instanceof GitlabApiError) || error.status !== 404) throw error;
        }
      }
      if (!allowed) return null;
      const head = mr?.diff_refs?.head_sha ?? mr?.sha;
      if (typeof head !== "string" || !head || mr?.state !== "opened") return null;
      let trigger: NonNullable<ReviewRequest["trigger"]>;
      if (command) {
        trigger = { kind: "command", requestedMode: command, id };
      } else {
        const discussion = await api("GET", `${mrPath(ctx)}/discussions/${encodeURIComponent(discussionId!)}`);
        const notes: any[] = discussion?.notes;
        if (!Array.isArray(notes) || !notes.some((note) => note?.id === attrs.id)) return null;
        const finding = notes.find((note) => note?.author?.id === botUserId && note?.position?.new_path);
        const path = finding?.position?.new_path;
        const line = finding?.position?.new_line ?? finding?.position?.old_line;
        if (typeof path !== "string" || !Number.isSafeInteger(line) || line < 1) return null;
        trigger = {
          kind: "finding_reply", requestedMode: "targeted", id,
          finding: {
            path, line, externalId: discussionId!,
            conversation: notes.slice(-50).map((note) => ({
              author: String(note?.author?.username ?? note?.author?.id ?? "unknown"),
              body: String(note?.body ?? ""),
            })),
          },
        };
      }
      const path = String(payload.project.path_with_namespace);
      const slash = path.lastIndexOf("/");
      return {
        ref: { owner: path.slice(0, slash), repo: path.slice(slash + 1), pull_number: ctx.mrIid, head_sha: head },
        target: await currentTarget(ctx),
        reviewer: String(botUserId),
        labels: (mr.labels ?? []).map((label: any) => typeof label === "string" ? label : label?.title).filter((label: unknown): label is string => typeof label === "string"),
        intent: { title: mr.title, body: mr.description },
        deepCapable: true,
        trigger,
        context: ctx,
      };
    },

    async getCurrentHead(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const ctx = req.context as GitlabContext;
      const mr = await api("GET", mrPath(ctx), { signal });
      const head = mr?.diff_refs?.head_sha ?? mr?.sha;
      if (typeof head !== "string" || head.length === 0) {
        throw new Error("GitLab merge request did not return a current head SHA");
      }
      return head;
    },

    async getCurrentTarget(req: ReviewRequest, signal?: AbortSignal): Promise<{ ref: string; head_sha: string }> {
      return currentTarget(req.context as GitlabContext, signal);
    },

    async fetchDiff(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const ctx = req.context as GitlabContext;
      // Read the diff SHAs from the same MR snapshot we diff, so inline comments anchor
      // correctly (stale SHAs are rejected by GitLab).
      const mr = await api("GET", mrPath(ctx), { signal });
      ctx.diffRefs = mr?.diff_refs;
      if (ctx.diffRefs?.head_sha !== req.ref.head_sha) {
        throw new Error(
          `GitLab diff head changed from ${req.ref.head_sha} to ${ctx.diffRefs?.head_sha ?? "unknown"}`,
        );
      }
      const files = (await getAllPages(
        `${mrPath(ctx)}/diffs`,
        { unidiff: "true" },
        signal,
      )) as GitlabDiffFile[];
      return assembleUnifiedDiff(files);
    },

    async fetchDiffRange(
      req: ReviewRequest,
      baseSha: string,
      headSha: string,
      signal?: AbortSignal,
    ): Promise<{ state: "observed"; diff: string } | { state: "incomplete"; reason: string }> {
      if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha) || headSha !== req.ref.head_sha) {
        return { state: "incomplete", reason: "GitLab comparison identity is invalid" };
      }
      const ctx = req.context as GitlabContext;
      try {
        const mr = await api("GET", mrPath(ctx), { signal });
        if (mr?.diff_refs?.head_sha !== headSha) return { state: "incomplete", reason: "GitLab comparison head moved" };
        ctx.diffRefs = mr.diff_refs;
        const comparison = await api("GET", `/projects/${ctx.projectId}/repository/compare`, {
          query: { from: baseSha, to: headSha, straight: "true", unidiff: "true" }, signal,
        });
        if (!Array.isArray(comparison?.diffs) || comparison.compare_timeout === true || comparison.overflow === true
          || comparison.diffs.some((file: any) => typeof file.diff !== "string" || file.too_large === true || file.collapsed === true)) {
          return { state: "incomplete", reason: "GitLab comparison is incomplete" };
        }
        return { state: "observed", diff: assembleUnifiedDiff(comparison.diffs as GitlabDiffFile[]) };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { state: "incomplete", reason: "GitLab could not prove the incremental range" };
      }
    },

    async readTrustedFile(
      req: ReviewRequest,
      input: { path: string; targetHeadSha: string },
      signal?: AbortSignal,
    ): Promise<GitlabTrustedFileObservation> {
      const ctx = req.context as GitlabContext;
      try {
        const file = await api(
          "GET",
          `/projects/${ctx.projectId}/repository/files/${encodeURIComponent(input.path)}`,
          { query: { ref: input.targetHeadSha }, signal },
        );
        if (file?.encoding !== "base64" || typeof file.content !== "string" || typeof file.blob_id !== "string") {
          return { state: "incomplete", reason: "GitLab trusted file response is incomplete" };
        }
        return {
          state: "observed",
          blobSha: file.blob_id,
          content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof GitlabApiError && error.status === 404) return { state: "absent" };
        return { state: "incomplete", reason: "GitLab trusted file read is incomplete" };
      }
    },

    async upsertReviewCheck(
      req: ReviewRequest,
      _generation: number,
      status: "pending" | "success" | "failure",
      _summary: string,
      signal?: AbortSignal,
    ): Promise<void> {
      const project = canonicalRepository(`${req.ref.owner}/${req.ref.repo}`);
      const id = externalStatusCheckIds.get(project);
      if (id === undefined || !allowedRepositories.has(project)) {
        throw new Error("GitLab external status check is not configured for this repository");
      }
      await assertCurrentHead(req, signal);
      await api("POST", `${mrPath(req.context as GitlabContext)}/status_check_responses`, {
        json: {
          sha: req.ref.head_sha,
          external_status_check_id: id,
          status: status === "success" ? "passed" : status === "failure" ? "failed" : "pending",
        },
        signal,
      });
    },

    async reconcileOwnedApproval(
      req: ReviewRequest,
      desired: "present" | "absent",
      signal?: AbortSignal,
    ): Promise<void> {
      if (botUserId < 0) throw new Error("GitLab bot identity is unavailable");
      const path = mrPath(req.context as GitlabContext);
      const approvals = await api("GET", `${path}/approvals`, { signal });
      if (!Array.isArray(approvals?.approved_by)) throw new Error("GitLab approval observation is incomplete");
      const owned = approvals.approved_by.some((entry: any) => entry?.user?.id === botUserId);
      if (desired === "absent") {
        if (owned) {
          await assertCurrentHead(req, signal);
          await api("POST", `${path}/unapprove`, { signal });
        }
        return;
      }
      await assertCurrentHead(req, signal);
      if (!owned) await api("POST", `${path}/approve`, { json: { sha: req.ref.head_sha }, signal });
    },

    async upsertWalkthrough(req: ReviewRequest, body: string, signal?: AbortSignal): Promise<void> {
      if (botUserId < 0) throw new Error("GitLab bot identity is unavailable");
      const path = mrPath(req.context as GitlabContext);
      const notes = await getAllPages(`${path}/notes`, {}, signal);
      const owned = notes.filter((note) => note?.author?.id === botUserId && typeof note?.body === "string"
        && note.body.includes(WALKTHROUGH_MARKER));
      if (owned.length > 1) throw new Error("multiple bot-owned GitLab walkthrough notes exist");
      await assertCurrentHead(req, signal);
      const markedBody = `${WALKTHROUGH_MARKER}\n${body}`;
      if (owned.length === 1) {
        const note = owned[0];
        if (!Number.isSafeInteger(note?.id)) throw new Error("GitLab walkthrough note identity is incomplete");
        if (note.body !== markedBody) await api("PUT", `${path}/notes/${note.id}`, { json: { body: markedBody }, signal });
      } else {
        await api("POST", `${path}/notes`, { json: { body: markedBody }, signal });
      }
    },

    async resolveFinding(
      req: ReviewRequest,
      findingExternalId: string,
      reply: string,
      signal?: AbortSignal,
    ): Promise<void> {
      if (botUserId < 0 || !findingExternalId) throw new Error("GitLab finding identity is unavailable");
      const path = `${mrPath(req.context as GitlabContext)}/discussions/${encodeURIComponent(findingExternalId)}`;
      const discussion = await api("GET", path, { signal });
      if (discussion?.id !== findingExternalId || !Array.isArray(discussion?.notes)) {
        throw new Error("GitLab finding discussion is incomplete");
      }
      const finding = discussion.notes[0];
      if (finding?.author?.id !== botUserId || !finding?.position || finding.resolvable !== true) {
        throw new Error("GitLab finding discussion is not bot-owned and resolvable");
      }
      await assertCurrentHead(req, signal);
      const alreadyReplied = discussion.notes.some((note: any) => note?.author?.id === botUserId && note?.body === reply);
      if (!alreadyReplied) await api("POST", `${path}/notes`, { json: { body: reply }, signal });
      if (finding.resolved !== true) await api("PUT", path, { json: { resolved: true }, signal });
    },

    async postReview(
      req: ReviewRequest,
      header: string,
      comments: ReviewComment[],
      canMutate: () => Promise<boolean>,
    ) {
      const ctx = req.context as GitlabContext;
      const discussions = `${mrPath(ctx)}/discussions`;
      let commentCount = 0;
      // GitLab has no batched review — each inline comment is its own discussion
      // thread. Stop at the first uncertain outcome: retrying a partly accepted set
      // would duplicate earlier comments, while continuing would misstate the result.
      if (ctx.diffRefs) {
        for (const c of comments) {
          if (!(await canMutate())) return { status: "superseded" as const };
          try {
            await api("POST", discussions, { json: { body: c.body, position: buildPosition(c, ctx.diffRefs) } });
            commentCount += 1;
          } catch (err) {
            if (
              err instanceof GitlabApiError &&
              (err.status === 400 || err.status === 422)
            ) {
              console.warn(
                `[${refKey(req.ref)}] inline comment on ${c.path}:${c.line} rejected; skipping`
              );
              continue;
            }
            console.warn(`[${refKey(req.ref)}] inline comment outcome is ambiguous; stopping`, err);
            return { status: "ambiguous" as const, commentCount };
          }
        }
      } else {
        console.warn(`[${refKey(req.ref)}] no diff_refs available; posting summary only`);
      }
      if (!(await canMutate())) return { status: "superseded" as const };
      try {
        await api("POST", discussions, { json: { body: header } });
      } catch (err) {
        console.warn(`[${refKey(req.ref)}] summary note outcome is ambiguous:`, err);
        return { status: "ambiguous" as const, commentCount };
      }
      return { status: "posted" as const, commentCount };
    },

    async cloneHead(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const ctx = req.context as GitlabContext;
      // GitLab git-over-HTTPS uses Basic auth with username `oauth2` and the token as
      // the password; `merge-requests/<iid>/head` is fork-agnostic like GitHub's
      // `pull/<n>/head`. The token rides the auth header, never the URL.
      return cloneRef({
        cloneUrl: `${apiUrl}/${req.ref.owner}/${req.ref.repo}.git`,
        fetchRef: `merge-requests/${ctx.mrIid}/head`,
        authHeader: basicAuthHeader("oauth2", token),
        expectedHeadSha: req.ref.head_sha,
      }, signal);
    },
  };
}
