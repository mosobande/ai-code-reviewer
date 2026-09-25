import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseInstanceReviewPolicy,
  parseRepositoryPolicy,
  parseReviewGate,
  resolveReviewPolicy,
} from "../review-policy.ts";

test("instance defaults and operator gates are strict", () => {
  assert.deepEqual(parseInstanceReviewPolicy({}), { approval: "human", automatic: false, depth: "default" });
  assert.deepEqual(parseInstanceReviewPolicy({ ACR_APPROVAL_MODE: " BOT " }), { approval: "bot", automatic: false, depth: "default" });
  assert.throws(() => parseInstanceReviewPolicy({ ACR_APPROVAL_MODE: "merge" }), /ACR_APPROVAL_MODE/);
  assert.equal(parseReviewGate(undefined, "ADMISSION"), false);
  assert.equal(parseReviewGate("true", "ADMISSION"), true);
  assert.equal(parseReviewGate("false", "ADMISSION"), false);
  assert.throws(() => parseReviewGate("yes", "ADMISSION"), /must be "true" or "false"/);
});

test("repository policy accepts review controls and has a stable semantic digest", () => {
  const parsed = parseRepositoryPolicy("version: 2\nreview:\n  approval: bot\n  automatic: true\n  depth: diff-only\n");
  assert.deepEqual(parsed.review, { approval: "bot", automatic: true, depth: "diff-only" });
  assert.equal(
    parsed.contentDigest,
    parseRepositoryPolicy("review: { depth: diff-only, automatic: true, approval: bot }\nversion: 2\n").contentDigest,
  );
  for (const content of [
    "version: 1\nreview: { approval: bot }\n",
    "version: 2\nreview: { approval: merge }\n",
    "version: 2\nreview: { automatic: yes }\n",
    "version: 2\nreview: { depth: shallow }\n",
    "version: 2\nreview: { title: placeholder }\n",
    "version: 2\nreview: { semantic_labels: [bug] }\n",
    "version: 2\nreview: { change_summary: suggest }\n",
    "version: 2\nbuilder: { enabled: true }\nreview: {}\n",
    "version: 2\n",
  ]) assert.throws(() => parseRepositoryPolicy(content));
});

test("trusted target-head observation determines the effective policy", () => {
  const instance = parseInstanceReviewPolicy({ ACR_APPROVAL_MODE: "bot" });
  const absent = resolveReviewPolicy(instance, "refs/heads/main", "target-1", { state: "absent" });
  assert.deepEqual(absent.effective, { approval: "bot", automatic: false, depth: "default" });
  assert.deepEqual(absent.sources, { approval: "instance", automatic: "instance", depth: "instance" });
  const observed = resolveReviewPolicy(instance, "refs/heads/main", "target-1", {
    state: "observed",
    blobSha: "blob-1",
    content: "version: 2\nreview: { approval: human, automatic: true, depth: contextual }\n",
  });
  assert.deepEqual(observed.effective, { approval: "human", automatic: true, depth: "contextual" });
  assert.deepEqual(observed.sources, { approval: ".acr.yml", automatic: ".acr.yml", depth: ".acr.yml" });
  assert.notEqual(observed.digest, absent.digest);
  assert.notEqual(
    observed.digest,
    resolveReviewPolicy(instance, "refs/heads/main", "target-2", {
      state: "observed", blobSha: "blob-1", content: "version: 2\nreview: { approval: human }\n",
    }).digest,
  );
});

test("invalid and unreadable policy fail closed", () => {
  const instance = parseInstanceReviewPolicy({ ACR_APPROVAL_MODE: "bot" });
  const invalid = resolveReviewPolicy(instance, "refs/heads/main", "target", {
    state: "observed", blobSha: "blob", content: "version: 2\nreview: { approval: merge }\n",
  });
  assert.equal(invalid.effective, null);
  assert.match(invalid.error ?? "", /invalid \.acr\.yml/);
  const incomplete = resolveReviewPolicy(instance, "refs/heads/main", "target", {
    state: "incomplete", reason: "contents response was truncated",
  });
  assert.equal(incomplete.effective, null);
  assert.match(incomplete.error ?? "", /could not be read completely/);
  assert.notEqual(invalid.digest, incomplete.digest);
});

test("strict YAML excludes duplicates, aliases, anchors, invalid text and oversize input", () => {
  for (const content of [
    "version: 2\nversion: 2\nreview: {}\n",
    "version: &version 2\nreview: {}\n",
    "version: 2\nreview: &review {}\ncopy: *review\n",
    "version: 2\nreview: { approval: bot }\nextra: true\n",
    "version: 2\nreview:\n  approval: bot\u0000\n",
    "version: 2\nreview: { approval: bot }\n#\uFFFD",
  ]) assert.throws(() => parseRepositoryPolicy(content));
  assert.throws(() => parseRepositoryPolicy(`#${"x".repeat(16_384)}`), /16 KiB/);
});

test("shipped example is valid", () => {
  const example = readFileSync(new URL("../.acr.yml.example", import.meta.url), "utf8");
  assert.deepEqual(parseRepositoryPolicy(example).review, {
    approval: "human", automatic: false, depth: "contextual",
  });
});
