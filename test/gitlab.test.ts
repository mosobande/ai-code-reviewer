import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  assembleUnifiedDiff,
  buildPosition,
  createGitlabProvider,
  parseMergeRequestEvent,
  type DiffRefs,
  type GitlabDiffFile,
} from "../repositories/gitlab.ts";

const BOT = 88;
const WEBHOOK_KEY = Buffer.alloc(32, 7);
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString("base64")}`;
const GITLAB_ENV = {
  GITLAB_TOKEN: "glpat-x",
  GITLAB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  REPOSITORY_ALLOWED_REPOSITORIES: "group/sub/widgets",
  GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON: '{"group/sub/widgets":17}',
};

function signedHeaders(body: Buffer, event = "Merge Request Hook", timestamp = String(Math.floor(Date.now() / 1000))) {
  const id = "delivery-1";
  const digest = createHmac("sha256", WEBHOOK_KEY)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body]))
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${digest}`,
    "x-gitlab-event": event,
  };
}

function mrPayload(overrides: Record<string, unknown> = {}): any {
  return {
    object_kind: "merge_request",
    project: { id: 100, path_with_namespace: "group/sub/widgets" },
    object_attributes: {
      iid: 42,
      action: "update",
      title: "Add retry to uploader",
      description: "Fixes flaky uploads",
      last_commit: { id: "deadbeef" },
      reviewer_ids: [55, BOT],
      assignee_ids: [],
      labels: [{ title: "deep-review" }],
    },
    reviewers: [
      { id: 55, username: "alice" },
      { id: BOT, username: "review-bot", re_requested: false },
    ],
    assignees: [],
    changes: {
      reviewers: { previous: [{ id: 55 }], current: [{ id: 55 }, { id: BOT }] },
    },
    ...overrides,
  };
}

test("parseMergeRequestEvent fires when the bot is newly added as a reviewer", () => {
  const parsed = parseMergeRequestEvent(mrPayload(), BOT);
  assert.ok(parsed, "should trigger");
  assert.equal(parsed.triggeredBy, "reviewer");
  assert.deepEqual(parsed.ref, {
    owner: "group/sub",
    repo: "widgets",
    pull_number: 42,
    head_sha: "deadbeef",
  });
  assert.equal(parsed.projectId, 100);
  assert.equal(parsed.mrIid, 42);
  assert.deepEqual(parsed.labels, ["deep-review"]);
  assert.deepEqual(parsed.intent, {
    title: "Add retry to uploader",
    body: "Fixes flaky uploads",
  });
  assert.deepEqual(parsed.reviewerIds, [55, BOT]);
});

test("parseMergeRequestEvent fires when the bot is newly added as an assignee", () => {
  const payload = mrPayload({
    reviewers: [{ id: 55, username: "alice" }],
    assignees: [{ id: BOT, username: "review-bot" }],
    object_attributes: {
      ...mrPayload().object_attributes,
      reviewer_ids: [55],
      assignee_ids: [BOT],
    },
    changes: { assignees: { previous: [], current: [{ id: BOT }] } },
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "assignee");
  assert.deepEqual(parsed.assigneeIds, [BOT]);
});

test("parseMergeRequestEvent fires on a re-request even without a membership change", () => {
  const payload = mrPayload({
    reviewers: [
      { id: 55, username: "alice" },
      { id: BOT, username: "review-bot", re_requested: true },
    ],
    changes: {}, // no reviewer delta — the bot was already a reviewer
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "reviewer");
});

test("parseMergeRequestEvent fires after a push while the bot remains assigned", () => {
  const payload = mrPayload({
    object_attributes: { ...mrPayload().object_attributes, oldrev: "old-head" },
    changes: {},
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.equal(parsed?.triggeredBy, "reviewer");
  assert.equal(parsed?.pushed, true);
});

test("parseMergeRequestEvent fires on 'open' when the bot is already a reviewer (no changes block)", () => {
  const payload = mrPayload({
    object_attributes: { ...mrPayload().object_attributes, action: "open" },
    changes: {},
  });
  const parsed = parseMergeRequestEvent(payload, BOT);
  assert.ok(parsed);
  assert.equal(parsed.triggeredBy, "reviewer");
});

test("parseMergeRequestEvent ignores events that don't add the bot", () => {
  // Bot already present before and after — not a fresh request.
  const unchanged = mrPayload({
    changes: {
      reviewers: {
        previous: [{ id: 55 }, { id: BOT }],
        current: [{ id: 55 }, { id: BOT }],
      },
    },
  });
  assert.equal(parseMergeRequestEvent(unchanged, BOT), null);
  // A different reviewer was added, not the bot.
  const someoneElse = mrPayload({
    changes: {
      reviewers: { previous: [{ id: 55 }], current: [{ id: 55 }, { id: 77 }] },
    },
  });
  assert.equal(parseMergeRequestEvent(someoneElse, BOT), null);
});

test("parseMergeRequestEvent ignores non-MR payloads and non-trigger actions", () => {
  assert.equal(parseMergeRequestEvent({ object_kind: "push" }, BOT), null);
  assert.equal(
    parseMergeRequestEvent(
      mrPayload({
        object_attributes: {
          ...mrPayload().object_attributes,
          action: "merge",
        },
      }),
      BOT
    ),
    null
  );
  assert.equal(
    parseMergeRequestEvent(
      mrPayload({
        object_attributes: {
          ...mrPayload().object_attributes,
          action: "close",
        },
      }),
      BOT
    ),
    null
  );
});

test("assembleUnifiedDiff synthesizes git/---/+++ headers and concatenates hunks", () => {
  const files: GitlabDiffFile[] = [
    { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    {
      old_path: "new.ts",
      new_path: "new.ts",
      diff: "@@ -0,0 +1 @@\n+hi",
      new_file: true,
    },
    {
      old_path: "gone.ts",
      new_path: "gone.ts",
      diff: "@@ -1 +0,0 @@\n-bye\n",
      deleted_file: true,
    },
  ];
  const out = assembleUnifiedDiff(files);
  assert.ok(
    out.includes(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@"
    )
  );
  assert.ok(
    out.includes("--- /dev/null\n+++ b/new.ts\n"),
    "added file uses /dev/null old side"
  );
  assert.ok(
    out.includes("--- a/gone.ts\n+++ /dev/null\n"),
    "deleted file uses /dev/null new side"
  );
  assert.ok(
    out.includes("+hi\n"),
    "a hunk missing a trailing newline gets one"
  );
});

test("buildPosition anchors RIGHT comments on new_line and LEFT on old_line", () => {
  const refs: DiffRefs = { base_sha: "b", start_sha: "s", head_sha: "h" };
  const right = buildPosition(
    { path: "a.ts", line: 18, side: "RIGHT", body: "x" },
    refs
  );
  assert.deepEqual(right, {
    position_type: "text",
    base_sha: "b",
    start_sha: "s",
    head_sha: "h",
    old_path: "a.ts",
    new_path: "a.ts",
    new_line: 18,
  });
  const left = buildPosition(
    { path: "a.ts", line: 7, side: "LEFT", body: "x" },
    refs
  );
  assert.equal(left.old_line, 7);
  assert.ok(!("new_line" in left), "LEFT comment carries no new_line");
});

test("buildPosition defaults to RIGHT when side is omitted", () => {
  const refs: DiffRefs = { base_sha: "b", start_sha: "s", head_sha: "h" };
  const pos = buildPosition({ path: "a.ts", line: 3, body: "x" }, refs);
  assert.equal(pos.new_line, 3);
});

test("assembleUnifiedDiff does not double-emit headers a hunk already carries", () => {
  const prefixed: GitlabDiffFile = {
    old_path: "a.ts",
    new_path: "a.ts",
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  };
  const out = assembleUnifiedDiff([prefixed]);
  assert.equal(
    out,
    prefixed.diff,
    "an already-headed hunk passes through untouched"
  );
  assert.equal(out.match(/diff --git/g)?.length, 1, "exactly one git header");
});

test("the GitLab factory constructs without throwing on an empty env", () => {
  assert.doesNotThrow(() => createGitlabProvider({}));
});

test("validateConfig requires signing token, exact allowlist, and bounded timestamp window", () => {
  assert.throws(
    () => createGitlabProvider({}).validateConfig({}),
    /GITLAB_TOKEN must be set/
  );
  assert.throws(
    () => createGitlabProvider({}).validateConfig({ GITLAB_TOKEN: "glpat-x" }),
    /GITLAB_WEBHOOK_SECRET must be set/
  );
  assert.throws(() => createGitlabProvider({}).validateConfig({
    GITLAB_TOKEN: "glpat-x", GITLAB_WEBHOOK_SECRET: "plain-secret",
  }), /valid GitLab signing token/);
  assert.throws(() => createGitlabProvider({}).validateConfig({
    GITLAB_TOKEN: "glpat-x", GITLAB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  }), /REPOSITORY_ALLOWED_REPOSITORIES/);
  assert.throws(() => createGitlabProvider({}).validateConfig({
    ...GITLAB_ENV, REPOSITORY_ALLOWED_REPOSITORIES: "group/*",
  }), /exact namespace\/repository/);
  assert.throws(() => createGitlabProvider({}).validateConfig({
    ...GITLAB_ENV, GITLAB_WEBHOOK_MAX_AGE_SECONDS: "0",
  }), /GITLAB_WEBHOOK_MAX_AGE_SECONDS/);
  assert.throws(() => createGitlabProvider({}).validateConfig({
    ...GITLAB_ENV, GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON: '{}',
  }), /GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON/);
  assert.doesNotThrow(() => createGitlabProvider(GITLAB_ENV).validateConfig(GITLAB_ENV));
});

test("parseWebhook rejects missing, stale, and mismatched Standard Webhooks signatures", async () => {
  const provider = createGitlabProvider(GITLAB_ENV);
  const body = Buffer.from(JSON.stringify(mrPayload()));
  await assert.rejects(
    () => provider.parseWebhook({ "x-gitlab-token": WEBHOOK_SECRET }, body),
    /missing webhook-id/
  );
  await assert.rejects(
    () => provider.parseWebhook(signedHeaders(body, "Merge Request Hook", String(Math.floor(Date.now() / 1000) - 301)), body),
    /stale webhook-timestamp/
  );
  await assert.rejects(() => provider.parseWebhook(signedHeaders(body), Buffer.from("{}")), /invalid webhook-signature/);
});

test("parseWebhook accepts signed in-scope requests and ignores other projects or events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => new Response(JSON.stringify(
    String(input).includes("/repository/branches/") ? { commit: { id: "target-head" } }
      : String(input).includes("/merge_requests/42") ? { target_branch: "main" }
        : { id: BOT, username: "review-bot" },
  ), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
  const provider = createGitlabProvider(GITLAB_ENV);
  await provider.init();
  const body = Buffer.from(JSON.stringify(mrPayload()));
  const accepted = await provider.parseWebhook(signedHeaders(body), body);
  assert.equal(accepted?.ref.owner, "group/sub");
  assert.deepEqual(accepted?.target, { ref: "refs/heads/main", head_sha: "target-head" });
  const outsideBody = Buffer.from(JSON.stringify(mrPayload({
    project: { id: 100, path_with_namespace: "group/sub/other" },
  })));
  assert.equal(await provider.parseWebhook(signedHeaders(outsideBody), outsideBody), null);
  const result = await provider.parseWebhook(
    signedHeaders(body, "Push Hook"),
    body,
  );
  assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readTrustedFile pins the target head and distinguishes absent from incomplete", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let status = 200;
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    if (status !== 200) return new Response("error", { status });
    return new Response(JSON.stringify({
      encoding: "base64", blob_id: "trusted-blob",
      content: Buffer.from("version: 2\nreview: {}\n").toString("base64"),
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = createGitlabProvider(GITLAB_ENV);
    const req = {
      ref: { owner: "group/sub", repo: "widgets", pull_number: 42, head_sha: "source" },
      reviewer: String(BOT), labels: [], intent: {}, deepCapable: true,
      context: { projectId: 100, mrIid: 42 },
    };
    const file = await provider.readTrustedFile(req, { path: ".acr.yml", targetHeadSha: "target-sha" });
    assert.deepEqual(file, { state: "observed", blobSha: "trusted-blob", content: "version: 2\nreview: {}\n" });
    assert.match(requests[0]!, /repository\/files\/\.acr\.yml\?ref=target-sha/);
    status = 404;
    assert.deepEqual(await provider.readTrustedFile(req, { path: ".acr.yml", targetHeadSha: "target-sha" }), { state: "absent" });
    status = 403;
    assert.equal((await provider.readTrustedFile(req, { path: ".acr.yml", targetHeadSha: "target-sha" })).state, "incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signed top-level command and finding reply use live MR ownership and head", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    let value: unknown;
    if (url.endsWith("/user")) value = { id: BOT, username: "review-bot" };
    else if (url.endsWith("/users/55")) value = { id: 55, bot: false };
    else if (url.endsWith("/merge_requests/42")) value = {
      state: "opened", author: { id: 55 }, diff_refs: { head_sha: "live-head" }, target_branch: "main",
      title: "Live title", description: "Live body", labels: ["bug"],
    };
    else if (url.endsWith("/repository/branches/main")) value = { commit: { id: "target-head" } };
    else if (url.endsWith("/discussions/thread-1")) value = {
      notes: [
        { id: 10, author: { id: BOT, username: "review-bot" }, body: "Please fix", position: { new_path: "src/a.ts", new_line: 12 } },
        { id: 91, author: { id: 55, username: "alice" }, body: "Fixed", position: null },
      ],
    };
    else throw new Error(`unexpected GitLab API: ${url}`);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = createGitlabProvider(GITLAB_ENV);
    await provider.init();
    const base = {
      object_kind: "note", project: { id: 100, path_with_namespace: "group/sub/widgets" },
      merge_request: { iid: 42 }, user: { id: 55 },
      object_attributes: { id: 91, action: "create", noteable_type: "MergeRequest", note: "@review-bot full review" },
    };
    const commandBody = Buffer.from(JSON.stringify(base));
    const command = await provider.parseWebhook(signedHeaders(commandBody, "Note Hook"), commandBody);
    assert.deepEqual(command?.trigger, { kind: "command", requestedMode: "full", id: "delivery-1" });
    assert.equal(command?.ref.head_sha, "live-head");
    assert.deepEqual(command?.target, { ref: "refs/heads/main", head_sha: "target-head" });
    const replyBody = Buffer.from(JSON.stringify({
      ...base, object_attributes: { ...base.object_attributes, note: "Fixed", discussion_id: "thread-1" },
    }));
    const reply = await provider.parseWebhook(signedHeaders(replyBody, "Note Hook"), replyBody);
    assert.deepEqual(reply?.trigger, {
      kind: "finding_reply", requestedMode: "targeted", id: "delivery-1",
      finding: { path: "src/a.ts", line: 12, externalId: "thread-1", conversation: [
        { author: "review-bot", body: "Please fix" }, { author: "alice", body: "Fixed" },
      ] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getCurrentTarget and fetchDiffRange use live target and exact complete comparison", async () => {
  const originalFetch = globalThis.fetch;
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const requests: string[] = [];
  let compareComplete = true;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    const value = url.includes("/repository/branches/") ? { commit: { id: "target-head" } }
      : url.includes("/repository/compare") ? { compare_timeout: !compareComplete, diffs: [
        { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ] } : { target_branch: "main", diff_refs: { head_sha: head } };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = createGitlabProvider(GITLAB_ENV);
    const req = {
      ref: { owner: "group/sub", repo: "widgets", pull_number: 42, head_sha: head },
      reviewer: String(BOT), labels: [], intent: {}, deepCapable: true,
      context: { projectId: 100, mrIid: 42 },
    };
    assert.deepEqual(await provider.getCurrentTarget(req), { ref: "refs/heads/main", head_sha: "target-head" });
    const observed = await provider.fetchDiffRange(req, base, head);
    assert.equal(observed.state, "observed");
    assert.match(requests.at(-1)!, /from=a{40}&to=b{40}&straight=true&unidiff=true/);
    compareComplete = false;
    assert.equal((await provider.fetchDiffRange(req, base, head)).state, "incomplete");
    assert.equal((await provider.fetchDiffRange(req, base, "c".repeat(40))).state, "incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitLab effects mutate only configured check and bot-owned approval, note, and finding", async () => {
  const originalFetch = globalThis.fetch;
  const writes: Array<{ method: string; path: string; body: any }> = [];
  let approved = false;
  let noteBody = "<!-- acr:walkthrough -->\nOld summary";
  let findingResolved = false;
  let replyPosted = false;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, path, body });
    let value: any = {};
    if (path.endsWith("/user")) value = { id: BOT, username: "review-bot" };
    else if (path.endsWith("/merge_requests/42")) value = {
      state: "opened", target_branch: "main", diff_refs: { head_sha: "review-head" },
    };
    else if (path.endsWith("/repository/branches/main")) value = { commit: { id: "target-head" } };
    else if (path.endsWith("/approvals")) value = { approved_by: [
      { user: { id: 55 } }, ...(approved ? [{ user: { id: BOT } }] : []),
    ] };
    else if (path.endsWith("/approve")) approved = true;
    else if (path.endsWith("/unapprove")) approved = false;
    else if (path.endsWith("/notes") && method === "GET") value = [
      { id: 7, author: { id: 55 }, body: "Human note" },
      { id: 8, author: { id: BOT }, body: noteBody },
    ];
    else if (path.endsWith("/notes/8") && method === "PUT") { noteBody = body.body; value = { id: 8 }; }
    else if (path.endsWith("/discussions/thread-1") && method === "GET") value = {
      id: "thread-1", notes: [
        { id: 10, author: { id: BOT }, body: "Finding", position: { new_path: "a.ts", new_line: 2 }, resolvable: true, resolved: findingResolved },
        ...(replyPosted ? [{ id: 11, author: { id: BOT }, body: "Resolved after fix" }] : []),
      ],
    };
    else if (path.endsWith("/discussions/thread-1/notes") && method === "POST") { replyPosted = true; value = { id: 11 }; }
    else if (path.endsWith("/discussions/thread-1") && method === "PUT") { findingResolved = body.resolved; value = { id: "thread-1" }; }
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const provider = createGitlabProvider(GITLAB_ENV);
    await provider.init();
    const req = {
      ref: { owner: "group/sub", repo: "widgets", pull_number: 42, head_sha: "review-head" },
      target: { ref: "refs/heads/main", head_sha: "target-head" },
      reviewer: String(BOT), labels: [], intent: {}, deepCapable: true,
      context: { projectId: 100, mrIid: 42 },
    };
    await provider.upsertReviewCheck(req, 3, "success", "Reviewed");
    assert.deepEqual(writes[0]?.body, {
      sha: "review-head", external_status_check_id: 17, status: "passed",
    });
    await provider.reconcileOwnedApproval(req, "present");
    await provider.reconcileOwnedApproval(req, "present");
    await provider.reconcileOwnedApproval(req, "absent");
    assert.equal(writes.filter(({ path }) => path.endsWith("/approve")).length, 1);
    assert.equal(writes.filter(({ path }) => path.endsWith("/unapprove")).length, 1);
    await provider.upsertWalkthrough(req, "New summary");
    assert.equal(noteBody, "<!-- acr:walkthrough -->\nNew summary");
    assert.equal(writes.some(({ path }) => path.endsWith("/notes/7")), false);
    await provider.resolveFinding(req, "thread-1", "Resolved after fix");
    await provider.resolveFinding(req, "thread-1", "Resolved after fix");
    assert.equal(writes.filter(({ path }) => path.endsWith("/discussions/thread-1/notes")).length, 1);
    assert.equal(writes.filter(({ path, method }) => path.endsWith("/discussions/thread-1") && method === "PUT").length, 1);
    const unconfigured = createGitlabProvider({
      ...GITLAB_ENV, GITLAB_EXTERNAL_STATUS_CHECK_IDS_JSON: "{}",
    });
    await assert.rejects(() => unconfigured.upsertReviewCheck(req, 3, "failure", "No check"), /not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitLab stops a multi-request review as soon as generation ownership changes", async () => {
  const originalFetch = globalThis.fetch;
  const mutations: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v4/user")) {
      return new Response(JSON.stringify({ id: BOT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "POST") mutations.push(url);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const provider = createGitlabProvider({
      GITLAB_TOKEN: "glpat-x",
      GITLAB_WEBHOOK_SECRET: "s",
    });
    await provider.init();
    const request = {
      ref: {
        owner: "group",
        repo: "widgets",
        pull_number: 42,
        head_sha: "head",
      },
      reviewer: String(BOT),
      labels: [],
      intent: { title: "test", body: "" },
      deepCapable: true,
      context: {
        projectId: 100,
        mrIid: 42,
        diffRefs: { base_sha: "base", start_sha: "start", head_sha: "head" },
      },
    };
    let guardCalls = 0;
    const posted = await provider.postReview(
      request,
      "summary",
      [
        { path: "a.ts", line: 1, body: "one" },
        { path: "b.ts", line: 2, body: "two" },
      ],
      async () => ++guardCalls === 1
    );

    assert.deepEqual(posted, { status: "superseded" });
    assert.equal(
      mutations.length,
      1,
      "only the mutation accepted before supersession may finish"
    );
    assert.equal("clearReviewRequest" in provider, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitLab reports a partial multi-request review as ambiguous and stops posting", async () => {
  const originalFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      postCount += 1;
      if (postCount === 2) {
        return new Response("upstream response lost", { status: 503 });
      }
    }
    return new Response(JSON.stringify(init?.method === "GET" ? { id: BOT } : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const provider = createGitlabProvider({
      GITLAB_TOKEN: "glpat-x",
      GITLAB_WEBHOOK_SECRET: "s",
    });
    await provider.init();
    const result = await provider.postReview(
      {
        ref: {
          owner: "group",
          repo: "widgets",
          pull_number: 42,
          head_sha: "head",
        },
        reviewer: String(BOT),
        labels: [],
        intent: { title: "test", body: "" },
        deepCapable: true,
        context: {
          projectId: 100,
          mrIid: 42,
          diffRefs: { base_sha: "base", start_sha: "start", head_sha: "head" },
        },
      },
      "summary",
      [
        { path: "a.ts", line: 1, body: "one" },
        { path: "b.ts", line: 2, body: "two" },
        { path: "c.ts", line: 3, body: "three" },
      ],
      async () => true
    );

    assert.deepEqual(result, { status: "ambiguous", commentCount: 1 });
    assert.equal(postCount, 2, "no later inline comment or summary may be posted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const acceptedBeforeRejection of [0, 1]) {
  test(`GitLab skips a definitive inline rejection after ${acceptedBeforeRejection} accepted comment(s) and posts the summary`, async () => {
    const originalFetch = globalThis.fetch;
    let postCount = 0;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "POST") {
        postCount += 1;
        if (postCount === acceptedBeforeRejection + 1) {
          return new Response("invalid position", { status: 400 });
        }
      }
      return new Response(JSON.stringify(init?.method === "GET" ? { id: BOT } : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const provider = createGitlabProvider({
        GITLAB_TOKEN: "glpat-x",
        GITLAB_WEBHOOK_SECRET: "s",
      });
      await provider.init();
      const result = await provider.postReview(
        {
          ref: {
            owner: "group",
            repo: "widgets",
            pull_number: 42,
            head_sha: "head",
          },
          reviewer: String(BOT),
          labels: [],
          intent: { title: "test", body: "" },
          deepCapable: true,
          context: {
            projectId: 100,
            mrIid: 42,
            diffRefs: { base_sha: "base", start_sha: "start", head_sha: "head" },
          },
        },
        "summary",
        acceptedBeforeRejection === 0
          ? [{ path: "a.ts", line: 1, body: "one" }]
          : [
              { path: "a.ts", line: 1, body: "one" },
              { path: "b.ts", line: 2, body: "two" },
            ],
        async () => true
      );

      assert.deepEqual(result, {
        status: "posted",
        commentCount: acceptedBeforeRejection,
      });
      assert.equal(
        postCount,
        acceptedBeforeRejection + 2,
        "each inline attempt and the summary are bounded"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
