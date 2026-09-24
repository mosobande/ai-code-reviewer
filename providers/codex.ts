import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadOptions,
  type TurnOptions,
  type WebSearchMode,
} from "@openai/codex-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReviewJson, type ReviewResult } from "../review.ts";
import type { ReviewProvider, ReviewRunOpts, ReviewGatewayGrant } from "../provider.ts";
import { BASE_ENV_ALLOWLIST, buildSubprocessEnv } from "../runtime/spawn.ts";
import schema from "./review.schema.json" with { type: "json" };

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const WEB_SEARCH_MODES = new Set(["disabled", "cached", "live"]);

export const CODEX_ENV_ALLOWLIST = [
  ...BASE_ENV_ALLOWLIST,
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "CODEX_CA_CERTIFICATE",
  "RUST_LOG",
] as const;

type CodexThread = {
  run(input: string, options?: TurnOptions): Promise<{ finalResponse: string }>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
};

type CodexClientFactory = (options: CodexOptions) => CodexClient;

export type CodexProviderDeps = {
  createClient?: CodexClientFactory;
};

function codexEnvAllowlist(env: NodeJS.ProcessEnv): readonly string[] {
  return env.CODEX_API_KEY?.trim()
    ? CODEX_ENV_ALLOWLIST.filter((key) => key !== "CODEX_ACCESS_TOKEN")
    : CODEX_ENV_ALLOWLIST;
}

function codexClientOptions(
  env: NodeJS.ProcessEnv,
  gateway?: ReviewGatewayGrant,
  isolatedHome?: string,
): CodexOptions {
  if (gateway) {
    if (!isolatedHome) throw new Error("Codex gateway review requires an isolated home");
    return {
      env: buildSubprocessEnv(env, BASE_ENV_ALLOWLIST, {
        CODEX_HOME: isolatedHome,
        CODEX_SQLITE_HOME: isolatedHome,
      }),
      apiKey: gateway.token,
      baseUrl: gateway.baseUrl,
    };
  }
  const subprocessEnv = buildSubprocessEnv(env, codexEnvAllowlist(env));
  const apiKey = env.CODEX_API_KEY?.trim();
  const baseUrl = env.CODEX_BASE_URL?.trim();

  return {
    env: subprocessEnv,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function optionalReasoningEffort(value?: string): ModelReasoningEffort | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error("CODEX_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh.");
  }
  return normalized as ModelReasoningEffort;
}

function optionalWebSearchMode(value?: string): WebSearchMode | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!WEB_SEARCH_MODES.has(normalized)) {
    throw new Error("CODEX_WEB_SEARCH_MODE must be one of: disabled, cached, live.");
  }
  return normalized as WebSearchMode;
}

function threadOptions(env: NodeJS.ProcessEnv, opts: ReviewRunOpts, diffOnlyDir?: string): ThreadOptions {
  const model = env.CODEX_MODEL?.trim();
  const modelReasoningEffort = optionalReasoningEffort(env.CODEX_REASONING_EFFORT);
  const webSearchMode = optionalWebSearchMode(env.CODEX_WEB_SEARCH_MODE);
  return {
    sandboxMode: "read-only",
    approvalPolicy: "never",
    ...(model ? { model } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(webSearchMode ? { webSearchMode } : {}),
    ...(opts.addDir
      ? { workingDirectory: opts.addDir }
      : { workingDirectory: diffOnlyDir, skipGitRepoCheck: true }),
  };
}

export function createCodexProvider(env: NodeJS.ProcessEnv, deps: CodexProviderDeps = {}): ReviewProvider {
  const createClient = deps.createClient ?? ((options: CodexOptions) => new Codex(options));

  return {
    name: "codex",

    validateConfig(e: NodeJS.ProcessEnv): void {
      if (e.MODEL_GATEWAY_SOCKET_PATH?.trim()) {
        if (["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_BASE_URL"]
          .some((name) => e[name]?.trim())) {
          throw new Error("Gateway review service must not receive reusable Codex credentials or a direct base URL");
        }
        optionalReasoningEffort(e.CODEX_REASONING_EFFORT);
        optionalWebSearchMode(e.CODEX_WEB_SEARCH_MODE);
        return;
      }
      const hasExplicitAuth = Boolean(e.CODEX_API_KEY?.trim() || e.CODEX_ACCESS_TOKEN?.trim());
      const hasConfiguredHome = Boolean(e.CODEX_HOME?.trim());
      if (e.CODEX_PROFILE?.trim()) {
        throw new Error(
          "CODEX_PROFILE is not supported by @openai/codex-sdk: the bundled CLI requires " +
            "--profile, which the SDK does not expose. Configure model/auth directly instead.",
        );
      }
      optionalReasoningEffort(e.CODEX_REASONING_EFFORT);
      optionalWebSearchMode(e.CODEX_WEB_SEARCH_MODE);
      if (!hasExplicitAuth && !hasConfiguredHome) {
        console.warn(
          "AI_PROVIDER=codex without CODEX_API_KEY, CODEX_ACCESS_TOKEN, or CODEX_HOME; " +
            "falling back to Codex's default ~/.codex auth/config. Ensure the host has run `codex login`.",
        );
      }
    },

    async run(prompt: string, opts: ReviewRunOpts = {}): Promise<ReviewResult> {
      const gatewayMode = Boolean(env.MODEL_GATEWAY_SOCKET_PATH?.trim());
      if (gatewayMode && !opts.gateway) throw new Error("Codex gateway review requires an attempt grant");
      const diffOnlyDir = opts.addDir ? undefined : await mkdtemp(join(tmpdir(), "codex-diff-review-"));
      const isolatedHome = opts.gateway ? await mkdtemp(join(tmpdir(), "acr-codex-home-")) : undefined;
      try {
        const client = createClient(codexClientOptions(env, opts.gateway, isolatedHome));
        const thread = client.startThread(threadOptions(env, opts, diffOnlyDir));
        const turn = await thread.run(prompt, {
          outputSchema: schema,
          signal: opts.signal,
        });
        return parseReviewJson(turn.finalResponse);
      } finally {
        if (diffOnlyDir) await rm(diffOnlyDir, { recursive: true, force: true }).catch(() => {});
        if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export const __test = {
  codexClientOptions,
  codexEnvAllowlist,
  threadOptions,
};
