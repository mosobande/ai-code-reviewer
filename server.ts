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
 * Delivery & concurrency: hosts fail a webhook delivery they can't deliver in ~10s and
 * retry it. Reviews take far longer, so we ack immediately and run the review in the
 * background, serialised through a queue so only one provider subprocess runs at a time
 * (predictable memory on a small box). Each change's head SHA is reviewed at most once.
 */

import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PQueue from "p-queue";
import { ReviewStore } from "./store.ts";
import {
  buildContextPrompt,
  buildDiffPrompt,
  buildReviewHeader,
  parsePositiveInt,
  shouldDeepReview,
  type ReviewResult,
} from "./review.ts";
import { runReview, selectProvider, validateReviewProvider } from "./provider.ts";
import { removeWorkdir } from "./clone.ts";
import { refKey, selectRepositoryProvider, type ReviewRequest } from "./repository.ts";

const {
  REPO_PROVIDER,                        // which code host to talk to; defaults to "github"
  AI_PROVIDER,                          // which review CLI to drive; defaults to "claude"
  DATABASE_PATH = "./data/reviews.db",  // SQLite file; mount a volume here in prod
  DEEP_REVIEW = "false",                // "true" → clone the change so the model can read surrounding files
  DEEP_REVIEW_MAX_TURNS = "8",          // turn budget for a deep review (diff-only is always 1)
  BOT_NAME = "Alátùńwò AI",             // display name in the review header/notice
  PORT = "3000",
} = process.env;

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
// Opt in via DEEP_REVIEW=true; otherwise reviews stay diff-only.
const deepReviewEnabled = DEEP_REVIEW.toLowerCase() === "true";
const deepReviewMaxTurns = parsePositiveInt(DEEP_REVIEW_MAX_TURNS, "DEEP_REVIEW_MAX_TURNS");

// One review subprocess at a time. Reviews are memory-heavy and run on a shared
// subscription, so serialising keeps resource use predictable and avoids piling up
// concurrent CLI processes when several reviews are requested at once.
const queue = new PQueue({ concurrency: 1 });

// Durable record of every review request, keyed per (change, head SHA). Reserving a
// row before work starts dedupes webhook redelivery retries and survives process
// restarts. Failed reviews stay retryable; see store.ts. Any row left "pending" by a
// crash is recovered to "failed" at boot so it doesn't block a retry forever.
if (DATABASE_PATH !== ":memory:") mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const store = new ReviewStore(DATABASE_PATH);
const orphaned = store.recoverOrphans(now());
if (orphaned > 0) console.warn(`recovered ${orphaned} review(s) left pending by a previous run`);

/** A short note shown when a review couldn't be completed, so the requester isn't
 *  left in limbo and knows to re-request. */
function failureNotice(err: unknown): string {
  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  return [
    `🤖 **${BOT_NAME} review failed** — I couldn't complete this review.`,
    "",
    "Please re-request a review to try again.",
    "",
    "<details><summary>Error detail</summary>",
    "",
    "```",
    detail,
    "```",
    "</details>",
  ].join("\n");
}

/**
 * Fetch the diff, review it via the configured AI provider, and post the result as one
 * review. Records the outcome in the store on success; throws on failure so the caller
 * can mark it failed (keeping the head SHA retryable on re-request). Host-agnostic: all
 * host calls go through repoProvider.
 */
async function processReview(req: ReviewRequest, key: string): Promise<void> {
  // 1. Fetch the change as a unified diff.
  const diff = await repoProvider.fetchDiff(req);

  // 2. Review on the AI subscription. A deep review clones the change for file context
  //    when requested and the host supports it; otherwise it's a diff-only pass. Track
  //    what actually ran so the header reflects reality (not just what was asked).
  const deep = shouldDeepReview(deepReviewEnabled, req.labels) && req.deepCapable;
  let result: ReviewResult;
  let didDeepReview = false;
  if (deep) {
    didDeepReview = true;
    const dir = await repoProvider.cloneHead(req);
    try {
      console.log(`[${key}] head checked out; deep review (max-turns ${deepReviewMaxTurns})`);
      result = await runReview(aiProvider, buildContextPrompt(diff, dir, req.intent, repoProvider.changeNoun), {
        maxTurns: deepReviewMaxTurns,
        addDir: dir,
        deep: true,
      });
    } finally {
      await removeWorkdir(dir);
      console.log(`[${key}] deep-review checkout removed`);
    }
  } else {
    console.log(`[${key}] diff-only review`);
    result = await runReview(aiProvider, buildDiffPrompt(diff, req.intent, repoProvider.changeNoun));
  }

  // Format the model's comments for display: keep only those anchored to a diff line,
  // and prefix the severity. The provider maps {path, line, side, body} to its API.
  const comments = (result.comments ?? [])
    .filter((c) => c.path && Number.isInteger(c.line))
    .map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? ("RIGHT" as const),
      body: c.severity ? `**${c.severity.toUpperCase()}** — ${c.body}` : c.body,
    }));
  const header = buildReviewHeader(BOT_NAME, didDeepReview, result.summary ?? "");

  // 3. Post the review, record it, and clear the request so the bot doesn't sit in
  //    "awaiting review".
  await repoProvider.postReview(req, header, comments);
  store.markPosted(req.ref, result.summary ?? "", comments.length, now());
  console.log(`[${key}] review posted`);
  await repoProvider.clearReviewRequest(req);
}

const server = express();
server.get("/health", (_req, res) => res.send("ok"));

// Webhooks-only service: the provider verifies + parses the raw delivery (express.raw
// captures the exact bytes a signature check needs; no JSON body parser may run first).
// parseWebhook returns a normalized request, null (not for us → 200), or throws (bad
// signature/token → 400).
server.post(repoProvider.webhookPath, express.raw({ type: "*/*" }), async (req, res) => {
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
  const reviewRequest = request; // narrowed; used in the async callbacks below
  const key = refKey(reviewRequest.ref);

  // Idempotency: reserve this head SHA. A `false` return means it's already posted or
  // in flight — skip, but still clear the re-request so the bot doesn't get stuck
  // "awaiting review" for this commit. Reserving synchronously (before the queue) also
  // dedupes redelivery of webhooks we don't ack in time.
  if (!store.reserve(reviewRequest.ref, reviewRequest.reviewer, now())) {
    console.log(`[${key}] already reviewed or in flight; skipping`);
    void repoProvider.clearReviewRequest(reviewRequest).catch(() => {});
    res.status(200).end();
    return;
  }

  // Hand the review to the queue and ack immediately, well inside the host's ~10s
  // window. The work runs in the background, one review at a time.
  void queue
    .add(() => processReview(reviewRequest, key))
    .catch(async (err) => {
      // Mark failed so a later re-request can retry this exact head SHA.
      store.markFailed(reviewRequest.ref, err instanceof Error ? err.message : String(err), now());
      console.error(`[${key}] review failed:`, err);
      // Don't leave the change in limbo — post a short note. Best-effort.
      try {
        await repoProvider.postFailureNotice(reviewRequest, failureNotice(err));
      } catch (postErr) {
        console.error(`[${key}] could not post failure notice:`, postErr);
      }
    });
  res.status(200).end();
});

async function main(): Promise<void> {
  await repoProvider.init();
  server.listen(Number(PORT), () =>
    console.log(`${BOT_NAME} reviewer listening on :${PORT} (repo: ${repoProvider.name}, ai: ${aiProvider.name})`),
  );
}

main().catch((err) => {
  console.error("failed to start:", err);
  process.exit(1);
});
