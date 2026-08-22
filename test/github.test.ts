import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubProvider, loadAppPrivateKey } from "../repositories/github.ts";

const FULL_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "whsec_test",
  REVIEWER_LOGIN: "ayewobot",
  GITHUB_ALLOWED_OWNERS: "quantipixels",
};

function reviewRequestedPayload(owner: string, repo: string): Buffer {
  return Buffer.from(JSON.stringify({
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
  }));
}

function githubProviderForWebhook(env: NodeJS.ProcessEnv) {
  return createGithubProvider(env, {
    createApp: () => ({
      webhooks: { verify: async () => true },
    } as never),
  });
}

test("the factory constructs without throwing on an empty env (App is built lazily in init)", () => {
  assert.doesNotThrow(() => createGithubProvider({}));
});

test("validateConfig requires the App credentials", () => {
  const provider = createGithubProvider(FULL_ENV);
  for (const missing of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] as const) {
    const env = { ...FULL_ENV, [missing]: undefined };
    assert.throws(() => createGithubProvider(env).validateConfig(env), new RegExp(`${missing} must be set`));
  }
  assert.doesNotThrow(() => provider.validateConfig(FULL_ENV));
});

test("validateConfig requires at least one REVIEWER_LOGIN", () => {
  const env = { ...FULL_ENV, REVIEWER_LOGIN: "  ,  " };
  assert.throws(() => createGithubProvider(env).validateConfig(env), /REVIEWER_LOGIN must list at least one login/);
});

test("validateConfig requires at least one allowed GitHub owner or repository", () => {
  const env = {
    ...FULL_ENV,
    GITHUB_ALLOWED_OWNERS: "  ,  ",
    GITHUB_ALLOWED_REPOSITORIES: "",
  };
  assert.throws(
    () => createGithubProvider(env).validateConfig(env),
    /GITHUB_ALLOWED_OWNERS or GITHUB_ALLOWED_REPOSITORIES must list at least one scope/,
  );
});

test("validateConfig rejects malformed GitHub repository scopes", () => {
  for (const value of ["repo-only", "/repo", "owner/", "owner/repo/extra", "owner /repo"]) {
    const env = { ...FULL_ENV, GITHUB_ALLOWED_OWNERS: "", GITHUB_ALLOWED_REPOSITORIES: value };
    assert.throws(
      () => createGithubProvider(env).validateConfig(env),
      /GITHUB_ALLOWED_REPOSITORIES must contain owner\/repo entries/,
    );
  }
});

test("validateConfig rejects malformed GitHub owner scopes", () => {
  for (const value of ["owner/repo", "two words", "/owner"]) {
    const env = { ...FULL_ENV, GITHUB_ALLOWED_OWNERS: value };
    assert.throws(
      () => createGithubProvider(env).validateConfig(env),
      /GITHUB_ALLOWED_OWNERS must contain owner names/,
    );
  }
});

test("parseWebhook rejects a delivery missing the signature header (→ 400)", async () => {
  const provider = createGithubProvider(FULL_ENV);
  await assert.rejects(
    () => provider.parseWebhook({ "x-github-event": "pull_request" }, Buffer.from("{}")),
    /missing X-Hub-Signature-256/,
  );
});

test("parseWebhook accepts an allowed owner case-insensitively", async () => {
  const provider = githubProviderForWebhook({ ...FULL_ENV, GITHUB_ALLOWED_OWNERS: "QuantiPixels" });
  await provider.init();
  const request = await provider.parseWebhook(
    { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" },
    reviewRequestedPayload("quantipixels", "skills"),
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
    reviewRequestedPayload("quantipixels", "skills"),
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
      { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=test" },
      reviewRequestedPayload("outside-org", "private-repo"),
    );
    assert.equal(request, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(logs, ["[github] ignored review request outside allowlist: outside-org/private-repo"]);
  assert.ok(!logs[0]?.includes(FULL_ENV.GITHUB_WEBHOOK_SECRET));
});

test("loadAppPrivateKey passes through a real PEM and un-escapes \\n one-liners", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  assert.equal(loadAppPrivateKey(pem), pem, "real-newline PEM is left intact");
  const escaped = "-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJ\\n-----END RSA PRIVATE KEY-----";
  assert.equal(loadAppPrivateKey(escaped), pem, "\\n escapes become real newlines");
});

test("loadAppPrivateKey base64-decodes a key with no BEGIN marker", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJ\n-----END RSA PRIVATE KEY-----";
  const b64 = Buffer.from(pem).toString("base64");
  assert.equal(loadAppPrivateKey(b64), pem, "base64(PEM) is decoded back to the PEM");
});
