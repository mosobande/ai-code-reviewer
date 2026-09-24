import PQueue from "p-queue";
import type { ReviewRequest } from "./repository.ts";
import { refKey } from "./repository.ts";
import type { ReviewAdmission, ReviewStore } from "./store.ts";
import type { ReviewPolicySnapshot } from "./review-policy.ts";

export class WorkQueues {
  readonly reviewQueue = new PQueue({ concurrency: 1 });

  addReview<T>(task: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.reviewQueue.add(
      task,
      signal ? { signal } : undefined
    ) as Promise<T>;
  }

  async onIdle(): Promise<void> {
    await this.reviewQueue.onIdle();
  }
}

export type ReviewExecution = {
  request: ReviewRequest;
  generation: number;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
  beginPosting(): Promise<boolean>;
  policy?: ReviewPolicySnapshot;
};

export type ReviewExecutionResult = {
  summary: string;
  commentCount: number;
  coverage?: { mode: "full" | "incremental" | "targeted"; baseSha?: string | null; complete: boolean };
};

type ReviewCoordinatorDeps = {
  store: ReviewStore;
  getCurrentHead(request: ReviewRequest, signal?: AbortSignal): Promise<string>;
  getCurrentTarget?(request: ReviewRequest, signal?: AbortSignal): Promise<{ ref: string; head_sha: string }>;
  resolvePolicy?(request: ReviewRequest, target: { ref: string; head_sha: string }): Promise<ReviewPolicySnapshot>;
  execute(job: ReviewExecution): Promise<ReviewExecutionResult>;
  onFailure?(request: ReviewRequest, generation: number, error: unknown): Promise<void>;
  queues?: WorkQueues;
  now?: () => string;
  log?: Pick<Console, "log" | "warn" | "error">;
};

export type ReviewSubmission =
  | ReviewAdmission
  | {
      kind: "stale_head";
      requested_head_sha: string;
      current_head_sha: string;
    };

/** Owns admission, supersession, cancellation, and durable completion fencing. */
export class ReviewCoordinator {
  readonly queues: WorkQueues;
  #store: ReviewStore;
  #deps: ReviewCoordinatorDeps;
  #controllers = new Map<number, AbortController>();
  #admissionTails = new Map<string, Promise<void>>();
  #now: () => string;
  #log: Pick<Console, "log" | "warn" | "error">;

  constructor(deps: ReviewCoordinatorDeps) {
    this.#deps = deps;
    this.#store = deps.store;
    this.queues = deps.queues ?? new WorkQueues();
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#log = deps.log ?? console;
  }

  submit(request: ReviewRequest): Promise<ReviewSubmission> {
    const key = `${request.ref.owner}/${request.ref.repo}#${request.ref.pull_number}`;
    const previous = this.#admissionTails.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.#submitInOrder(request));
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#admissionTails.set(key, tail);
    void tail.finally(() => {
      if (this.#admissionTails.get(key) === tail) this.#admissionTails.delete(key);
    });
    return result;
  }

  async #submitInOrder(request: ReviewRequest): Promise<ReviewSubmission> {
    const currentHead = await this.#deps.getCurrentHead(request);
    if (currentHead !== request.ref.head_sha) {
      return {
        kind: "stale_head",
        requested_head_sha: request.ref.head_sha,
        current_head_sha: currentHead,
      };
    }

    const target = this.#deps.getCurrentTarget
      ? await this.#deps.getCurrentTarget(request)
      : request.target;
    if (target) request.target = target;
    const policy = target && this.#deps.resolvePolicy
      ? await this.#deps.resolvePolicy(request, target)
      : undefined;

    const admission = this.#store.admit(
      request.ref,
      request.reviewer,
      this.#now(),
      request.trigger,
      request.target,
      policy?.digest,
    );
    if (admission.kind !== "accepted") return admission;

    for (const generation of admission.superseded) {
      this.#controllers
        .get(generation)
        ?.abort(new Error(`superseded by ${request.ref.head_sha}`));
    }

    const controller = new AbortController();
    this.#controllers.set(admission.generation, controller);
    const queued = this.queues
      .addReview(
        () => this.#run(request, admission.generation, controller, policy),
        controller.signal
      )
      .catch((error) => {
        const row = this.#store.getGeneration(admission.generation);
        if (row?.phase !== "cancelled" && !row?.superseded_by_sha) {
          this.#log.error(
            `[${refKey(request.ref)}] review queue failed:`,
            error
          );
        }
      });
    void queued.finally(() => {
      if (this.#controllers.get(admission.generation) === controller) {
        this.#controllers.delete(admission.generation);
      }
    });
    return admission;
  }

  async #run(
    request: ReviewRequest,
    generation: number,
    controller: AbortController,
    policy?: ReviewPolicySnapshot,
  ): Promise<void> {
    if (!this.#store.start(generation)) return;

    const checkCurrent = async (): Promise<boolean> => {
      if (!this.#store.isCurrent(generation)) return false;
      const currentHead = await this.#deps.getCurrentHead(
        request,
        controller.signal
      );
      const currentTarget = this.#deps.getCurrentTarget
        ? await this.#deps.getCurrentTarget(request, controller.signal)
        : request.target;
      if (currentHead === request.ref.head_sha &&
          (!request.target || (currentTarget?.ref === request.target.ref && currentTarget.head_sha === request.target.head_sha))) {
        return true;
      }
      const replacement = currentHead !== request.ref.head_sha
        ? currentHead : `target:${currentTarget?.head_sha ?? "unknown"}`;
      this.#store.supersedeGeneration(generation, replacement, this.#now());
      controller.abort(new Error(`superseded by ${replacement}`));
      return false;
    };
    const beginPosting = async (): Promise<boolean> => {
      if (!(await checkCurrent())) return false;
      return this.#store.startPosting(generation, this.#now());
    };

    try {
      if (!(await checkCurrent())) return;
      const result = await this.#deps.execute({
        request,
        generation,
        signal: controller.signal,
        isCurrent: checkCurrent,
        beginPosting,
        policy,
      });
      if (
        !this.#store.markGenerationPosted(
          generation,
          result.summary,
          result.commentCount,
          this.#now(),
          result.coverage,
        )
      ) {
        throw new Error(
          "review execution completed without entering the posting phase"
        );
      }
      this.#log.log(`[${refKey(request.ref)}] review posted`);
    } catch (error) {
      const row = this.#store.getGeneration(generation);
      if (row?.phase === "cancelled" || row?.superseded_by_sha) return;
      try {
        await this.#deps.onFailure?.(request, generation, error);
      } catch (checkError) {
        this.#log.error(`[${refKey(request.ref)}] could not publish failure check:`, checkError);
      }
      if (row?.phase === "posting") {
        this.#log.error(
          `[${refKey(request.ref)}] review post outcome is ambiguous; automatic retry disabled:`,
          error
        );
        return;
      }

      this.#store.markGenerationFailed(
        generation,
        error instanceof Error ? error.message : String(error),
        this.#now()
      );
      this.#log.error(`[${refKey(request.ref)}] review failed:`, error);
    } finally {
      if (this.#controllers.get(generation) === controller) {
        this.#controllers.delete(generation);
      }
    }
  }

  onIdle(): Promise<void> {
    return this.queues.onIdle();
  }

  get activeReviewCount(): number {
    return this.#controllers.size;
  }
}
