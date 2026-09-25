/**
 * Alátùńwò AI Code Reviewer — webhook service
 *
 * Reacts to a review being requested from the bot on a pull/merge request. It pulls
 * the change's diff, asks the configured AI provider (Claude by default, on your
 * subscription via its headless CLI) to review it, and posts the result as a single
 * review with inline comments — Copilot-style.
 *
 * Two seams keep the service swappable: the AI provider (provider.ts /
 * providers/<name>.ts) decides which review CLI runs, and the repository provider
 * (repository.ts / repositories/<name>.ts, selected by REPO_PROVIDER) decides which
 * code host it talks to (GitHub by default, GitLab optional). This file is pure
 * orchestration — it never names a host or a model.
 *
 * Delivery & concurrency: validate the live head and durably admit the request before
 * acknowledging its webhook, then run the long review in the background. Review and
 * the review queue serializes provider subprocesses, keeping a small box responsive
 * without blocking review intake.
 */

import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ReviewStore } from "./store.ts";
import {
  ReviewCoordinator,
  WorkQueues,
  type ReviewExecution,
} from "./review-coordinator.ts";
import {
  buildContextPrompt,
  buildDiffPrompt,
  buildTargetedContextPrompt,
  buildReviewHeader,
  parsePositiveInt,
  shouldDeepReview,
  type ReviewResult,
} from "./review.ts";
import {
  runReview,
  selectProvider,
  validateReviewProvider,
} from "./provider.ts";
import { removeWorkdir } from "./clone.ts";
import { renderInertModelText } from "./model-text.ts";
import { ModelGatewayClient } from "./runtime/model-gateway-client.ts";
import { modelCredentialProfile } from "./runtime/model-provider-credentials.ts";
import {
  REVIEW_POLICY_FILE,
  parseInstanceReviewPolicy,
  parseReviewGate,
  resolveReviewPolicy,
} from "./review-policy.ts";
import {
  refKey,
  selectRepositoryProvider,
  type ReviewRequest,
} from "./repository.ts";

const {
  REPO_PROVIDER, // which code host to talk to; defaults to "github"
  AI_PROVIDER, // which review CLI to drive; defaults to "claude"
  DATABASE_PATH = "./data/reviews.db", // SQLite file; mount a volume here in prod
  DEEP_REVIEW = "true", // contextual reviews use a read-only checkout by default
  DEEP_REVIEW_MAX_TURNS = "8", // turn budget for a deep review (diff-only is always 1)
  BOT_NAME = "Alátùńwò AI", // display name in the review header/notice
  PORT = "3000",
} = process.env;

const instanceReviewPolicy = parseInstanceReviewPolicy(process.env);
const reviewAdmissionEnabled = parseReviewGate(
  process.env.ACR_REVIEW_ADMISSION_ENABLED ?? "true",
  "ACR_REVIEW_ADMISSION_ENABLED",
);
const terminalSuccessEnabled = parseReviewGate(
  process.env.ACR_REVIEW_TERMINAL_SUCCESS_ENABLED ?? "true",
  "ACR_REVIEW_TERMINAL_SUCCESS_ENABLED",
);

// Pick the AI provider (Claude by default) and let it fail fast on bad config — e.g.
// the Claude provider rejects a stray ANTHROPIC_API_KEY that would override the
// subscription token. Provider-specific wiring lives in providers/<name>.ts.
const aiProvider = selectProvider(AI_PROVIDER);
validateReviewProvider(aiProvider, process.env);

// Pick the repository provider (GitHub by default). validateConfig fails fast on
// missing host credentials; init() (async one-time setup) runs at boot in main().
const repoProvider = selectRepositoryProvider(REPO_PROVIDER);
repoProvider.validateConfig(process.env);

const now = (): string => new Date().toISOString();

// Deep reviews check out the change branch and let the model open surrounding files
// with READ-ONLY tools (no Bash/Write/Edit), so untrusted PR/MR code can't be executed.
// DEEP_REVIEW controls the global default; the deep-review label also opts in.
const deepReviewEnabled = DEEP_REVIEW.toLowerCase() === "true";
const deepReviewMaxTurns = parsePositiveInt(
  DEEP_REVIEW_MAX_TURNS,
  "DEEP_REVIEW_MAX_TURNS"
);

// Serialize reviews so one provider process runs at a time.
const queues = new WorkQueues();

// Durable record of every review request, keyed per (change, head SHA). Reserving a
// row before work starts dedupes webhook redelivery retries and survives process
// restarts. Failed reviews stay retryable; see store.ts. Any row left "pending" by a
// crash is recovered to "failed" at boot so it doesn't block a retry forever.
if (DATABASE_PATH !== ":memory:")
  mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const store = new ReviewStore(DATABASE_PATH);
const orphaned = store.recoverOrphans(now());
if (orphaned > 0)
  console.warn(
    `recovered ${orphaned} review(s) left pending by a previous run`
  );

/**
 * Fetch the diff, review it via the configured AI provider, and post the result as one
 * review. Records the outcome in the store on success; throws on failure so the caller
 * can mark it failed (keeping the head SHA retryable on re-request). Host-agnostic: all
 * host calls go through repoProvider.
 */
async function executeReview(
  job: ReviewExecution
): Promise<{ summary: string; commentCount: number; coverage: { mode: "full" | "incremental" | "targeted"; baseSha: string | null; complete: boolean } }> {
  const req = job.request;
  const key = refKey(req.ref);
  if (!job.policy?.effective) {
    throw new Error(job.policy?.error ?? `${REVIEW_POLICY_FILE} policy was not resolved`);
  }
  await repoProvider.upsertReviewCheck(
    req, job.generation, "pending", "Review in progress", job.signal,
  );
  // A prior bot approval must not remain authoritative while this head is being
  // reassessed. In particular, a failed or interrupted review must not preserve it.
  await repoProvider.reconcileOwnedApproval(req, "absent", job.signal);
  let mode: "full" | "incremental" | "targeted" =
    req.trigger?.requestedMode ?? "full";
  let coverageBaseSha: string | null = null;
  // 1. Fetch the change as a unified diff.
  let diff: string;
  if (mode === "incremental" && req.target) {
    const prior = store.latestCoverageForChange(req.ref, req.target);
    if (prior && prior.head_sha !== req.ref.head_sha) {
      const range = await repoProvider.fetchDiffRange(
        req, prior.head_sha, req.ref.head_sha, job.signal,
      );
      if (range.state === "observed") {
        diff = range.diff;
        coverageBaseSha = prior.head_sha;
      } else {
        mode = "full";
        diff = await repoProvider.fetchDiff(req, job.signal);
      }
    } else {
      mode = "full";
      diff = await repoProvider.fetchDiff(req, job.signal);
    }
  } else {
    diff = await repoProvider.fetchDiff(req, job.signal);
  }
  if (!(await job.isCurrent()))
    throw new Error("review was superseded while fetching its diff");

  // 2. Review on the AI subscription. A deep review clones the change for file context
  //    when requested and the host supports it; otherwise it's a diff-only pass. Track
  //    what actually ran so the header reflects reality (not just what was asked).
  const depth = job.policy?.effective?.depth ?? "default";
  const deep = mode === "targeted" ||
    (req.deepCapable && (depth === "contextual" ||
      (depth === "default" && shouldDeepReview(deepReviewEnabled, req.labels))));
  if (mode === "targeted" && !req.trigger?.finding) {
    throw new Error("targeted review requires a finding and its conversation");
  }
  let result: ReviewResult;
  let didDeepReview = false;
  if (deep) {
    didDeepReview = true;
    const dir = await repoProvider.cloneHead(req, job.signal);
    try {
      console.log(
        `[${key}] head checked out; deep review (max-turns ${deepReviewMaxTurns})`
      );
      result = await runReview(
        aiProvider,
        mode === "targeted"
          ? buildTargetedContextPrompt(diff, dir, req.trigger!.finding!, repoProvider.changeNoun)
          : buildContextPrompt(diff, dir, req.intent, repoProvider.changeNoun,
              mode === "incremental" ? "incremental" : "full"),
        {
          maxTurns: deepReviewMaxTurns,
          addDir: dir,
          deep: true,
          signal: job.signal,
        }
      );
    } finally {
      await removeWorkdir(dir);
    }
  } else {
    if (mode === "targeted") throw new Error("targeted review requires repository context");
    console.log(`[${key}] diff-only review`);
    result = await runReview(
      aiProvider,
      buildDiffPrompt(diff, req.intent, repoProvider.changeNoun),
      {
        signal: job.signal,
      }
    );
  }

  // Format the model's comments for display: keep only those anchored to a diff line,
  // and prefix the severity. The provider maps {path, line, side, body} to its API.
  const comments = (result.comments ?? [])
    .filter((c) => c.path && Number.isInteger(c.line))
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? ("RIGHT" as const),
      body: c.severity
        ? `**${c.severity.toUpperCase()}** — ${renderInertModelText(c.body)}`
        : renderInertModelText(c.body),
    }));
  const header = buildReviewHeader(
    BOT_NAME,
    didDeepReview,
    renderInertModelText(result.summary ?? "")
  );

  // 3. Persist the posting boundary before the first host mutation. The provider pins
  //    the review to this head and rechecks ownership before each mutation.
  if (!(await job.beginPosting()))
    throw new Error("review was superseded before posting");
  const postResult = await repoProvider.postReview(
    req,
    header,
    comments,
    job.isCurrent
  );
  if (postResult.status === "superseded") {
    throw new Error("review was superseded during posting");
  }
  if (postResult.status === "ambiguous") {
    throw new Error(
      `review post outcome is ambiguous after ${postResult.commentCount} inline comment(s)`
    );
  }
  await repoProvider.upsertWalkthrough(req, header, job.signal);
  if (mode === "targeted" && req.trigger?.finding?.externalId && result.comments.length === 0) {
    await repoProvider.resolveFinding(
      req,
      req.trigger.finding.externalId,
      "The reported issue appears resolved in the current head.",
      job.signal,
    );
  }
  const blocking = result.comments.some((comment) => comment.severity === "blocker");
  const allFindingsPublished = postResult.commentCount === comments.length;
  const cleanFullReview = mode === "full" && !blocking && allFindingsPublished;
  await repoProvider.reconcileOwnedApproval(
    req,
    terminalSuccessEnabled && job.policy.effective.approval === "bot" && cleanFullReview
      ? "present" : "absent",
    job.signal,
  );
  await repoProvider.upsertReviewCheck(
    req,
    job.generation,
    terminalSuccessEnabled && cleanFullReview ? "success" : "failure",
    terminalSuccessEnabled
      ? !allFindingsPublished ? "Some review findings could not be published" :
          blocking ? "Blocking review findings remain" :
          mode === "targeted" ? "Targeted reassessment completed; full review needed" :
          mode === "incremental" ? "Incremental review completed; full review needed for terminal success" :
          "Review completed"
      : "Review terminal success is disabled",
    job.signal,
  );
  return {
    summary: result.summary ?? "",
    commentCount: postResult.commentCount,
    coverage: {
      mode,
      baseSha: coverageBaseSha,
      complete: mode !== "targeted",
    },
  };
}

const coordinator = new ReviewCoordinator({
  store,
  queues,
  getCurrentHead: (request, signal) =>
    repoProvider.getCurrentHead(request, signal),
  getCurrentTarget: (request, signal) =>
    repoProvider.getCurrentTarget(request, signal),
  resolvePolicy: async (request, target) => resolveReviewPolicy(
    instanceReviewPolicy,
    target.ref,
    target.head_sha,
    await repoProvider.readTrustedFile(request, {
      path: REVIEW_POLICY_FILE,
      targetHeadSha: target.head_sha,
    }),
  ),
  execute: executeReview,
  onFailure: async (request, generation, error) => {
    try {
      await repoProvider.reconcileOwnedApproval(request, "absent");
    } finally {
      await repoProvider.upsertReviewCheck(
        request,
        generation,
        "failure",
        error instanceof Error ? error.message.slice(0, 500) : "Review failed",
      );
    }
  },
});

const server = express();
server.get("/health", (_req, res) => res.send("ok"));

// Webhooks-only service: the provider verifies + parses the raw delivery (express.raw
// captures the exact bytes a signature check needs; no JSON body parser may run first).
// parseWebhook returns a normalized request, null (not for us → 200), or throws (bad
// signature/token → 400).
server.post(
  repoProvider.webhookPath,
  express.raw({ type: "*/*" }),
  async (req, res) => {
    let request: ReviewRequest | null;
    try {
      request = await repoProvider.parseWebhook(req.headers, req.body);
    } catch (err) {
      console.error("webhook verify/parse failed:", err);
      res.status(400).end();
      return;
    }
    if (!request) {
      res.status(200).end();
      return;
    }
    if (!reviewAdmissionEnabled) {
      res.status(200).end();
      return;
    }
    const reviewRequest = request;
    const key = refKey(reviewRequest.ref);
    // Acknowledge only after the live head is validated and admission is durable.
    // Provider execution remains background work; an intake failure returns 503 so
    // the host retries the signed delivery instead of losing it behind HTTP 200.
    try {
      const submission = await coordinator.submit(reviewRequest);
      if (submission.kind === "duplicate") {
        console.log(`[${key}] already reviewed or in flight; skipping`);
      } else if (submission.kind === "stale_head") {
        console.log(`[${key}] stale review request; skipping`);
      } else if (submission.kind === "not_enabled") {
        console.log(`[${key}] automatic review not enabled by target policy; skipping`);
      }
      res.status(200).end();
    } catch (error) {
      console.error(`[${key}] review admission failed:`, error);
      res.status(503).end();
    }
  }
);

async function main(): Promise<void> {
  const gatewaySocket = process.env.MODEL_GATEWAY_SOCKET_PATH?.trim();
  if (gatewaySocket) {
    const capabilities = await new ModelGatewayClient(gatewaySocket).capabilities();
    const provider = aiProvider.name === "claude" ? "anthropic" : "openai";
    const profile = modelCredentialProfile(provider, process.env);
    if (!capabilities.providers.includes(provider) || capabilities.profiles[provider] !== profile) {
      throw new Error(`model gateway does not offer ${provider} profile ${profile}`);
    }
  }
  await repoProvider.init();
  server.listen(Number(PORT), () =>
    console.log(
      `${BOT_NAME} reviewer listening on :${PORT} (repo: ${repoProvider.name}, ai: ${aiProvider.name})`
    )
  );
}

main().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
