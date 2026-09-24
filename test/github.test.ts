import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGithubProvider,
  loadAppPrivateKey,
} from "../repositories/github.ts";

const FULL_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test",
  REVIEWER_LOGIN: "ayewobot",
  GITHUB_ALLOWED_OWNERS: "quantipixels",
};

function reviewRequestedPayload(owner: string, repo: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "review_requested",
      requested_reviewer: { login: "ayewobot" },
      repository: { owner: { login: owner }, name: repo },
      pull_request: {
        number: 9,
        head: { sha: "abc123" },
        labels: [],
        title: "Test allowlist",
        body: "",
      },
    })
  );
}

function githubProviderForWebhook(env: NodeJS.ProcessEnv) {
  return createGithubProvider(env, {
    createApp: () =>
      ({
        webhooks: { verify: async () => true },
      } as never),
  });
}

test("the factory constructs without throwing on an empty env (App is built lazily in init)", () => {
  assert.doesNotThrow(() => createGithubProvider({}));
});

test("validateConfig requires the App credentials", () => {
  const provider = createGithubProvider(FULL_ENV);
  for (const missing of [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ] as const) {
    const env = { ...FULL_ENV, [missing]: undefined };
    assert.throws(
      () => createGithubProvider(env).validateConfig(env),
      new RegExp(`${missing} must be set`)
    );
  }
  assert.doesNotThrow(() => provider.validateConfig(FULL_ENV));
});

test("validateConfig requires at least one REVIEWER_LOGIN", () => {
  const env = { ...FULL_ENV, REVIEWER_LOGIN: "  ,  " };
  assert.throws(
    () => createGithubProvider(env).validateConfig(env),
    /REVIEWER_LOGIN must list at least one login/
  );
});

test("validateConfig requires at least one allowed GitHub owner or repository", () => {
  const env = {
    ...FULL_ENV,
    GITHUB_ALLOWED_OWNERS: "  ,  ",
    GITHUB_ALLOWED_REPOSITORIES: "",
  };
  assert.throws(
    () => createGithubProvider(env).validateConfig(env),
    /GITHUB_ALLOWED_OWNERS or GITHUB_ALLOWED_REPOSITORIES must list at least one scope/
  );
});

test("validateConfig rejects malformed GitHub repository scopes", () => {
  for (const value of [
    "repo-only",
    "/repo",
    "owner/",
    "owner/repo/extra",
    "owner /repo",
  ]) {
    const env = {
      ...FULL_ENV,
      GITHUB_ALLOWED_OWNERS: "",
      GITHUB_ALLOWED_REPOSITORIES: value,
    };
    assert.throws(
      () => createGithubProvider(env).validateConfig(env),
      /GITHUB_ALLOWED_REPOSITORIES must contain owner\/repo entries/
    );
  }
});

test("validateConfig rejects malformed GitHub owner scopes", () => {
  for (const value of ["owner/repo", "two words", "/owner"]) {
    const env = { ...FULL_ENV, GITHUB_ALLOWED_OWNERS: value };
    assert.throws(
      () => createGithubProvider(env).validateConfig(env),
      /GITHUB_ALLOWED_OWNERS must contain owner names/
    );
  }
});

test("parseWebhook rejects a delivery missing the signature header (→ 400)", async () => {
  const provider = createGithubProvider(FULL_ENV);
  await assert.rejects(
    () =>
      provider.parseWebhook(
        { "x-github-event": "pull_request" },
        Buffer.from("{}")
      ),
    /missing X-Hub-Signature-256/
  );
});

test("parseWebhook accepts an allowed owner case-insensitively", async () => {
  const provider = githubProviderForWebhook({
    ...FULL_ENV,
    GITHUB_ALLOWED_OWNERS: "QuantiPixels",
  });
  await provider.init();
  const request = await provider.parseWebhook(
    { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" },
    reviewRequestedPayload("quantipixels", "skills")
  );

  assert.equal(request?.ref.owner, "quantipixels");
  assert.equal(request?.ref.repo, "skills");
});

test("parseWebhook accepts an exact allowed repository outside the owner allowlist", async () => {
  const provider = githubProviderForWebhook({
    ...FULL_ENV,
    GITHUB_ALLOWED_OWNERS: "another-org",
    GITHUB_ALLOWED_REPOSITORIES: "QuantiPixels/Skills",
  });
  await provider.init();
  const request = await provider.parseWebhook(
    { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" },
    reviewRequestedPayload("quantipixels", "skills")
  );

  assert.equal(request?.ref.repo, "skills");
});

test("parseWebhook ignores an out-of-scope repository and logs only its public identity", async () => {
  const provider = githubProviderForWebhook(FULL_ENV);
  await provider.init();
  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const request = await provider.parseWebhook(
      {
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=test",
      },
      reviewRequestedPayload("outside-org", "private-repo")
    );
    assert.equal(request, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(logs, [
    "[github] ignored review request outside allowlist: outside-org/private-repo",
  ]);
  assert.ok(!logs[0]?.includes(FULL_ENV.GITHUB_WEBHOOK_SECRET));
});

test("loadAppPrivateKey passes through a real PEM and un-escapes \\n one-liners", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  assert.equal(loadAppPrivateKey(pem), pem, "real-newline PEM is left intact");
  const escaped =
    "-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJ\\n-----END RSA PRIVATE KEY-----";
  assert.equal(
    loadAppPrivateKey(escaped),
    pem,
    "\\n escapes become real newlines"
  );
});

test("loadAppPrivateKey base64-decodes a key with no BEGIN marker", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  const b64 = Buffer.from(pem).toString("base64");
  assert.equal(
    loadAppPrivateKey(b64),
    pem,
    "base64(PEM) is decoded back to the PEM"
  );
});

test("GitHub reads the live pull-request head and pins primary and fallback reviews to it", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const octokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: "abc123" } } }),
        createReview: async (input: Record<string, unknown>) => {
          calls.push(input);
          if (calls.length === 1)
            throw Object.assign(new Error("inline rejected"), { status: 422 });
        },
      },
    },
  };
  const provider = createGithubProvider(FULL_ENV);
  const request = {
    ref: {
      owner: "quantipixels",
      repo: "atunwo",
      pull_number: 9,
      head_sha: "abc123",
    },
    reviewer: "ayewobot",
    labels: [],
    intent: { title: "test", body: "" },
    deepCapable: false,
    context: { octokit },
  };

  assert.equal(await provider.getCurrentHead(request), "abc123");
  assert.deepEqual(
    await provider.postReview(
      request,
      "summary",
      [{ path: "src/index.ts", line: 1, body: "fix this" }],
      async () => true
    ),
    { status: "posted", commentCount: 0 }
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.commit_id, "abc123");
  assert.equal(calls[1]?.commit_id, "abc123");
});

test("GitHub provider exposes no automatic reviewer-clear capability", () => {
  const provider = createGithubProvider(FULL_ENV);
  assert.equal("clearReviewRequest" in provider, false);
});

test("automatic review scope requires exact allowed owner/repository names", () => {
  const valid = { ...FULL_ENV, GITHUB_AUTO_REVIEW_REPOSITORIES: "QuantiPixels/Skills" };
  assert.doesNotThrow(() => createGithubProvider(valid).validateConfig(valid));
  for (const scope of ["skills", "outside/skills", "quantipixels/", "quantipixels/skills/extra"]) {
    const env = { ...FULL_ENV, GITHUB_AUTO_REVIEW_REPOSITORIES: scope };
    assert.throws(() => createGithubProvider(env).validateConfig(env), /GITHUB_AUTO_REVIEW_REPOSITORIES/);
  }
});

test("automatic review triggers only eligible human, ready PR events in opted-in repositories", async () => {
  const env = { ...FULL_ENV, GITHUB_AUTO_REVIEW_REPOSITORIES: "quantipixels/skills" };
  const provider = createGithubProvider(env, {
    createApp: () => ({
      webhooks: { verify: async () => true },
      getInstallationOctokit: async () => ({}),
    } as never),
  });
  await provider.init();
  const headers = { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" };
  const base = {
    repository: { owner: { login: "quantipixels" }, name: "skills" },
    installation: { id: 3 },
    pull_request: {
      number: 9, head: { sha: "abc123" }, base: { ref: "main", sha: "base123" },
      labels: [], title: "Change", body: "",
      state: "open", draft: false, user: { login: "human", type: "User" },
    },
  };
  const parse = (payload: object) => provider.parseWebhook(headers, Buffer.from(JSON.stringify(payload)));
  for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
    const request = await parse({ ...base, action });
    assert.equal(request?.reviewer, "ayewobot");
    assert.deepEqual(request?.target, { ref: "refs/heads/main", head_sha: "base123" });
  }
  for (const patch of [
    { pull_request: { ...base.pull_request, draft: true } },
    { pull_request: { ...base.pull_request, user: { login: "automation[bot]", type: "Bot" } } },
    { pull_request: { ...base.pull_request, user: { login: "ayewobot", type: "User" } } },
    { installation: undefined },
    { repository: { owner: { login: "quantipixels" }, name: "other" } },
  ]) {
    assert.equal(await parse({ ...base, ...patch, action: "opened" }), null);
  }
  assert.equal(await parse({ ...base, action: "closed" }), null);
});

test("a requested reviewer remains assigned when a PR head synchronizes", async () => {
  const provider = githubProviderForWebhook(FULL_ENV);
  await provider.init();
  const payload = JSON.parse(reviewRequestedPayload("quantipixels", "skills").toString());
  payload.action = "synchronize";
  payload.pull_request.requested_reviewers = [{ login: "ayewobot" }];
  const result = await provider.parseWebhook(
    { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" },
    Buffer.from(JSON.stringify(payload)),
  );
  assert.equal(result?.ref.head_sha, "abc123");
});

test("GitHub reads the live protected target separately from the webhook snapshot", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const octokit = { rest: { pulls: { get: async (input: Record<string, unknown>) => {
    calls.push(input);
    return { data: { base: { ref: "release/next", sha: "live-base" } } };
  } } } };
  const provider = createGithubProvider(FULL_ENV);
  const req = {
    ref: { owner: "quantipixels", repo: "skills", pull_number: 9, head_sha: "abc123" },
    target: { ref: "refs/heads/main", head_sha: "old-base" },
    reviewer: "ayewobot", labels: [], intent: {}, deepCapable: false, context: { octokit },
  };
  assert.deepEqual(await provider.getCurrentTarget(req), {
    ref: "refs/heads/release/next", head_sha: "live-base",
  });
  assert.deepEqual(calls[0], { owner: "quantipixels", repo: "skills", pull_number: 9, request: { signal: undefined } });
});

test("trusted file reads are pinned to the supplied base SHA and distinguish absent/incomplete", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let response: unknown = { data: {
    type: "file", encoding: "base64", content: Buffer.from("review:\n  approval: human\n").toString("base64"), sha: "blob123",
  } };
  const octokit = { rest: { repos: { getContent: async (input: Record<string, unknown>) => {
    calls.push(input);
    if (response instanceof Error) throw response;
    return response;
  } } } };
  const provider = createGithubProvider(FULL_ENV);
  const req = {
    ref: { owner: "quantipixels", repo: "skills", pull_number: 9, head_sha: "untrusted-head" },
    reviewer: "ayewobot", labels: [], intent: {}, deepCapable: false, context: { octokit },
  };
  const input = { path: ".acr.yml", targetHeadSha: "trusted-base" };
  assert.deepEqual(await provider.readTrustedFile(req, input), {
    state: "observed", blobSha: "blob123", content: "review:\n  approval: human\n",
  });
  assert.equal(calls[0]?.ref, "trusted-base");
  response = Object.assign(new Error("missing"), { status: 404 });
  assert.deepEqual(await provider.readTrustedFile(req, input), { state: "absent" });
  response = { data: { type: "dir" } };
  assert.equal((await provider.readTrustedFile(req, input)).state, "incomplete");
  response = Object.assign(new Error("forbidden"), { status: 403 });
  assert.equal((await provider.readTrustedFile(req, input)).state, "incomplete");
});

test("GitHub incremental diff requires a complete forward comparison at the recorded head", async () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  let comparison: unknown = { data: {
    status: "ahead", total_commits: 2, files: [{ filename: "src/a.ts", patch: "@@ -1 +1 @@" }],
  } };
  const calls: Array<Record<string, unknown>> = [];
  const octokit = {
    rest: { repos: { compareCommits: async (input: Record<string, unknown>) => {
      calls.push(input);
      return comparison;
    } } },
    request: async (_route: string, input: Record<string, unknown>) => {
      calls.push(input);
      return { data: "diff --git a/src/a.ts b/src/a.ts\n" };
    },
  };
  const provider = createGithubProvider(FULL_ENV);
  const req = {
    ref: { owner: "quantipixels", repo: "skills", pull_number: 9, head_sha: headSha },
    reviewer: "ayewobot", labels: [], intent: {}, deepCapable: false, context: { octokit },
  };
  assert.deepEqual(await provider.fetchDiffRange(req, baseSha, headSha), {
    state: "observed", diff: "diff --git a/src/a.ts b/src/a.ts\n",
  });
  assert.equal(calls[0]?.base, baseSha);
  assert.equal(calls[0]?.head, headSha);
  assert.deepEqual(calls[1]?.mediaType, { format: "diff" });
  const priorCalls = calls.length;
  assert.equal((await provider.fetchDiffRange(req, baseSha, "c".repeat(40))).state, "incomplete");
  assert.equal(calls.length, priorCalls);
  for (const data of [
    { status: "diverged", total_commits: 2, files: [{ patch: "x" }] },
    { status: "ahead", total_commits: 251, files: [{ patch: "x" }] },
    { status: "ahead", total_commits: 2, files: Array.from({ length: 300 }, () => ({ patch: "x" })) },
    { status: "ahead", total_commits: 2, files: [{ filename: "image.png" }] },
  ]) {
    comparison = { data };
    assert.equal((await provider.fetchDiffRange(req, baseSha, headSha)).state, "incomplete");
  }
});

test("exact top-level review commands require a human PR author or collaborator", async () => {
  const pr = {
    number: 9, head: { sha: "abc123" }, base: { ref: "main", sha: "base123" },
    labels: [], title: "Change", body: "",
    user: { login: "alice", type: "User" },
  };
  let reads = 0;
  const provider = createGithubProvider(FULL_ENV, {
    createApp: () => ({
      webhooks: { verify: async () => true },
      getInstallationOctokit: async () => ({ rest: { pulls: { get: async () => {
        reads += 1;
        return { data: pr };
      } } } }),
    } as never),
  });
  await provider.init();
  const headers = { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=test" };
  const base = {
    action: "created", repository: { owner: { login: "quantipixels" }, name: "skills" },
    installation: { id: 3 }, issue: { number: 9, pull_request: {} },
    comment: {
      id: 42, body: "@ayewobot review", user: { login: "alice", type: "User" },
      author_association: "NONE", created_at: "now", updated_at: "now",
    },
  };
  const parse = (payload: object) => provider.parseWebhook(headers, Buffer.from(JSON.stringify(payload)));
  assert.deepEqual((await parse(base))?.trigger, {
    kind: "command", id: "issue-comment:42", requestedMode: "incremental",
  });
  assert.deepEqual((await parse(base))?.target, { ref: "refs/heads/main", head_sha: "base123" });
  assert.equal((await parse({ ...base, comment: { ...base.comment, body: "@ayewobot full review" } }))?.trigger?.requestedMode, "full");
  const priorReads = reads;
  for (const body of ["please @ayewobot review", "@ayewobot review now", "@ayewobot looks good", "@other review"]) {
    assert.equal(await parse({ ...base, comment: { ...base.comment, body } }), null);
  }
  assert.equal(reads, priorReads, "noncommands avoid a PR API read");
  for (const patch of [
    { user: { login: "outsider", type: "User" } },
    { user: { login: "automation[bot]", type: "Bot" } },
    { updated_at: "later" },
  ]) {
    assert.equal(await parse({ ...base, comment: { ...base.comment, ...patch } }), null);
  }
});

test("finding replies target only an owned bot review comment", async () => {
  const parent = {
    user: { login: "pepeye[bot]" }, pull_request_review_id: 12,
    path: "src/a.ts", line: 7, body: "Fix this edge case",
    pull_request_url: "https://api.github.com/repos/quantipixels/skills/pulls/9",
  };
  let observedParent: typeof parent = parent;
  const provider = createGithubProvider(FULL_ENV, {
    appBotLogin: "pepeye[bot]",
    createApp: () => ({
      webhooks: { verify: async () => true },
      getInstallationOctokit: async () => ({ rest: { pulls: {
        getReviewComment: async () => ({ data: observedParent }),
      } } }),
    } as never),
  });
  await provider.init();
  const headers = { "x-github-event": "pull_request_review_comment", "x-hub-signature-256": "sha256=test" };
  const base = {
    action: "created", repository: { owner: { login: "quantipixels" }, name: "skills" },
    installation: { id: 3 }, pull_request: {
      number: 9, head: { sha: "abc123" }, base: { ref: "main", sha: "base123" },
      labels: [], title: "Change", body: "",
      user: { login: "alice", type: "User" },
    },
    comment: {
      id: 43, in_reply_to_id: 41, body: "I fixed this", user: { login: "alice", type: "User" },
      author_association: "NONE", created_at: "now", updated_at: "now",
    },
  };
  const parse = (payload: object) => provider.parseWebhook(headers, Buffer.from(JSON.stringify(payload)));
  assert.deepEqual((await parse(base))?.trigger, {
    kind: "finding_reply", requestedMode: "targeted", id: "review-comment:43",
    finding: { externalId: "41", path: "src/a.ts", line: 7, conversation: [
      { author: "pepeye[bot]", body: "Fix this edge case" },
      { author: "alice", body: "I fixed this" },
    ] },
  });
  assert.deepEqual((await parse(base))?.target, { ref: "refs/heads/main", head_sha: "base123" });
  observedParent = { ...parent, user: { login: "other[bot]" } };
  assert.equal(await parse(base), null);
  assert.equal(await parse({ ...base, comment: { ...base.comment, in_reply_to_id: undefined } }), null);
});

function effectRequest(octokit: unknown) {
  return {
    ref: { owner: "quantipixels", repo: "skills", pull_number: 9, head_sha: "a".repeat(40) },
    target: { ref: "refs/heads/main", head_sha: "b".repeat(40) },
    reviewer: "ayewobot", labels: [], intent: {}, deepCapable: false, context: { octokit },
  };
}

function livePr(req: ReturnType<typeof effectRequest>) {
  return { state: "open", head: { sha: req.ref.head_sha }, base: { ref: "main", sha: req.target.head_sha } };
}

test("review check upserts only the App-owned generation at the exact PR head and base", async () => {
  const mutations: Array<{ action: string; input: Record<string, unknown> }> = [];
  let checkRuns: Array<{ id: number; external_id: string; app: { id: number } }> = [];
  let current: ReturnType<typeof livePr>;
  const octokit = { rest: {
    pulls: { get: async () => ({ data: current }) },
    checks: {
      listForRef: async () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } }),
      create: async (input: Record<string, unknown>) => { mutations.push({ action: "create", input }); },
      update: async (input: Record<string, unknown>) => { mutations.push({ action: "update", input }); },
    },
  } };
  const req = effectRequest(octokit);
  current = livePr(req);
  const provider = createGithubProvider(FULL_ENV);
  await provider.upsertReviewCheck(req, 2, "pending", "Review in progress");
  assert.equal(mutations[0]?.action, "create");
  assert.equal(mutations[0]?.input.head_sha, req.ref.head_sha);
  assert.equal(mutations[0]?.input.status, "in_progress");
  const id = mutations[0]?.input.external_id as string;
  checkRuns = [{ id: 7, external_id: id, app: { id: Number(FULL_ENV.GITHUB_APP_ID) } }];
  await provider.upsertReviewCheck(req, 2, "success", "Passed");
  assert.equal(mutations[1]?.action, "update");
  assert.equal(mutations[1]?.input.check_run_id, 7);
  assert.equal(mutations[1]?.input.conclusion, "success");
  checkRuns = [{ id: 8, external_id: id, app: { id: 999 } }];
  await provider.upsertReviewCheck(req, 2, "failure", "Failed");
  assert.equal(mutations[2]?.action, "create", "never update another App's check");
  current = { ...current, base: { ...current.base, sha: "changed" } };
  await assert.rejects(() => provider.upsertReviewCheck(req, 3, "pending", "New"), /superseded/);
  assert.equal(mutations.length, 3);
});

test("approval reconciliation changes only the App bot's own approval", async () => {
  const mutations: string[] = [];
  const reviews = [
    { id: 1, state: "APPROVED", user: { login: "human" }, commit_id: "a".repeat(40) },
    { id: 2, state: "APPROVED", user: { login: "pepeye[bot]" }, commit_id: "a".repeat(40) },
  ];
  const octokit = { rest: { pulls: {
    get: async () => ({ data: livePr(req) }),
    listReviews: async () => ({ data: reviews }),
    dismissReview: async (input: { review_id: number }) => { mutations.push(`dismiss:${input.review_id}`); },
    createReview: async () => { mutations.push("approve"); },
  } } };
  const req = effectRequest(octokit);
  const provider = createGithubProvider(FULL_ENV, { appBotLogin: "pepeye[bot]" });
  await provider.reconcileOwnedApproval(req, "present");
  assert.deepEqual(mutations, []);
  await provider.reconcileOwnedApproval(req, "absent");
  assert.deepEqual(mutations, ["dismiss:2"]);
  reviews.splice(1);
  await provider.reconcileOwnedApproval(req, "present");
  assert.deepEqual(mutations, ["dismiss:2", "approve"]);
});

test("walkthrough updates only its marked App-owned issue comment", async () => {
  const mutations: Array<{ action: string; input: Record<string, unknown> }> = [];
  const comments = [
    { id: 1, body: "<!-- acr:walkthrough:v1 -->\nOld", user: { login: "human" } },
    { id: 2, body: "<!-- acr:walkthrough:v1 -->\nOld", user: { login: "pepeye[bot]" } },
  ];
  const octokit = { rest: {
    pulls: { get: async () => ({ data: livePr(req) }) },
    issues: {
      listComments: async () => ({ data: comments }),
      updateComment: async (input: Record<string, unknown>) => { mutations.push({ action: "update", input }); },
      createComment: async (input: Record<string, unknown>) => { mutations.push({ action: "create", input }); },
    },
  } };
  const req = effectRequest(octokit);
  const provider = createGithubProvider(FULL_ENV, { appBotLogin: "pepeye[bot]" });
  await provider.upsertWalkthrough(req, "New walkthrough");
  assert.deepEqual(mutations.map((mutation) => mutation.action), ["update"]);
  assert.equal(mutations[0]?.input.comment_id, 2);
  assert.equal(mutations[0]?.input.body, "<!-- acr:walkthrough:v1 -->\nNew walkthrough");
  comments.splice(1);
  await provider.upsertWalkthrough(req, "New walkthrough");
  assert.deepEqual(mutations.map((mutation) => mutation.action), ["update", "create"]);
});

test("finding resolution replies only to an App-owned root comment on this PR", async () => {
  const replies: Array<Record<string, unknown>> = [];
  const graphqlCalls: string[] = [];
  let resolved = false;
  let parent = {
    user: { login: "pepeye[bot]" }, pull_request_review_id: 12,
    pull_request_url: "https://api.github.com/repos/quantipixels/skills/pulls/9",
  };
  const octokit = { graphql: async (query: string) => {
    graphqlCalls.push(query);
    if (query.includes("mutation")) {
      resolved = true;
      return { resolveReviewThread: { thread: { id: "thread-41", isResolved: true } } };
    }
    return { repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: "thread-41", isResolved: resolved, comments: { nodes: [{ databaseId: 41 }] } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } };
  }, rest: { pulls: {
    get: async () => ({ data: livePr(req) }),
    getReviewComment: async () => ({ data: parent }),
    createReplyForReviewComment: async (input: Record<string, unknown>) => { replies.push(input); },
  } } };
  const req = effectRequest(octokit);
  const provider = createGithubProvider(FULL_ENV, { appBotLogin: "pepeye[bot]" });
  await provider.resolveFinding(req, "41", "Reassessed");
  assert.equal(replies[0]?.comment_id, 41);
  assert.equal(graphqlCalls.filter((query) => query.includes("mutation")).length, 1);
  parent = { ...parent, user: { login: "human" } };
  await assert.rejects(() => provider.resolveFinding(req, "41", "Never"), /not owned/);
  assert.equal(replies.length, 1);
  await assert.rejects(() => provider.resolveFinding(req, "bad", "Never"), /invalid/);
});
