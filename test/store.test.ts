import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ReviewStore, type ReviewRef } from "../store.ts";

const REF: ReviewRef = {
  owner: "acme",
  repo: "widgets",
  pull_number: 7,
  head_sha: "abc123",
};
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

/** Each test gets its own in-memory DB so they don't share state. */
function freshStore(): ReviewStore {
  return new ReviewStore(":memory:");
}

test("admit claims a new head SHA exactly once", () => {
  const store = freshStore();
  assert.equal(store.admit(REF, "bot", T0).kind, "accepted");
  assert.equal(store.admit(REF, "bot", T1).kind, "duplicate");
  assert.equal(store.get(REF)?.phase, "queued");
  store.close();
});

test("the same SHA on a different PR is reviewed independently", () => {
  const store = freshStore();
  assert.equal(store.admit(REF, "bot", T0).kind, "accepted");
  const otherPr: ReviewRef = { ...REF, pull_number: 8 };
  assert.equal(store.admit(otherPr, "bot", T0).kind, "accepted");
  store.close();
});

test("a posted current head records its outcome and deduplicates", () => {
  const store = freshStore();
  const admitted = store.admit(REF, "bot", T0);
  if (admitted.kind !== "accepted") throw new Error("review should be admitted");
  store.start(admitted.generation);
  store.startPosting(admitted.generation, T1);
  store.markGenerationPosted(admitted.generation, "looks good", 3, T1);

  const row = store.get(REF);
  assert.equal(row?.phase, "posted");
  assert.equal(row?.summary, "looks good");
  assert.equal(row?.comment_count, 3);
  assert.equal(row?.completed_at, T1);
  assert.equal(store.admit(REF, "bot", T1).kind, "duplicate");
  store.close();
});

test("a failed current review can be retried by re-requesting", () => {
  const store = freshStore();
  const admitted = store.admit(REF, "bot", T0);
  if (admitted.kind !== "accepted") throw new Error("review should be admitted");
  store.start(admitted.generation);
  store.markGenerationFailed(admitted.generation, "provider failed", T1);
  assert.equal(store.get(REF)?.phase, "failed");

  assert.equal(store.admit(REF, "bot", T1).kind, "accepted");
  const row = store.get(REF);
  assert.equal(row?.phase, "queued");
  assert.equal(row?.error, null);
  assert.equal(row?.completed_at, null);
  store.close();
});

test("recoverOrphans makes pre-post work retryable", () => {
  const store = freshStore();
  store.admit(REF, "bot", T0);

  assert.equal(store.recoverOrphans(T1), 1);
  assert.equal(store.get(REF)?.phase, "failed");
  assert.equal(store.admit(REF, "bot", T1).kind, "accepted");
  store.close();
});

test("recoverOrphans leaves posted and failed rows untouched", () => {
  const store = freshStore();
  const admitted = store.admit(REF, "bot", T0);
  if (admitted.kind !== "accepted") throw new Error("review should be admitted");
  store.start(admitted.generation);
  store.startPosting(admitted.generation, T1);
  store.markGenerationPosted(admitted.generation, "ok", 0, T1);

  assert.equal(store.recoverOrphans(T1), 0);
  assert.equal(store.get(REF)?.phase, "posted");
  store.close();
});

test("legacy migration preserves every outcome and deterministically selects each current change", () => {
  const dir = mkdtempSync(join(tmpdir(), "atunwo-store-"));
  const path = join(dir, "reviews.db");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE reviews (
      owner TEXT NOT NULL, repo TEXT NOT NULL, pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL, reviewer TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','posted','failed')),
      summary TEXT, comment_count INTEGER, error TEXT,
      requested_at TEXT NOT NULL, completed_at TEXT,
      PRIMARY KEY (owner, repo, pull_number, head_sha)
    );
    INSERT INTO reviews
      (owner, repo, pull_number, head_sha, reviewer, status, summary,
       comment_count, error, requested_at, completed_at)
    VALUES
      ('acme', 'widgets', 7, 'abc123', 'bot', 'posted', 'looks good',
       3, NULL, '${T0}', '${T1}'),
      ('acme', 'widgets', 7, 'def456', 'bot', 'pending', NULL,
       NULL, NULL, '${T0}', NULL),
      ('acme', 'widgets', 8, 'bad789', 'bot', 'failed', NULL,
       NULL, 'provider failed', '${T0}', '${T1}');
  `);
  legacy.close();

  try {
    const store = new ReviewStore(path);
    const row = store.get(REF);
    assert.equal(row?.phase, "posted");
    assert.equal(row?.summary, "looks good");
    assert.equal(row?.comment_count, 3);
    assert.equal(store.get({ ...REF, head_sha: "def456" })?.phase, "queued");
    assert.equal(
      store.get({ ...REF, pull_number: 8, head_sha: "bad789" })?.error,
      "provider failed"
    );
    assert.equal(store.currentForChange(REF)?.head_sha, "def456");
    assert.equal(
      store.currentForChange({ ...REF, pull_number: 8 })?.head_sha,
      "bad789"
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admitting a new head atomically advances ownership and cancels older pre-post work", () => {
  const store = freshStore();
  const first = store.admit(REF, "bot", T0);
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted")
    throw new Error("first admission should be accepted");

  const newer = { ...REF, head_sha: "def456" };
  const second = store.admit(newer, "bot", T1);
  assert.equal(second.kind, "accepted");
  if (second.kind !== "accepted")
    throw new Error("new head should be accepted");

  assert.deepEqual(second.superseded, [first.generation]);
  assert.equal(store.getGeneration(first.generation)?.phase, "cancelled");
  assert.equal(
    store.getGeneration(first.generation)?.superseded_by_sha,
    newer.head_sha
  );
  assert.equal(store.currentForChange(REF)?.generation, second.generation);
  assert.equal(store.currentForChange(REF)?.head_sha, newer.head_sha);
  store.close();
});

test("restart recovery never retries a review that crossed the posting boundary", () => {
  const store = freshStore();
  const admitted = store.admit(REF, "bot", T0);
  assert.equal(admitted.kind, "accepted");
  if (admitted.kind !== "accepted")
    throw new Error("review should be admitted");
  assert.equal(store.start(admitted.generation), true);
  assert.equal(store.startPosting(admitted.generation, T1), true);

  assert.equal(store.recoverOrphans(T1), 0);
  assert.equal(store.getGeneration(admitted.generation)?.phase, "posting");
  assert.equal(store.admit(REF, "bot", T1).kind, "duplicate");
  store.close();
});

test("a superseded posting generation records only its own remote outcome", () => {
  const store = freshStore();
  const first = store.admit(REF, "bot", T0);
  if (first.kind !== "accepted")
    throw new Error("first review should be admitted");
  assert.equal(store.start(first.generation), true);
  assert.equal(store.startPosting(first.generation, T1), true);

  const newer = { ...REF, head_sha: "def456" };
  const second = store.admit(newer, "bot", T1);
  if (second.kind !== "accepted")
    throw new Error("new review should be admitted");
  assert.equal(
    store.markGenerationPosted(first.generation, "old", 0, T1),
    true
  );

  assert.equal(store.currentForChange(REF)?.generation, second.generation);
  assert.equal(store.getGeneration(first.generation)?.phase, "posted");
  assert.equal(
    store.getGeneration(first.generation)?.superseded_by_sha,
    newer.head_sha
  );
  store.close();
});

test("a confirmed return to an older SHA receives a new monotonic generation", () => {
  const store = freshStore();
  const first = store.admit(REF, "bot", T0);
  if (first.kind !== "accepted") throw new Error("first head should be admitted");
  const secondRef = { ...REF, head_sha: "def456" };
  const second = store.admit(secondRef, "bot", T1);
  if (second.kind !== "accepted") throw new Error("second head should be admitted");

  const returned = store.admit(REF, "bot", T1);
  if (returned.kind !== "accepted") throw new Error("returned head should be admitted");
  assert.ok(returned.generation > second.generation);
  assert.equal(store.currentForChange(REF)?.head_sha, REF.head_sha);
  assert.equal(store.getGeneration(second.generation)?.phase, "cancelled");
  store.close();
});

test("distinct commands can review the same head while redelivery stays idempotent", () => {
  const store = new ReviewStore(":memory:");
  const ref = { owner: "acme", repo: "widgets", pull_number: 7, head_sha: "same" };
  const first = store.admit(ref, "bot", "t1", { id: "comment:1", kind: "command" });
  assert.equal(first.kind, "accepted");
  const redelivery = store.admit(ref, "bot", "t2", { id: "comment:1", kind: "command" });
  assert.equal(redelivery.kind, "duplicate");
  const next = store.admit(ref, "bot", "t3", { id: "comment:2", kind: "command" });
  assert.equal(next.kind, "accepted");
  assert.notEqual(next.kind === "accepted" ? next.generation : 0, first.kind === "accepted" ? first.generation : 0);
  store.close();
});
