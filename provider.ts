import type { ReviewResult } from "./review.ts";
import { createClaudeProvider } from "./providers/claude.ts";
import { createCodexProvider } from "./providers/codex.ts";

export type ReviewRunOpts = {
  maxTurns?: number;
  addDir?: string;
  deep?: boolean;
  /** Caller cancellation on input; the shared runner replaces it with a per-attempt signal. */
  signal?: AbortSignal;
};

export interface ReviewProvider {
  readonly name: string;
  validateConfig(env: NodeJS.ProcessEnv): void;
  run(prompt: string, opts?: ReviewRunOpts): Promise<ReviewResult>;
}

const DEFAULT_REVIEW_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class ReviewTimeoutError extends Error {
  readonly code = "REVIEW_TIMEOUT";

  constructor(readonly providerName: string, readonly budgetMs: number) {
    const seconds = budgetMs / 1000;
    super(`${providerName} review exceeded its ${seconds}-second execution budget`);
    this.name = "ReviewTimeoutError";
  }
}

export type AttemptSignal = {
  signal: AbortSignal;
  dispose(): void;
};

export type ReviewExecutionRuntime = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  createAttemptSignal?: (
    timeoutMs: number,
    providerName: string,
    totalBudgetMs: number,
    callerSignal?: AbortSignal,
  ) => AttemptSignal;
};

function timeoutEnvName(providerName: string): string {
  return `${providerName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TIMEOUT_SECONDS`;
}

function parseTimeoutSeconds(raw: string, name: string): number {
  const normalized = raw.trim();
  const seconds = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive safe integer (seconds).`);
  }
  if (!Number.isSafeInteger(seconds * 1000)) {
    throw new Error(`${name} must be a positive safe integer (seconds) whose millisecond value is also safe.`);
  }
  return seconds;
}

/** Resolve provider override, then global value, then the 30-minute default. */
export function effectiveReviewTimeoutMs(providerName: string, env: NodeJS.ProcessEnv): number {
  const providerKey = timeoutEnvName(providerName);
  const providerValue = env[providerKey]?.trim();
  const globalValue = env.REVIEW_TIMEOUT_SECONDS?.trim();
  if (providerValue) return parseTimeoutSeconds(providerValue, providerKey) * 1000;
  if (globalValue) return parseTimeoutSeconds(globalValue, "REVIEW_TIMEOUT_SECONDS") * 1000;
  return DEFAULT_REVIEW_TIMEOUT_SECONDS * 1000;
}

function defaultAttemptSignal(
  timeoutMs: number,
  providerName: string,
  totalBudgetMs: number,
  callerSignal?: AbortSignal,
): AttemptSignal {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timerRemaining = timeoutMs;

  const abortForTimeout = (): void => {
    controller.abort(new ReviewTimeoutError(providerName, totalBudgetMs));
  };
  const scheduleTimer = (): void => {
    const delay = Math.min(timerRemaining, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timerRemaining -= delay;
      if (timerRemaining > 0) scheduleTimer();
      else abortForTimeout();
    }, delay);
  };
  const abortForCaller = (): void => {
    controller.abort(callerSignal?.reason ?? new Error(`${providerName} review was cancelled`));
  };

  if (callerSignal?.aborted) abortForCaller();
  else {
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
    // Close the check/listen race: AbortSignal does not replay an abort that
    // happened immediately before the listener was attached.
    if (callerSignal?.aborted) abortForCaller();
    else scheduleTimer();
  }

  return {
    signal: controller.signal,
    dispose(): void {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(reason == null ? "review was cancelled" : String(reason));
}

function isNonRetryable(err: unknown): boolean {
  return err instanceof ReviewTimeoutError || (err instanceof Error && err.name === "AbortError");
}

/** Validate both adapter configuration and the selected provider's deadline policy. */
export function validateReviewProvider(provider: ReviewProvider, env: NodeJS.ProcessEnv): void {
  provider.validateConfig(env);
  effectiveReviewTimeoutMs(provider.name, env);
}

export async function runReview(
  provider: ReviewProvider,
  prompt: string,
  opts: ReviewRunOpts = {},
  runtime: ReviewExecutionRuntime = {},
): Promise<ReviewResult> {
  const env = runtime.env ?? process.env;
  const now = runtime.now ?? (() => performance.now());
  const createAttemptSignal = runtime.createAttemptSignal ?? defaultAttemptSignal;
  const totalBudgetMs = effectiveReviewTimeoutMs(provider.name, env);
  const startedAt = now();
  const callerSignal = opts.signal;

  if (callerSignal?.aborted) throw abortReason(callerSignal);

  console.log(`[${provider.name}] review execution budget ${totalBudgetMs / 1000}s`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const elapsedMs = Math.max(0, now() - startedAt);
    const remainingMs = totalBudgetMs - elapsedMs;
    if (remainingMs <= 0) throw new ReviewTimeoutError(provider.name, totalBudgetMs);

    const attemptSignal = createAttemptSignal(
      remainingMs,
      provider.name,
      totalBudgetMs,
      callerSignal,
    );
    try {
      console.log(`[${provider.name}] review attempt ${attempt}/2; ${Math.ceil(remainingMs / 1000)}s remaining`);
      const result = await provider.run(prompt, { ...opts, signal: attemptSignal.signal });
      if (attemptSignal.signal.aborted) throw abortReason(attemptSignal.signal);
      return result;
    } catch (err) {
      if (attemptSignal.signal.aborted) throw abortReason(attemptSignal.signal);
      if (isNonRetryable(err) || attempt === 2) throw err;

      // Model replies are non-deterministic, so a malformed reply or transient CLI
      // failure usually succeeds on a fresh attempt. The retry shares the original
      // deadline instead of receiving a new budget.
      console.warn(
        `[${provider.name}] review attempt failed; retrying once within the shared budget:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      attemptSignal.dispose();
    }
  }

  throw new Error("unreachable review attempt state");
}

export function selectProvider(name: string | undefined, env: NodeJS.ProcessEnv = process.env): ReviewProvider {
  const key = (name?.trim() || "claude").toLowerCase();
  switch (key) {
    case "claude":
      return createClaudeProvider(env);
    case "codex":
      return createCodexProvider(env);
    default:
      throw new Error(`Unknown AI_PROVIDER ${JSON.stringify(name)} — supported: "claude", "codex".`);
  }
}
