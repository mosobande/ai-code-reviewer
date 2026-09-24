/**
 * GitHub provider — drives the GitHub App webhook + REST API. The default (and
 * historically only) RepositoryProvider. Pure construction: createGithubProvider
 * takes the env so it's testable without the real environment; the App itself (which
 * needs the private key) is built lazily in init() so an empty env can still construct
 * the provider for unit tests.
 *
 * Triggers on `pull_request.review_requested` when the requested reviewer is one of
 * REVIEWER_LOGIN. Auth is a GitHub App: a short-lived installation token is minted
 * per deep review, scoped to the one repo with contents:read (least privilege).
 */

import type { IncomingHttpHeaders } from "node:http";
import { App, Octokit } from "octokit";
import type { RepositoryProvider, ReviewRequest, TrustedPolicyFileObservation } from "../repository.ts";
import { headerValue, refKey } from "../repository.ts";
import type { ReviewComment } from "../review.ts";
import { basicAuthHeader, cloneRef } from "../clone.ts";

/** Provider-private payload carried on a GitHub ReviewRequest. */
type GithubContext = {
  octokit: Octokit;          // installation-scoped client for this delivery
  installationId?: number;   // needed to mint a token for the deep-review clone
};

const REQUIRED_ENV = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] as const;
const REVIEW_CHECK_NAME = "Alátùńwò review";
const WALKTHROUGH_MARKER = "<!-- acr:walkthrough:v1 -->";

export type GithubProviderDeps = {
  createApp?: (options: ConstructorParameters<typeof App>[0]) => App;
  appBotLogin?: string;
};

function parseReviewCommand(
  body: string,
  reviewerLogins: ReadonlySet<string>,
): { reviewer: string; mode: "full" | "incremental" } | undefined {
  const match = /^\s*@([^\s@]+)\s+(?:(full)\s+)?review\s*$/i.exec(body);
  const reviewer = match?.[1]?.toLowerCase();
  return reviewer && reviewerLogins.has(reviewer)
    ? { reviewer, mode: match?.[2] ? "full" : "incremental" }
    : undefined;
}

function authorizedComment(comment: any, pr: any, reviewerLogins: ReadonlySet<string>): boolean {
  const actor = String(comment?.user?.login ?? "").toLowerCase();
  const author = String(pr?.user?.login ?? "").toLowerCase();
  const association = String(comment?.author_association ?? "").toUpperCase();
  return Boolean(actor) && comment?.user?.type !== "Bot" && !actor.endsWith("[bot]")
    && !reviewerLogins.has(actor)
    && (!comment.created_at || comment.created_at === comment.updated_at)
    && (actor === author || ["OWNER", "MEMBER", "COLLABORATOR"].includes(association));
}

function commaSeparatedValues(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Restore the GitHub App private key from its env var. Accepts a PEM with real
 * newlines, a `\n`-escaped one-liner, or base64(PEM). base64 is preferred for
 * deploys: it has no backslashes or newlines for env-file layers to mangle.
 * (Kamal double-escapes backslashes when writing the container env-file, which
 * turned a `\n`-encoded key into `\\n` and broke OpenSSL decoding.)
 */
export function loadAppPrivateKey(raw: string): string {
  const v = raw.trim();
  return v.includes("BEGIN") ? v.replace(/\\n/g, "\n") : Buffer.from(v, "base64").toString("utf8");
}

/** Build a GitHub provider bound to the configured App credentials and reviewer logins. */
export function createGithubProvider(
  env: NodeJS.ProcessEnv,
  deps: GithubProviderDeps = {},
): RepositoryProvider {
  // Accounts whose requested review triggers a review. REVIEWER_LOGIN may be a single
  // login or a comma-separated list (e.g. "ayewobot,inspiredstuffs"), matched
  // case-insensitively.
  const reviewerLogins = new Set(commaSeparatedValues(env.REVIEWER_LOGIN));
  const ownerScopes = commaSeparatedValues(env.GITHUB_ALLOWED_OWNERS);
  const invalidOwnerScopes = ownerScopes.filter((scope) => !/^[^/\s]+$/.test(scope));
  const allowedOwners = new Set(ownerScopes);
  const repositoryScopes = commaSeparatedValues(env.GITHUB_ALLOWED_REPOSITORIES);
  const invalidRepositoryScopes = repositoryScopes.filter(
    (scope) => !/^[^/\s]+\/[^/\s]+$/.test(scope),
  );
  const allowedRepositories = new Set(repositoryScopes);
  const automaticScopes = commaSeparatedValues(env.GITHUB_AUTO_REVIEW_REPOSITORIES);
  const invalidAutomaticScopes = automaticScopes.filter(
    (scope) => !/^[^/\s]+\/[^/\s]+$/.test(scope),
  );
  const automaticRepositories = new Set(automaticScopes);

  const repositoryAllowed = (owner: string, repo: string): boolean => {
    const normalizedOwner = owner.toLowerCase();
    const normalizedRepository = `${normalizedOwner}/${repo.toLowerCase()}`;
    return allowedOwners.has(normalizedOwner) || allowedRepositories.has(normalizedRepository);
  };

  // Built in init() — needs the private key, which an empty test env won't have.
  let app: App | undefined;
  let appBotLogin = deps.appBotLogin?.trim().toLowerCase();
  const ensureApp = (): App => {
    if (!app) throw new Error("github provider used before init()");
    return app;
  };
  const botLogin = async (): Promise<string> => {
    if (!appBotLogin) {
      const authenticated = await ensureApp().octokit.rest.apps.getAuthenticated();
      const slug = authenticated.data?.slug?.trim().toLowerCase();
      if (!slug) throw new Error("GitHub App bot identity is unavailable");
      appBotLogin = `${slug}[bot]`;
    }
    return appBotLogin;
  };
  const assertCurrent = async (req: ReviewRequest, signal?: AbortSignal): Promise<void> => {
    if (!req.target) throw new Error("GitHub protected target is unavailable");
    const { octokit } = req.context as GithubContext;
    const { owner, repo, pull_number, head_sha } = req.ref;
    const { data } = await octokit.rest.pulls.get({
      owner, repo, pull_number, request: { signal },
    });
    if (data.state !== "open" || data.head.sha !== head_sha
      || `refs/heads/${data.base.ref}` !== req.target.ref
      || data.base.sha !== req.target.head_sha) {
      throw new Error("GitHub review effect was superseded by a PR head or target change");
    }
  };

  /**
   * Mint a short-lived installation token scoped to just this repo with contents:read
   * — least privilege, enough to fetch the change head for a clone.
   */
  const mintInstallationToken = async (installationId: number, repo: string): Promise<string> => {
    const { data } = await ensureApp().octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
      repositories: [repo],
      permissions: { contents: "read" },
    });
    return data.token;
  };

  return {
    name: "github",
    webhookPath: "/api/github/webhooks",
    changeNoun: "pull request",

    validateConfig(e: NodeJS.ProcessEnv): void {
      for (const name of REQUIRED_ENV) {
        if (!e[name]) throw new Error(`${name} must be set for REPO_PROVIDER=github.`);
      }
      if (reviewerLogins.size === 0) {
        throw new Error("REVIEWER_LOGIN must list at least one login for REPO_PROVIDER=github.");
      }
      if (allowedOwners.size === 0 && allowedRepositories.size === 0) {
        throw new Error(
          "GITHUB_ALLOWED_OWNERS or GITHUB_ALLOWED_REPOSITORIES must list at least one scope " +
            "for REPO_PROVIDER=github.",
        );
      }
      if (invalidRepositoryScopes.length > 0) {
        throw new Error(
          "GITHUB_ALLOWED_REPOSITORIES must contain owner/repo entries; invalid: " +
            invalidRepositoryScopes.join(", "),
        );
      }
      if (invalidOwnerScopes.length > 0) {
        throw new Error(
          "GITHUB_ALLOWED_OWNERS must contain owner names; invalid: " + invalidOwnerScopes.join(", "),
        );
      }
      if (invalidAutomaticScopes.length > 0 || [...automaticRepositories].some((scope) => {
        const [owner, repo] = scope.split("/");
        return !repositoryAllowed(owner!, repo!);
      })) {
        throw new Error(
          "GITHUB_AUTO_REVIEW_REPOSITORIES must contain exact owner/repo entries within the allowed GitHub scope.",
        );
      }
    },

    async init(): Promise<void> {
      const createApp = deps.createApp ?? ((options: ConstructorParameters<typeof App>[0]) => new App(options));
      app = createApp({
        appId: env.GITHUB_APP_ID!,
        privateKey: loadAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY!),
        webhooks: { secret: env.GITHUB_WEBHOOK_SECRET! },
      });
    },

    async parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<ReviewRequest | null> {
      const signature = headerValue(headers, "x-hub-signature-256");
      if (!signature) throw new Error("missing X-Hub-Signature-256");
      const body = rawBody.toString("utf8");
      // Verify the HMAC against the configured webhook secret; throw → 400.
      if (!(await ensureApp().webhooks.verify(body, signature))) {
        throw new Error("invalid webhook signature");
      }

      const event = headerValue(headers, "x-github-event");
      if (event !== "pull_request" && event !== "issue_comment"
        && event !== "pull_request_review_comment") return null;
      const payload = JSON.parse(body);
      const owner: string = payload.repository.owner.login;
      const repo: string = payload.repository.name;
      if (!repositoryAllowed(owner, repo)) {
        console.warn(`[github] ignored review request outside allowlist: ${owner}/${repo}`);
        return null;
      }

      const installationId: number | undefined = payload.installation?.id;
      const octokit = installationId !== undefined
        ? await ensureApp().getInstallationOctokit(installationId)
        : new Octokit();
      const delivery = headerValue(headers, "x-github-delivery");
      const normalize = (pr: any, reviewer: string, trigger: NonNullable<ReviewRequest["trigger"]>): ReviewRequest => ({
        ref: { owner, repo, pull_number: pr.number, head_sha: pr.head.sha },
        ...(typeof pr.base?.ref === "string" && typeof pr.base?.sha === "string"
          ? { target: { ref: `refs/heads/${pr.base.ref}`, head_sha: pr.base.sha } }
          : {}),
        reviewer,
        labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
        intent: { title: pr.title, body: pr.body },
        deepCapable: installationId !== undefined,
        trigger,
        context: { octokit, installationId } satisfies GithubContext,
      });

      if (event === "issue_comment") {
        const comment = payload.comment;
        const command = parseReviewCommand(String(comment?.body ?? ""), reviewerLogins);
        if (payload.action !== "created" || !payload.issue?.pull_request || !command
          || !Number.isSafeInteger(payload.issue?.number)) return null;
        const pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: payload.issue.number })).data;
        if (!authorizedComment(comment, pr, reviewerLogins)) return null;
        return normalize(pr, command.reviewer, {
          kind: "command", id: delivery ?? `issue-comment:${comment.id}`,
          requestedMode: command.mode,
        });
      }

      if (event === "pull_request_review_comment") {
        const comment = payload.comment;
        const pr = payload.pull_request;
        const parentId = comment?.in_reply_to_id;
        if (payload.action !== "created" || !Number.isSafeInteger(parentId)
          || !authorizedComment(comment, pr, reviewerLogins)) return null;
        const ownedBot = await botLogin();
        const parent = (await octokit.rest.pulls.getReviewComment({
          owner, repo, comment_id: parentId as number,
        })).data;
        if (String(parent?.user?.login ?? "").toLowerCase() !== ownedBot
          || parent?.pull_request_review_id == null
          || parent?.pull_request_url !== `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`
          || typeof parent.path !== "string" || !Number.isSafeInteger(parent.line) || (parent.line ?? 0) < 1) return null;
        return normalize(pr, reviewerLogins.values().next().value!, {
          kind: "finding_reply", requestedMode: "targeted",
          id: delivery ?? `review-comment:${comment.id}`,
          finding: {
            externalId: String(parentId), path: parent.path, line: parent.line as number,
            conversation: [
              { author: String(parent.user.login), body: String(parent.body ?? "") },
              { author: String(comment.user.login), body: String(comment.body ?? "") },
            ],
          },
        });
      }

      const pr = payload.pull_request;
      const automatic = automaticRepositories.has(`${owner}/${repo}`.toLowerCase())
        && ["opened", "reopened", "ready_for_review", "synchronize"].includes(payload.action)
        && Number.isSafeInteger(installationId) && installationId! > 0
        && pr?.state === "open" && pr?.draft === false
        && pr?.user?.type !== "Bot"
        && !String(pr?.user?.login ?? "").toLowerCase().endsWith("[bot]")
        && !reviewerLogins.has(String(pr?.user?.login ?? "").toLowerCase())
        && Boolean(pr?.user?.login);
      let requested: string | undefined;
      if (automatic) {
        requested = reviewerLogins.values().next().value;
      } else if (payload.action === "review_requested") {
        requested = payload.requested_reviewer?.login;
      } else if (payload.action === "synchronize") {
        requested = (pr?.requested_reviewers ?? []).find(
          ({ login }: { login?: string }) => reviewerLogins.has(String(login ?? "").toLowerCase()),
        )?.login;
        if (!requested && Number.isSafeInteger(installationId)) {
          const login = await botLogin();
          const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
            owner, repo, pull_number: pr.number, per_page: 100,
          });
          if (reviews.some((review: any) =>
            review?.state?.toUpperCase() === "APPROVED"
              && review?.user?.login?.toLowerCase() === login)) {
            requested = reviewerLogins.values().next().value;
          }
        }
      }
      if (!requested || !reviewerLogins.has(requested.toLowerCase())) return null;
      const id = automatic
        ? `automatic:${owner.toLowerCase()}/${repo.toLowerCase()}#${pr.number}@${pr.head.sha}:${pr.base?.sha ?? ""}`
        : delivery ?? `assignment:${owner}/${repo}#${pr.number}@${pr.head.sha}:${requested.toLowerCase()}`;
      return normalize(pr, requested, {
        kind: "assignment", id,
        requestedMode: payload.action === "synchronize" ? "incremental" : "full",
      });
    },

    async getCurrentHead(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const response = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
        request: { signal },
      });
      return response.data.head.sha;
    },

    async getCurrentTarget(
      req: ReviewRequest,
      signal?: AbortSignal,
    ): Promise<{ ref: string; head_sha: string }> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const response = await octokit.rest.pulls.get({
        owner, repo, pull_number, request: { signal },
      });
      const branch = response.data.base?.ref;
      const sha = response.data.base?.sha;
      if (!branch || !sha) throw new Error("GitHub PR base ref or head is unavailable");
      return { ref: `refs/heads/${branch}`, head_sha: sha };
    },

    async fetchDiff(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const resp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
        request: { signal },
      });
      return resp.data as unknown as string;
    },

    async fetchDiffRange(
      req: ReviewRequest,
      baseSha: string,
      headSha: string,
      signal?: AbortSignal,
    ): Promise<{ state: "observed"; diff: string } | { state: "incomplete"; reason: string }> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo } = req.ref;
      if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)
        || headSha !== req.ref.head_sha) {
        return { state: "incomplete", reason: "GitHub diff range does not match the recorded head" };
      }
      const basehead = `${baseSha}...${headSha}`;
      try {
        const comparison = await octokit.rest.repos.compareCommits({
          owner, repo, base: baseSha, head: headSha, request: { signal },
        });
        const data = comparison.data;
        if (!(["ahead", "identical"] as string[]).includes(data.status)
          || !Array.isArray(data.files) || data.files.length >= 300
          || !Number.isSafeInteger(data.total_commits) || data.total_commits > 250
          || data.files.some((file) => typeof file.patch !== "string")) {
          return { state: "incomplete", reason: "GitHub comparison is truncated or unsupported" };
        }
        const response = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner, repo, basehead, mediaType: { format: "diff" }, request: { signal },
        });
        if (typeof response.data !== "string") {
          return { state: "incomplete", reason: "GitHub comparison diff is unavailable" };
        }
        return { state: "observed", diff: response.data };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { state: "incomplete", reason: "GitHub comparison read is incomplete" };
      }
    },

    async readTrustedFile(
      req: ReviewRequest,
      input: { path: string; targetHeadSha: string },
      signal?: AbortSignal,
    ): Promise<TrustedPolicyFileObservation> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo } = req.ref;
      try {
        const response = await octokit.rest.repos.getContent({
          owner, repo, path: input.path, ref: input.targetHeadSha, request: { signal },
        });
        const file = response.data as {
          type?: string; encoding?: string; content?: string; sha?: string;
        };
        if (file.type !== "file" || file.encoding !== "base64"
          || typeof file.content !== "string" || typeof file.sha !== "string") {
          return { state: "incomplete", reason: "GitHub trusted file response is incomplete" };
        }
        return {
          state: "observed",
          blobSha: file.sha,
          content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        if ((error as { status?: number }).status === 404) return { state: "absent" };
        return { state: "incomplete", reason: "GitHub trusted file read is incomplete" };
      }
    },

    async postReview(
      req: ReviewRequest,
      header: string,
      comments: ReviewComment[],
      canMutate: () => Promise<boolean>,
    ) {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number, head_sha } = req.ref;
      const inline = comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        body: c.body,
      }));
      let postedCommentCount = inline.length;
      if (!(await canMutate())) return { status: "superseded" as const };
      // GitHub rejects the whole review (422) if any inline comment targets a line
      // outside the diff — fall back to a summary-only review.
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          commit_id: head_sha,
          event: "COMMENT", // never auto-approve or auto-request-changes
          body: header,
          comments: inline,
        });
      } catch (error) {
        if ((error as { status?: number }).status !== 422) throw error;
        if (!(await canMutate())) return { status: "superseded" as const };
        console.warn(`[${refKey(req.ref)}] inline review rejected; posting summary only`);
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          commit_id: head_sha,
          event: "COMMENT",
          body: header,
        });
        postedCommentCount = 0;
      }
      return {
        status: "posted" as const,
        commentCount: postedCommentCount,
      };
    },

    async upsertReviewCheck(req, generation, status, summary, signal): Promise<void> {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("GitHub review generation must be a positive integer");
      }
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number, head_sha } = req.ref;
      const externalId = `acr:review:${owner.toLowerCase()}/${repo.toLowerCase()}#${pull_number}@${head_sha}:g${generation}`;
      const listed = await octokit.rest.checks.listForRef({
        owner, repo, ref: head_sha, check_name: REVIEW_CHECK_NAME,
        per_page: 100, request: { signal },
      });
      if (listed.data.total_count > listed.data.check_runs.length) {
        throw new Error("GitHub review check listing is incomplete");
      }
      const owned = listed.data.check_runs.filter((check) =>
        check.external_id === externalId && check.app?.id === Number(env.GITHUB_APP_ID));
      if (owned.length > 1) throw new Error("GitHub review check identity is ambiguous");
      await assertCurrent(req, signal);
      const output = { title: REVIEW_CHECK_NAME, summary };
      if (owned[0]) {
        await octokit.rest.checks.update({
          owner, repo, check_run_id: owned[0].id,
          ...(status === "pending"
            ? { status: "in_progress" as const }
            : { status: "completed" as const, conclusion: status === "success" ? "success" as const : "failure" as const }),
          output, request: { signal },
        });
      } else {
        await octokit.rest.checks.create({
          owner, repo, name: REVIEW_CHECK_NAME, head_sha, external_id: externalId,
          ...(status === "pending"
            ? { status: "in_progress" as const }
            : { status: "completed" as const, conclusion: status === "success" ? "success" as const : "failure" as const }),
          output, request: { signal },
        });
      }
    },

    async reconcileOwnedApproval(req, desired, signal): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number, head_sha } = req.ref;
      const login = await botLogin();
      const response = await octokit.rest.pulls.listReviews({
        owner, repo, pull_number, per_page: 100, request: { signal },
      });
      if (response.data.length >= 100) throw new Error("GitHub review listing may be incomplete");
      const owned = response.data.filter((review) =>
        review.state?.toUpperCase() === "APPROVED"
        && review.user?.login?.toLowerCase() === login);
      const current = owned.filter((review) => review.commit_id === head_sha);
      if (desired === "present" && current.length > 0) return;
      if (desired === "absent" && owned.length === 0) return;
      await assertCurrent(req, signal);
      if (desired === "present") {
        await octokit.rest.pulls.createReview({
          owner, repo, pull_number, commit_id: head_sha,
          event: "APPROVE", body: "Review completed by Alátùńwò.", request: { signal },
        });
      } else {
        for (const review of owned) {
          await assertCurrent(req, signal);
          await octokit.rest.pulls.dismissReview({
            owner, repo, pull_number, review_id: review.id,
            message: "Alátùńwò approval withdrawn after review reconciliation.",
            event: "DISMISS", request: { signal },
          });
        }
      }
    },

    async upsertWalkthrough(req, body, signal): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const login = await botLogin();
      const response = await octokit.rest.issues.listComments({
        owner, repo, issue_number: pull_number, per_page: 100, request: { signal },
      });
      if (response.data.length >= 100) throw new Error("GitHub walkthrough comment listing may be incomplete");
      const owned = response.data.filter((comment) =>
        comment.user?.login?.toLowerCase() === login && comment.body?.startsWith(WALKTHROUGH_MARKER));
      if (owned.length > 1) throw new Error("GitHub walkthrough identity is ambiguous");
      const markedBody = `${WALKTHROUGH_MARKER}\n${body}`;
      if (owned[0]?.body === markedBody) return;
      await assertCurrent(req, signal);
      if (owned[0]) {
        await octokit.rest.issues.updateComment({
          owner, repo, comment_id: owned[0].id, body: markedBody, request: { signal },
        });
      } else {
        await octokit.rest.issues.createComment({
          owner, repo, issue_number: pull_number, body: markedBody, request: { signal },
        });
      }
    },

    async resolveFinding(req, findingExternalId, reply, signal): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const commentId = Number(findingExternalId);
      if (!Number.isSafeInteger(commentId) || commentId < 1) {
        throw new Error("GitHub finding comment ID is invalid");
      }
      const parent = (await octokit.rest.pulls.getReviewComment({
        owner, repo, comment_id: commentId, request: { signal },
      })).data;
      if (parent.user?.login?.toLowerCase() !== await botLogin()
        || parent.in_reply_to_id != null || parent.pull_request_review_id == null
        || parent.pull_request_url !== `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}`) {
        throw new Error("GitHub finding is not owned by this App on this PR");
      }
      type Threads = { repository?: { pullRequest?: { reviewThreads?: {
        nodes?: Array<{ id?: string; isResolved?: boolean; comments?: { nodes?: Array<{ databaseId?: number }> } }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } } } };
      let cursor: string | null = null;
      let matching: Array<{ id: string; isResolved: boolean }> = [];
      do {
        const response: Threads = await octokit.graphql<Threads>(
          `query AcrFindingThread($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
                  nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }`,
          { owner, repo, number: pull_number, cursor, request: { signal } },
        );
        const connection = response.repository?.pullRequest?.reviewThreads;
        if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
          throw new Error("GitHub finding thread listing is incomplete");
        }
        matching.push(...connection.nodes.filter((thread) =>
          thread.comments?.nodes?.[0]?.databaseId === commentId
            && typeof thread.id === "string" && typeof thread.isResolved === "boolean",
        ) as Array<{ id: string; isResolved: boolean }>);
        if (!connection.pageInfo.hasNextPage) break;
        const next = connection.pageInfo.endCursor;
        if (!next || next === cursor) throw new Error("GitHub finding thread pagination is incomplete");
        cursor = next;
      } while (true);
      if (matching.length !== 1) throw new Error("GitHub finding thread identity is missing or ambiguous");
      await assertCurrent(req, signal);
      await octokit.rest.pulls.createReplyForReviewComment({
        owner, repo, pull_number, comment_id: commentId, body: reply, request: { signal },
      });
      if (!matching[0]!.isResolved) {
        await assertCurrent(req, signal);
        const response = await octokit.graphql<{
          resolveReviewThread?: { thread?: { id?: string; isResolved?: boolean } };
        }>(
          `mutation AcrResolveFinding($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread { id isResolved }
            }
          }`,
          { threadId: matching[0]!.id, request: { signal } },
        );
        if (response.resolveReviewThread?.thread?.id !== matching[0]!.id
          || response.resolveReviewThread.thread.isResolved !== true) {
          throw new Error("GitHub finding thread resolution has no exact readback");
        }
      }
    },

    async cloneHead(req: ReviewRequest, signal?: AbortSignal): Promise<string> {
      const { installationId } = req.context as GithubContext;
      if (installationId === undefined) {
        throw new Error("deep review requires a GitHub App installation id");
      }
      const { owner, repo, pull_number } = req.ref;
      const token = await mintInstallationToken(installationId, repo);
      // `pull/<n>/head` resolves on the base repo even for fork PRs, so we never need
      // to clone the fork. The token is injected via the auth header, not the URL.
      return cloneRef({
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        fetchRef: `pull/${pull_number}/head`,
        authHeader: basicAuthHeader("x-access-token", token),
        expectedHeadSha: req.ref.head_sha,
      }, signal);
    },
  };
}
