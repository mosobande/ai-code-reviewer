import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { CodexOptions, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { buildSubprocessEnv } from "../runtime/spawn.ts";
import { selectProvider } from "../provider.ts";
import { createCodexProvider, CODEX_ENV_ALLOWLIST, __test } from "../providers/codex.ts";
import schema from "../providers/review.schema.json" with { type: "json" };

test("codex env carries Codex auth/config vars but never service or Claude secrets", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/app",
    CODEX_HOME: "/home/app/.codex",
    CODEX_SQLITE_HOME: "/home/app/.codex-sqlite",
    CODEX_ACCESS_TOKEN: "codex_access_real",
    CODEX_API_KEY: "sk-codex-real",
    CODEX_CA_CERTIFICATE: "/certs/ca.pem",
    RUST_LOG: "warn",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "whsec_real",
    GITLAB_TOKEN: "glpat-real",
    CLAUDE_CODE_OAUTH_TOKEN: "claude_oauth_real",
    ANTHROPIC_API_KEY: "sk-ant-should-never-leak",
  };
  const env = buildSubprocessEnv(source, CODEX_ENV_ALLOWLIST);
  for (const key of ["CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_CA_CERTIFICATE", "RUST_LOG"]) {
    assert.equal(env[key], source[key as keyof typeof source], `${key} forwarded`);
  }
  for (const secret of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITLAB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    assert.ok(!(secret in env), `${secret} must not reach Codex`);
  }
});

test("codex SDK options give CODEX_API_KEY precedence over CODEX_ACCESS_TOKEN", () => {
  const options = __test.codexClientOptions({
    CODEX_API_KEY: "sk-codex-real",
    CODEX_ACCESS_TOKEN: "codex-access-real",
  });

  assert.equal(options.apiKey, "sk-codex-real");
  assert.equal(options.env?.CODEX_API_KEY, "sk-codex-real");
  assert.ok(!("CODEX_ACCESS_TOKEN" in (options.env ?? {})), "access token is withheld when API-key mode is active");
});

test("codex SDK options preserve CODEX_HOME when set", () => {
  const options = __test.codexClientOptions({
    PATH: "/usr/bin",
    CODEX_HOME: "/home/app/.codex",
    CODEX_ACCESS_TOKEN: "codex-access-real",
  });

  assert.equal(options.config, undefined);
  assert.equal(options.env?.PATH, "/usr/bin");
  assert.equal(options.env?.CODEX_HOME, "/home/app/.codex");
  assert.equal(options.env?.CODEX_ACCESS_TOKEN, "codex-access-real");
});

test("codex SDK options support API base URL without exposing runtime path overrides", () => {
  const options = __test.codexClientOptions({
    CODEX_BASE_URL: "https://llm-gateway.example/v1",
    CODEX_PATH_OVERRIDE: "/opt/codex/bin/codex",
  });

  assert.equal(options.baseUrl, "https://llm-gateway.example/v1");
  assert.equal(options.codexPathOverride, undefined);
});

test("codex thread options use read-only sandbox, approval never, model, and deep-review directory", () => {
  const options = __test.threadOptions(
    { CODEX_MODEL: "gpt-5.5", CODEX_REASONING_EFFORT: "high", CODEX_WEB_SEARCH_MODE: "disabled" },
    { addDir: "/tmp/clone", deep: true, maxTurns: 8 },
  );

  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.model, "gpt-5.5");
  assert.equal(options.modelReasoningEffort, "high");
  assert.equal(options.webSearchMode, "disabled");
  assert.equal(options.workingDirectory, "/tmp/clone");
  assert.equal(options.additionalDirectories, undefined);
  assert.equal(options.skipGitRepoCheck, undefined);
});

test("codex diff-only thread options skip the git repo check", () => {
  const options = __test.threadOptions({}, {}, "/tmp/codex-diff-review");

  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.skipGitRepoCheck, true);
  assert.equal(options.workingDirectory, "/tmp/codex-diff-review");
  assert.equal(options.additionalDirectories, undefined);
});

test("codex validateConfig allows API key, access token, CODEX_HOME, and default CLI auth fallback, but rejects profile", () => {
  const provider = createCodexProvider({});
  assert.doesNotThrow(() => provider.validateConfig({ CODEX_API_KEY: "sk-codex" }));
  assert.doesNotThrow(() => provider.validateConfig({ CODEX_ACCESS_TOKEN: "codex-access" }));
  assert.doesNotThrow(() => provider.validateConfig({ CODEX_HOME: "/home/app/.codex" }));
  assert.doesNotThrow(() => provider.validateConfig({}));
  assert.throws(() => provider.validateConfig({ CODEX_PROFILE: "reviewer" }), /CODEX_PROFILE is not supported/);
  assert.throws(() => provider.validateConfig({ CODEX_REASONING_EFFORT: "extreme" }), /CODEX_REASONING_EFFORT/);
  assert.throws(() => provider.validateConfig({ CODEX_WEB_SEARCH_MODE: "enabled" }), /CODEX_WEB_SEARCH_MODE/);
});

test("codex provider runs through SDK with output schema and parses finalResponse", async () => {
  let capturedClientOptions: CodexOptions | undefined;
  let capturedThreadOptions: ThreadOptions | undefined;
  let capturedPrompt = "";
  let capturedTurnOptions: TurnOptions | undefined;

  const provider = createCodexProvider(
    { CODEX_API_KEY: "sk-codex-real", CODEX_MODEL: "gpt-5.5" },
    {
      createClient(options) {
        capturedClientOptions = options;
        return {
          startThread(options) {
            capturedThreadOptions = options;
            return {
              async run(prompt, options) {
                capturedPrompt = prompt;
                capturedTurnOptions = options;
                return { finalResponse: '```json\n{"summary":"ok","comments":[]}\n```' };
              },
            };
          },
        };
      },
    },
  );

  const signal = new AbortController().signal;
  const result = await provider.run("review prompt", { addDir: "/tmp/clone", deep: true, signal });

  assert.deepEqual(result, { summary: "ok", comments: [] });
  assert.equal(capturedPrompt, "review prompt");
  assert.equal(capturedClientOptions?.apiKey, "sk-codex-real");
  assert.equal(capturedClientOptions?.config, undefined);
  assert.equal(capturedThreadOptions?.sandboxMode, "read-only");
  assert.equal(capturedThreadOptions?.approvalPolicy, "never");
  assert.equal(capturedThreadOptions?.model, "gpt-5.5");
  assert.equal(capturedThreadOptions?.workingDirectory, "/tmp/clone");
  assert.equal(capturedThreadOptions?.additionalDirectories, undefined);
  assert.equal(capturedTurnOptions?.signal, signal);
  assert.deepEqual(capturedTurnOptions?.outputSchema, schema);
});

test("codex provider isolates diff-only reviews in a temporary directory and removes it", async () => {
  let capturedThreadOptions: ThreadOptions | undefined;
  let tempDir = "";

  const provider = createCodexProvider(
    { CODEX_API_KEY: "sk-codex-real" },
    {
      createClient() {
        return {
          startThread(options) {
            capturedThreadOptions = options;
            tempDir = options?.workingDirectory ?? "";
            assert.match(tempDir, /codex-diff-review-/, "diff-only workdir uses the Codex temp prefix");
            assert.equal(existsSync(tempDir), true, "temp directory exists during run");
            return {
              async run(_prompt, options) {
                assert.equal(options?.signal instanceof AbortSignal, true);
                assert.deepEqual(options?.outputSchema, schema);
                return { finalResponse: '{"summary":"ok","comments":[]}' };
              },
            };
          },
        };
      },
    },
  );

  const signal = new AbortController().signal;
  assert.deepEqual(await provider.run("review prompt", { signal }), { summary: "ok", comments: [] });
  assert.equal(capturedThreadOptions?.skipGitRepoCheck, true);
  assert.equal(capturedThreadOptions?.additionalDirectories, undefined);
  assert.equal(existsSync(tempDir), false, "temp directory is removed after run");
});

test("codex uses the shared caller signal instead of a private per-turn timeout", () => {
  assert.equal("reviewTimeoutMs" in __test, false);
});

test("selectProvider returns the Codex provider and Claude remains the default", () => {
  assert.equal(selectProvider("codex").name, "codex");
  assert.equal(selectProvider("  CODEX  ").name, "codex", "trimmed + case-insensitive");
  assert.equal(selectProvider(undefined).name, "claude");
});
