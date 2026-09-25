import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReviewCoordinator,
  WorkQueues,
  type ReviewExecution,
} from "../review-coordinator.ts";
import type { ReviewRequest } from "../repository.ts";
import { ReviewStore } from "../store.ts";
import { parseInstanceReviewPolicy, resolveReviewPolicy } from "../review-policy.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function request(pull: number, head: string): ReviewRequest {
  return {
    ref: { owner: "acme", repo: "widgets", pull_number: pull, head_sha: head },
    reviewer: "bot",
    labels: [],
    intent: { title: "test", body: "" },
    deepCapable: false,
    context: {},
  };
}

test("automatic candidate requires trusted target policy before admission", async () => {
  const store = new ReviewStore(":memory:");
  const candidate = request(8, "head-8");
  candidate.target = { ref: "refs/heads/main", head_sha: "base-8" };
  candidate.trigger = { kind: "automatic", id: "automatic:acme/widgets#8@head-8:base-8", requestedMode: "full" };
  let content = "version: 2\nreview: { automatic: false }\n";
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async () => "head-8",
    getCurrentTarget: async () => candidate.target!,
    resolvePolicy: async (_request, target) => resolveReviewPolicy(
      parseInstanceReviewPolicy({}), target.ref, target.head_sha,
      { state: "observed", blobSha: "policy", content },
    ),
    execute: async (job) => {
      if (!job.policy?.effective) throw new Error(job.policy?.error ?? "invalid policy");
      assert.equal(await job.beginPosting(), true);
      return { summary: "reviewed", commentCount: 0 };
    },
  });
  assert.equal((await coordinator.submit(candidate)).kind, "not_enabled");
  assert.equal(store.get(candidate.ref), undefined);
  content = "version: 2\nreview: { automatic: true }\n";
  assert.equal((await coordinator.submit(candidate)).kind, "accepted");
  await coordinator.onIdle();
  assert.equal(store.get(candidate.ref)?.phase, "posted");
  store.close();
});

test("review work is serialized", async () => {
  const queues = new WorkQueues();
  const firstStarted = deferred();
  const finishFirst = deferred();
  let secondStarted = false;
  const first = queues.addReview(async () => {
    firstStarted.resolve();
    await finishFirst.promise;
  });
  await firstStarted.promise;
  const second = queues.addReview(async () => { secondStarted = true; });
  assert.equal(secondStarted, false);
  finishFirst.resolve();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("a newer head cancels the oldest queued review for the same pull request", async () => {
  const store = new ReviewStore(":memory:");
  const queues = new WorkQueues();
  const heads = new Map<number, string>([
    [1, "blocker"],
    [7, "old"],
  ]);
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const executed: string[] = [];

  const execute = async (job: ReviewExecution) => {
    executed.push(job.request.ref.head_sha);
    if (job.request.ref.pull_number === 1) {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    }
    assert.equal(await job.beginPosting(), true);
    return { summary: "ok", commentCount: 0 };
  };
  const coordinator = new ReviewCoordinator({
    store,
    queues,
    getCurrentHead: async (req) => heads.get(req.ref.pull_number)!,
    execute,
  });

  await coordinator.submit(request(1, "blocker"));
  await blockerStarted.promise;
  const old = await coordinator.submit(request(7, "old"));
  assert.equal(old.kind, "accepted");
  heads.set(7, "new");
  const latest = await coordinator.submit(request(7, "new"));
  assert.equal(latest.kind, "accepted");

  releaseBlocker.resolve();
  await coordinator.onIdle();
  assert.deepEqual(executed, ["blocker", "new"]);
  assert.equal(store.get(request(7, "old").ref)?.phase, "cancelled");
  assert.equal(store.get(request(7, "old").ref)?.superseded_by_sha, "new");
  assert.equal(store.get(request(7, "new").ref)?.phase, "posted");
  assert.equal(coordinator.activeReviewCount, 0);
  store.close();
});

test("an accepted old post records its pinned outcome without displacing a newer generation", async () => {
  const store = new ReviewStore(":memory:");
  const heads = new Map<number, string>([[7, "old"]]);
  const oldPostStarted = deferred();
  const finishOldPost = deferred();

  const execute = async (job: ReviewExecution) => {
    assert.equal(await job.beginPosting(), true);
    if (job.request.ref.head_sha === "old") {
      oldPostStarted.resolve();
      await finishOldPost.promise;
    }
    return { summary: job.request.ref.head_sha, commentCount: 0 };
  };
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async (req) => heads.get(req.ref.pull_number)!,
    execute,
  });

  await coordinator.submit(request(7, "old"));
  await oldPostStarted.promise;
  heads.set(7, "new");
  await coordinator.submit(request(7, "new"));
  finishOldPost.resolve();
  await coordinator.onIdle();

  const old = store.get(request(7, "old").ref);
  const latest = store.get(request(7, "new").ref);
  assert.equal(old?.phase, "posted");
  assert.equal(old?.superseded_by_sha, "new");
  assert.equal(latest?.phase, "posted");
  assert.equal(
    store.currentForChange(request(7, "new").ref)?.generation,
    latest?.generation
  );
  store.close();
});

test("same-SHA redelivery neither starts another review nor aborts the active one", async () => {
  const store = new ReviewStore(":memory:");
  const started = deferred();
  const finish = deferred();
  let executions = 0;
  let aborted = false;
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async (req) => req.ref.head_sha,
    execute: async (job) => {
      executions += 1;
      job.signal.addEventListener("abort", () => {
        aborted = true;
      });
      started.resolve();
      await finish.promise;
      assert.equal(await job.beginPosting(), true);
      return { summary: "ok", commentCount: 0 };
    },
  });

  const first = await coordinator.submit(request(7, "same"));
  await started.promise;
  const duplicate = await coordinator.submit(request(7, "same"));
  assert.equal(first.kind, "accepted");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(aborted, false);
  finish.resolve();
  await coordinator.onIdle();
  assert.equal(executions, 1);
  store.close();
});

test("superseding a running provider aborts it without a secondary host mutation", async () => {
  const store = new ReviewStore(":memory:");
  const heads = new Map<number, string>([[7, "old"]]);
  const oldStarted = deferred();
  let oldAborted = false;
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async (req) => heads.get(req.ref.pull_number)!,
    execute: async (job) => {
      if (job.request.ref.head_sha === "old") {
        oldStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          job.signal.addEventListener(
            "abort",
            () => {
              oldAborted = true;
              reject(job.signal.reason);
            },
            { once: true }
          );
        });
      }
      assert.equal(await job.beginPosting(), true);
      return { summary: "ok", commentCount: 0 };
    },
  });

  await coordinator.submit(request(7, "old"));
  await oldStarted.promise;
  heads.set(7, "new");
  await coordinator.submit(request(7, "new"));
  await coordinator.onIdle();

  assert.equal(oldAborted, true);
  assert.equal(store.get(request(7, "old").ref)?.phase, "cancelled");
  assert.equal(store.get(request(7, "new").ref)?.phase, "posted");
  store.close();
});

test("per-change admission order prevents a delayed old head check from cancelling the latest request", async () => {
  const store = new ReviewStore(":memory:");
  const oldHeadRead = deferred<string>();
  const admissionCalls: string[] = [];
  const executed: string[] = [];
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async (req, signal) => {
      if (!signal) admissionCalls.push(req.ref.head_sha);
      return req.ref.head_sha === "old" ? oldHeadRead.promise : "new";
    },
    execute: async (job) => {
      executed.push(job.request.ref.head_sha);
      assert.equal(await job.beginPosting(), true);
      return { summary: "ok", commentCount: 0 };
    },
  });

  const oldSubmission = coordinator.submit(request(7, "old"));
  const newSubmission = coordinator.submit(request(7, "new"));
  await Promise.resolve();
  assert.deepEqual(admissionCalls, ["old"], "new admission waits behind the older submitted request");
  oldHeadRead.resolve("old");
  await Promise.all([oldSubmission, newSubmission]);
  await coordinator.onIdle();

  assert.deepEqual(admissionCalls, ["old", "new"]);
  assert.equal(executed.at(-1), "new");
  assert.equal(store.currentForChange(request(7, "new").ref)?.head_sha, "new");
  store.close();
});

test("a post-boundary transport error remains ambiguous and non-retryable", async () => {
  const store = new ReviewStore(":memory:");
  let executions = 0;
  const coordinator = new ReviewCoordinator({
    store,
    getCurrentHead: async (req) => req.ref.head_sha,
    execute: async (job) => {
      executions += 1;
      assert.equal(await job.beginPosting(), true);
      throw new Error("response lost after host accepted review");
    },
  });

  await coordinator.submit(request(7, "ambiguous"));
  await coordinator.onIdle();
  assert.equal(store.get(request(7, "ambiguous").ref)?.phase, "posting");
  assert.equal((await coordinator.submit(request(7, "ambiguous"))).kind, "duplicate");
  await coordinator.onIdle();
  assert.equal(executions, 1);
  store.close();
});
