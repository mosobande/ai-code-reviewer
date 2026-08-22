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
import type { RepositoryProvider, ReviewRequest } from "../repository.ts";
import { headerValue, refKey } from "../repository.ts";
import type { ReviewComment } from "../review.ts";
import { basicAuthHeader, cloneRef } from "../clone.ts";

/** Provider-private payload carried on a GitHub ReviewRequest. */
type GithubContext = {
  octokit: Octokit;          // installation-scoped client for this delivery
  installationId?: number;   // needed to mint a token for the deep-review clone
};

const REQUIRED_ENV = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] as const;

export type GithubProviderDeps = {
  createApp?: (options: ConstructorParameters<typeof App>[0]) => App;
};

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

  const repositoryAllowed = (owner: string, repo: string): boolean => {
    const normalizedOwner = owner.toLowerCase();
    const normalizedRepository = `${normalizedOwner}/${repo.toLowerCase()}`;
    return allowedOwners.has(normalizedOwner) || allowedRepositories.has(normalizedRepository);
  };

  // Built in init() — needs the private key, which an empty test env won't have.
  let app: App | undefined;
  const ensureApp = (): App => {
    if (!app) throw new Error("github provider used before init()");
    return app;
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

      // Only act on a review being requested. (Team requests carry `requested_team`
      // instead of `requested_reviewer` and are ignored.)
      if (headerValue(headers, "x-github-event") !== "pull_request") return null;
      const payload = JSON.parse(body);
      if (payload.action !== "review_requested") return null;
      const requested: string | undefined = payload.requested_reviewer?.login;
      if (!requested || !reviewerLogins.has(requested.toLowerCase())) return null;

      const owner: string = payload.repository.owner.login;
      const repo: string = payload.repository.name;
      if (!repositoryAllowed(owner, repo)) {
        console.warn(`[github] ignored review request outside allowlist: ${owner}/${repo}`);
        return null;
      }

      const installationId: number | undefined = payload.installation?.id;
      // Installation-scoped client for this delivery (posting the review, clearing the
      // request). Falls back to an unauthenticated client only if there's no
      // installation id, which shouldn't happen for App-scoped deliveries.
      const octokit = installationId !== undefined
        ? await ensureApp().getInstallationOctokit(installationId)
        : new Octokit();

      const pr = payload.pull_request;
      return {
        ref: {
          owner,
          repo,
          pull_number: pr.number,
          head_sha: pr.head.sha,
        },
        reviewer: requested,
        labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
        intent: { title: pr.title, body: pr.body },
        deepCapable: installationId !== undefined,
        context: { octokit, installationId } satisfies GithubContext,
      };
    },

    async fetchDiff(req: ReviewRequest): Promise<string> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const resp = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
      });
      return resp.data as unknown as string;
    },

    async postReview(req: ReviewRequest, header: string, comments: ReviewComment[]): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      const inline = comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side ?? "RIGHT",
        body: c.body,
      }));
      // GitHub rejects the whole review (422) if any inline comment targets a line
      // outside the diff — fall back to a summary-only review.
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number,
          event: "COMMENT", // never auto-approve or auto-request-changes
          body: header,
          comments: inline,
        });
      } catch {
        console.warn(`[${refKey(req.ref)}] inline review rejected; posting summary only`);
        await octokit.rest.pulls.createReview({ owner, repo, pull_number, event: "COMMENT", body: header });
      }
    },

    async postFailureNotice(req: ReviewRequest, body: string): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      await octokit.rest.pulls.createReview({ owner, repo, pull_number, event: "COMMENT", body });
    },

    async clearReviewRequest(req: ReviewRequest): Promise<void> {
      const { octokit } = req.context as GithubContext;
      const { owner, repo, pull_number } = req.ref;
      // Remove the bot from requested reviewers so it doesn't sit in "awaiting review"
      // — the App comments as itself, which never satisfies the request. Best-effort.
      try {
        await octokit.rest.pulls.removeRequestedReviewers({
          owner,
          repo,
          pull_number,
          reviewers: [req.reviewer],
        });
      } catch (err) {
        console.warn(`[${refKey(req.ref)}] could not clear review request for ${req.reviewer}:`, err);
      }
    },

    async cloneHead(req: ReviewRequest): Promise<string> {
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
      });
    },
  };
}
