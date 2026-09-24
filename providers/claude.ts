/**
 * Claude provider — drives the Claude Code CLI (`claude -p`) on a subscription
 * token. The default (and currently only) ReviewProvider implementation. Pure
 * construction: createClaudeProvider takes the env so it's testable without the
 * real environment.
 */

import type { ReviewProvider, ReviewRunOpts } from "../provider.ts";
import { BASE_ENV_ALLOWLIST } from "../runtime/spawn.ts";
import { createCliBackedProvider, type CliProviderConfig } from "./cli.ts";
import schema from "./review.schema.json" with { type: "json" };

/** Default model when CLAUDE_MODEL is unset. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Read-only tools granted during a deep review. No Bash/Write/Edit, so untrusted
 * PR code that's been checked out can be read for context but never executed.
 */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Env the `claude` subprocess may inherit. It's driven by untrusted PR content and
 * its output is posted publicly, so it gets base infra vars plus ONLY the
 * subscription token — never the GitHub App key, webhook secret, or ANTHROPIC_API_KEY.
 */
export const CLAUDE_ENV_ALLOWLIST = [...BASE_ENV_ALLOWLIST, "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export function createClaudeCliConfig(env: NodeJS.ProcessEnv): CliProviderConfig {
  const model = env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
  const gatewayMode = Boolean(env.MODEL_GATEWAY_SOCKET_PATH?.trim());

  return {
    name: "claude",
    command: "claude",
    envAllowlist: gatewayMode ? BASE_ENV_ALLOWLIST : CLAUDE_ENV_ALLOWLIST,
    sourceEnv: env,
    extraEnv(opts): NodeJS.ProcessEnv {
      if (!gatewayMode) return {};
      if (!opts.gateway) throw new Error("Claude gateway review requires an attempt grant");
      return {
        ANTHROPIC_BASE_URL: opts.gateway.baseUrl,
        ANTHROPIC_AUTH_TOKEN: opts.gateway.token,
      };
    },

    validateConfig(e: NodeJS.ProcessEnv): void {
      if (e.MODEL_GATEWAY_SOCKET_PATH?.trim() && (e.CLAUDE_CODE_OAUTH_TOKEN?.trim() || e.ANTHROPIC_API_KEY?.trim())) {
        throw new Error("Gateway review service must not receive reusable Claude credentials");
      }
      if (e.MODEL_GATEWAY_SOCKET_PATH?.trim()) return;
      // Auth must flow through CLAUDE_CODE_OAUTH_TOKEN (the subscription). A stray
      // ANTHROPIC_API_KEY would take precedence and silently move usage onto metered
      // API billing, so refuse to start rather than bill the wrong way.
      if (e.ANTHROPIC_API_KEY) {
        throw new Error(
          "ANTHROPIC_API_KEY must not be set: it overrides CLAUDE_CODE_OAUTH_TOKEN and moves " +
            "usage onto metered API billing. Unset it and use the subscription token instead.",
        );
      }
    },

    buildArgs(opts: ReviewRunOpts): string[] {
      const args = [
        "-p",
        "--safe-mode",
        "--no-session-persistence",
        "--output-format", "json",
        // Enforce the review contract at the CLI layer: the model delivers its reply
        // through a schema-validated tool call instead of free text, so unescaped
        // quotes, truncation, or stray prose can't produce unparseable JSON.
        "--json-schema", JSON.stringify(schema),
        "--max-turns", String(opts.maxTurns ?? 1),
        "--model", model,
      ];
      if (opts.addDir) args.push("--add-dir", opts.addDir);
      args.push("--tools", opts.deep ? READ_ONLY_TOOLS.join(",") : "");
      return args;
    },

    parseReply(stdout: string): unknown {
      // Claude Code wraps the reply in an envelope. With --json-schema the validated
      // review object arrives in `structured_output`; when the run errs out before
      // producing one, fall back to the text reply so the review-contract parser can
      // surface what actually came back.
      const envelope = JSON.parse(stdout);
      if (envelope?.structured_output != null) return envelope.structured_output;
      return String(envelope.result ?? "").trim();
    },
  };
}

/** Build a Claude provider bound to the configured model. */
export function createClaudeProvider(env: NodeJS.ProcessEnv): ReviewProvider {
  return createCliBackedProvider(createClaudeCliConfig(env));
}
