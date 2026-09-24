import type { ReviewProvider, ReviewRunOpts } from "../provider.ts";
import { coerceReviewResult, parseReviewJson, type ReviewResult } from "../review.ts";
import { buildSubprocessEnv, spawnText } from "../runtime/spawn.ts";

export type CliProviderConfig = {
  name: string;
  command: string;
  envAllowlist: readonly string[];
  sourceEnv?: NodeJS.ProcessEnv;
  extraEnv?(opts: ReviewRunOpts): NodeJS.ProcessEnv;
  validateConfig?(env: NodeJS.ProcessEnv): void;
  buildArgs(opts: ReviewRunOpts): string[];
  /**
   * Unwrap the CLI's stdout to the review reply: either the model's text (parsed
   * as review JSON) or an already-structured review object (validated as-is).
   */
  parseReply(stdout: string): unknown;
};

/** How much raw CLI output to keep in the log when a reply can't be parsed. */
const LOGGED_REPLY_LIMIT = 2000;

/**
 * Default adapter for providers backed by a CLI that accepts the review prompt on
 * stdin and prints a parseable response to stdout.
 */
export function createCliBackedProvider(config: CliProviderConfig): ReviewProvider {
  return {
    name: config.name,

    validateConfig(env: NodeJS.ProcessEnv): void {
      config.validateConfig?.(env);
    },

    async run(prompt: string, opts: ReviewRunOpts = {}): Promise<ReviewResult> {
      const env = buildSubprocessEnv(
        config.sourceEnv ?? process.env,
        config.envAllowlist,
        config.extraEnv?.(opts),
      );
      const stdout = await spawnText(config.command, config.buildArgs(opts), env, prompt, {
        signal: opts.signal,
      });
      try {
        const reply = config.parseReply(stdout);
        return typeof reply === "string" ? parseReviewJson(reply) : coerceReviewResult(reply);
      } catch (err) {
        // A JSON.parse position alone is undiagnosable after the fact — keep the
        // raw output (truncated) in the service log before failing the review.
        console.error(`[${config.name}] unparseable reviewer reply:\n${stdout.slice(0, LOGGED_REPLY_LIMIT)}`);
        throw err;
      }
    },
  };
}
