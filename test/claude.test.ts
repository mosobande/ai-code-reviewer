import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, selectProvider, type ReviewProvider } from "../provider.ts";
import { createClaudeCliConfig, createClaudeProvider, CLAUDE_ENV_ALLOWLIST } from "../providers/claude.ts";
import { buildSubprocessEnv } from "../runtime/spawn.ts";
import { createCliBackedProvider } from "../providers/cli.ts";
import schema from "../providers/review.schema.json" with { type: "json" };

test("claude CLI adapter defaults to a single diff-only pass on the default model", () => {
  const args = createClaudeCliConfig({}).buildArgs({});
  assert.deepEqual(args, [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--max-turns", "1", "--model", "claude-sonnet-4-6",
  ]);
  assert.ok(!args.includes("--add-dir"), "no working dir by default");
  assert.ok(!args.includes("--allowedTools"), "no tool restriction by default");
});

test("claude CLI adapter enforces the shared review schema as structured output", () => {
  const args = createClaudeCliConfig({}).buildArgs({});
  const schemaArg = args[args.indexOf("--json-schema") + 1];
  assert.deepEqual(JSON.parse(schemaArg!), schema, "schema passes through the CLI intact");
});

test("claude CLI adapter honours CLAUDE_MODEL", () => {
  const args = createClaudeCliConfig({ CLAUDE_MODEL: "claude-opus-4-8" }).buildArgs({});
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
});

test("claude CLI adapter wires a deep review (dir + read-only tools, turn budget)", () => {
  const args = createClaudeCliConfig({}).buildArgs({ maxTurns: 8, addDir: "/tmp/clone", deep: true });
  assert.equal(args[args.indexOf("--max-turns") + 1], "8");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/clone");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
  // Read-only: nothing that could execute or mutate the checked-out PR code.
  assert.ok(!args.join(" ").match(/Bash|Write|Edit/), "deep review tools stay read-only");
});

test("claude parseReply prefers the schema-validated structured_output", () => {
  const review = { summary: "ok", comments: [] };
  const stdout = JSON.stringify({ result: JSON.stringify(review), structured_output: review });
  assert.deepEqual(createClaudeCliConfig({}).parseReply(stdout), review);
});

test("claude parseReply falls back to the text reply when structured_output is absent", () => {
  const stdout = JSON.stringify({ result: '```json\n{"summary":"ok"}\n```', other: "ignored" });
  assert.equal(createClaudeCliConfig({}).parseReply(stdout), '```json\n{"summary":"ok"}\n```');
});

test("claude validateConfig rejects ANTHROPIC_API_KEY (would bypass the subscription)", () => {
  const provider = createClaudeProvider({});
  assert.throws(() => provider.validateConfig({ ANTHROPIC_API_KEY: "sk-ant-x" }), /ANTHROPIC_API_KEY must not be set/);
  assert.doesNotThrow(() => provider.validateConfig({ CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_x" }));
});

test("the claude subprocess env carries the OAuth token but never the service secrets", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/app",
    CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_real",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "whsec_real",
    GITHUB_APP_ID: "123456",
    ANTHROPIC_API_KEY: "sk-ant-should-never-leak",
  };
  const env = buildSubprocessEnv(source, CLAUDE_ENV_ALLOWLIST);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "claude_oauth_real", "subscription token forwarded");
  for (const secret of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]) {
    assert.ok(!(secret in env), `${secret} must not reach the reviewer subprocess`);
  }
});

test("selectProvider returns the Claude provider for 'claude' and by default", () => {
  assert.equal(selectProvider("claude").name, "claude");
  assert.equal(selectProvider(undefined).name, "claude");
  assert.equal(selectProvider("  CLAUDE  ").name, "claude", "trimmed + case-insensitive");
  assert.equal(selectProvider("").name, "claude", "empty string → default, not a crash");
});

test("selectProvider fails loudly on an unknown provider name", () => {
  assert.throws(() => selectProvider("llama"), /supported: "claude", "codex"/);
});

test("runReview accepts a high-level provider without CLI fields", async () => {
  const provider: ReviewProvider = {
    name: "fake",
    validateConfig() {},
    async run(prompt) {
      assert.equal(prompt, "review this");
      return { summary: "ok", comments: [] };
    },
  };

  assert.deepEqual(await runReview(provider, "review this"), { summary: "ok", comments: [] });
  assert.ok(!("command" in provider));
  assert.ok(!("buildArgs" in provider));
});

test("CLI-backed providers parse stdout through the shared review contract", async () => {
  let seenMaxTurns: number | undefined;
  const provider = createCliBackedProvider({
    name: "mock",
    command: process.execPath,
    sourceEnv: { PATH: process.env.PATH ?? "", TEST_REVIEW_ENV: "from-source" },
    envAllowlist: ["PATH", "TEST_REVIEW_ENV"],
    buildArgs: (opts) => {
      seenMaxTurns = opts.maxTurns;
      return ["-e", `
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => input += chunk);
        process.stdin.on("end", () => {
          console.log(JSON.stringify({
            result: JSON.stringify({ summary: process.env.TEST_REVIEW_ENV + ":" + input, comments: [] }),
          }));
        });
      `];
    },
    parseReply: (stdout) => JSON.parse(stdout).result,
  });

  assert.deepEqual(await provider.run("review prompt", { maxTurns: 3 }), { summary: "from-source:review prompt", comments: [] });
  assert.equal(seenMaxTurns, 3);
});

test("CLI-backed providers validate an already-structured reply object as-is", async () => {
  const provider = createCliBackedProvider({
    name: "mock-structured",
    command: process.execPath,
    sourceEnv: { PATH: process.env.PATH ?? "" },
    envAllowlist: ["PATH"],
    buildArgs: () => ["-e", `
      console.log(JSON.stringify({ structured_output: { summary: "structured", comments: [] } }));
    `],
    parseReply: (stdout) => JSON.parse(stdout).structured_output,
  });

  assert.deepEqual(await provider.run("review prompt"), { summary: "structured", comments: [] });
});

test("CLI-backed providers reject a structured reply that breaks the contract", async () => {
  const provider = createCliBackedProvider({
    name: "mock-bad-structured",
    command: process.execPath,
    sourceEnv: { PATH: process.env.PATH ?? "" },
    envAllowlist: ["PATH"],
    buildArgs: () => ["-e", `console.log(JSON.stringify({ structured_output: { summary: 42 } }));`],
    parseReply: (stdout) => JSON.parse(stdout).structured_output,
  });

  await assert.rejects(() => provider.run("review prompt"), /string summary and comments array/);
});

// Regression: a single malformed model reply used to fail the whole review and
// require a manual re-request.
test("runReview retries once after a failed attempt", async () => {
  let attempts = 0;
  const provider: ReviewProvider = {
    name: "flaky",
    validateConfig() {},
    async run() {
      attempts += 1;
      if (attempts === 1) throw new Error("Expected ',' or ']' after array element in JSON at position 2155");
      return { summary: "recovered", comments: [] };
    },
  };

  assert.deepEqual(await runReview(provider, "p"), { summary: "recovered", comments: [] });
  assert.equal(attempts, 2);
});

test("runReview surfaces the error when the retry also fails", async () => {
  let attempts = 0;
  const provider: ReviewProvider = {
    name: "broken",
    validateConfig() {},
    async run(): Promise<never> {
      attempts += 1;
      throw new Error("boom");
    },
  };

  await assert.rejects(() => runReview(provider, "p"), /boom/);
  assert.equal(attempts, 2, "exactly one retry, not an infinite loop");
});
