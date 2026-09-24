/**
 * Durable review ownership and outcome store — SQLite via better-sqlite3.
 *
 * One row represents one review generation. A separate current pointer gives each
 * pull request a monotonic generation owner, including when its head returns to a SHA
 * seen before. Execution phase and supersession stay orthogonal so a host mutation
 * already in flight can keep a truthful outcome after a newer head takes ownership.
 */

import Database from "better-sqlite3";

export type ReviewPhase =
  | "queued"
  | "running"
  | "posting"
  | "posted"
  | "failed"
  | "cancelled";

export type ReviewRef = {
  owner: string;
  repo: string;
  pull_number: number;
  head_sha: string;
};

export type ChangeRef = Pick<ReviewRef, "owner" | "repo" | "pull_number">;

export type ReviewRecord = ReviewRef & {
  generation: number;
  reviewer: string;
  trigger_id: string | null;
  trigger_kind: string | null;
  target_ref: string | null;
  target_head_sha: string | null;
  policy_digest: string | null;
  review_mode: string | null;
  coverage_base_sha: string | null;
  coverage_complete: number;
  phase: ReviewPhase;
  superseded_by_sha: string | null;
  post_started_at: string | null;
  summary: string | null;
  comment_count: number | null;
  error: string | null;
  requested_at: string;
  completed_at: string | null;
};

export type ReviewAdmission =
  | { kind: "accepted"; generation: number; superseded: number[] }
  | { kind: "duplicate"; generation: number };

const REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reviews (
    generation        INTEGER PRIMARY KEY AUTOINCREMENT,
    owner             TEXT    NOT NULL,
    repo              TEXT    NOT NULL,
    pull_number       INTEGER NOT NULL,
    head_sha          TEXT    NOT NULL,
    reviewer          TEXT    NOT NULL,
    trigger_id        TEXT,
    trigger_kind      TEXT,
    target_ref        TEXT,
    target_head_sha   TEXT,
    policy_digest     TEXT,
    review_mode       TEXT,
    coverage_base_sha TEXT,
    coverage_complete INTEGER NOT NULL DEFAULT 0,
    phase             TEXT    NOT NULL
                      CHECK (phase IN ('queued','running','posting','posted','failed','cancelled')),
    superseded_by_sha TEXT,
    post_started_at   TEXT,
    summary           TEXT,
    comment_count     INTEGER,
    error             TEXT,
    requested_at      TEXT    NOT NULL,
    completed_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS current_reviews (
    owner              TEXT    NOT NULL,
    repo               TEXT    NOT NULL,
    pull_number        INTEGER NOT NULL,
    current_generation INTEGER NOT NULL,
    PRIMARY KEY (owner, repo, pull_number),
    FOREIGN KEY (current_generation) REFERENCES reviews(generation)
  );

  CREATE INDEX IF NOT EXISTS reviews_change_phase
    ON reviews (owner, repo, pull_number, phase);
`;

const TRIGGER_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS reviews_trigger_identity
    ON reviews (owner, repo, pull_number, trigger_id)
    WHERE trigger_id IS NOT NULL;
`;

export class ReviewStore {
  #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("busy_timeout = 5000");
    this.#initializeSchema();
  }

  #initializeSchema(): void {
    const exists = this.#db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviews'"
      )
      .get();
    if (!exists) {
      this.#db.exec(REVIEW_SCHEMA);
      this.#db.exec(TRIGGER_INDEX);
      return;
    }

    const columns = this.#db
      .prepare("PRAGMA table_info(reviews)")
      .all() as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "generation")) {
      this.#db.exec(REVIEW_SCHEMA);
      for (const name of ["trigger_id", "trigger_kind", "target_ref", "target_head_sha", "policy_digest", "review_mode", "coverage_base_sha", "coverage_complete"]) {
        if (!columns.some((column) => column.name === name)) {
          this.#db.exec(name === "coverage_complete"
            ? "ALTER TABLE reviews ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 0"
            : `ALTER TABLE reviews ADD COLUMN ${name} TEXT`);
        }
      }
      this.#db.exec(TRIGGER_INDEX);
      return;
    }

    this.#db.transaction(() => {
      this.#db.exec("ALTER TABLE reviews RENAME TO reviews_legacy");
      this.#db.exec(REVIEW_SCHEMA);
      this.#db.exec(`
        INSERT INTO reviews
          (owner, repo, pull_number, head_sha, reviewer, phase, summary,
           comment_count, error, requested_at, completed_at)
        SELECT owner, repo, pull_number, head_sha, reviewer,
               CASE status WHEN 'pending' THEN 'queued' ELSE status END,
               summary, comment_count, error, requested_at, completed_at
          FROM reviews_legacy
         ORDER BY requested_at, rowid;

        INSERT INTO current_reviews (owner, repo, pull_number, current_generation)
        SELECT owner, repo, pull_number, MAX(generation)
          FROM reviews
         GROUP BY owner, repo, pull_number;

        DROP TABLE reviews_legacy;
      `);
    })();
    this.#db.exec(TRIGGER_INDEX);
  }

  /** Admit a host-confirmed current head and atomically supersede its predecessors. */
  admit(
    ref: ReviewRef,
    reviewer: string,
    now: string,
    trigger?: { id: string; kind: string },
    target?: { ref: string; head_sha: string },
    policyDigest?: string,
  ): ReviewAdmission {
    const claim = this.#db.transaction((): ReviewAdmission => {
      if (trigger?.id) {
        const previous = this.#db.prepare(
          `SELECT generation FROM reviews
            WHERE owner = @owner AND repo = @repo AND pull_number = @pull_number
              AND trigger_id = @trigger_id LIMIT 1`,
        ).get({ ...ref, trigger_id: trigger.id }) as { generation: number } | undefined;
        if (previous) return { kind: "duplicate", generation: previous.generation };
      }
      const current = this.currentForChange(ref);
      if (current?.head_sha === ref.head_sha && !trigger?.id) {
        if (current.phase !== "failed") {
          return { kind: "duplicate", generation: current.generation };
        }

        this.#db
          .prepare(
            `UPDATE reviews
                SET phase = 'queued', reviewer = @reviewer, requested_at = @now,
                    superseded_by_sha = NULL, post_started_at = NULL,
                    summary = NULL, comment_count = NULL, error = NULL,
                    completed_at = NULL
              WHERE generation = @generation`
          )
          .run({ generation: current.generation, reviewer, now });
        return {
          kind: "accepted",
          generation: current.generation,
          superseded: [],
        };
      }

      const superseded = this.#db
        .prepare(
          `SELECT generation
             FROM reviews
            WHERE owner = @owner AND repo = @repo AND pull_number = @pull_number
              AND phase IN ('queued','running','posting')
              AND superseded_by_sha IS NULL
            ORDER BY generation`
        )
        .all(ref) as Array<{ generation: number }>;

      const inserted = this.#db
        .prepare(
          `INSERT INTO reviews
             (owner, repo, pull_number, head_sha, reviewer, trigger_id,
              trigger_kind, target_ref, target_head_sha, policy_digest,
              phase, requested_at)
           VALUES (@owner, @repo, @pull_number, @head_sha, @reviewer,
                   @trigger_id, @trigger_kind, @target_ref, @target_head_sha,
                   @policy_digest, 'queued', @now)`
        )
        .run({
          ...ref,
          reviewer,
          now,
          trigger_id: trigger?.id ?? null,
          trigger_kind: trigger?.kind ?? null,
          target_ref: target?.ref ?? null,
          target_head_sha: target?.head_sha ?? null,
          policy_digest: policyDigest ?? null,
        });
      const generation = Number(inserted.lastInsertRowid);

      this.#db
        .prepare(
          `UPDATE reviews
              SET phase = CASE WHEN phase IN ('queued','running') THEN 'cancelled' ELSE phase END,
                  superseded_by_sha = @head_sha,
                  completed_at = CASE
                    WHEN phase IN ('queued','running') THEN @now
                    ELSE completed_at
                  END
            WHERE owner = @owner AND repo = @repo AND pull_number = @pull_number
              AND generation <> @generation
              AND phase IN ('queued','running','posting')
              AND superseded_by_sha IS NULL`
        )
        .run({ ...ref, generation, now });
      this.#setCurrent(ref, generation);
      return {
        kind: "accepted",
        generation,
        superseded: superseded.map(({ generation: value }) => value),
      };
    });
    return claim();
  }

  #setCurrent(ref: ChangeRef, generation: number): void {
    this.#db
      .prepare(
        `INSERT INTO current_reviews (owner, repo, pull_number, current_generation)
         VALUES (@owner, @repo, @pull_number, @generation)
         ON CONFLICT (owner, repo, pull_number)
         DO UPDATE SET current_generation = excluded.current_generation`
      )
      .run({ ...ref, generation });
  }

  start(generation: number): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE reviews
            SET phase = 'running'
          WHERE generation = @generation AND phase = 'queued'
            AND superseded_by_sha IS NULL
            AND EXISTS (
              SELECT 1 FROM current_reviews current
               WHERE current.current_generation = reviews.generation
            )`
        )
        .run({ generation }).changes === 1
    );
  }

  startPosting(generation: number, now: string): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE reviews
            SET phase = 'posting', post_started_at = @now
          WHERE generation = @generation AND phase = 'running'
            AND superseded_by_sha IS NULL
            AND EXISTS (
              SELECT 1 FROM current_reviews current
               WHERE current.current_generation = reviews.generation
            )`
        )
        .run({ generation, now }).changes === 1
    );
  }

  isCurrent(generation: number): boolean {
    return Boolean(
      this.#db
        .prepare(
          `SELECT 1
             FROM reviews
             JOIN current_reviews current
               ON current.current_generation = reviews.generation
            WHERE reviews.generation = @generation
              AND reviews.superseded_by_sha IS NULL`
        )
        .get({ generation })
    );
  }

  /** Fence a generation when a host-head check observes a replacement webhook has not admitted yet. */
  supersedeGeneration(
    generation: number,
    replacementHeadSha: string,
    now: string
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE reviews
            SET phase = CASE WHEN phase IN ('queued','running') THEN 'cancelled' ELSE phase END,
                superseded_by_sha = @replacementHeadSha,
                completed_at = CASE
                  WHEN phase IN ('queued','running') THEN @now
                  ELSE completed_at
                END
          WHERE generation = @generation
            AND phase IN ('queued','running','posting')
            AND superseded_by_sha IS NULL`
        )
        .run({ generation, replacementHeadSha, now }).changes === 1
    );
  }

  markGenerationPosted(
    generation: number,
    summary: string,
    commentCount: number,
    now: string,
    coverage?: { mode: "full" | "incremental" | "targeted"; baseSha?: string | null; complete: boolean },
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE reviews
            SET phase = 'posted', summary = @summary,
                comment_count = @commentCount, completed_at = @now,
                review_mode = @reviewMode,
                coverage_base_sha = @coverageBaseSha,
                coverage_complete = @coverageComplete
          WHERE generation = @generation AND phase = 'posting'`
        )
        .run({
          generation, summary, commentCount, now,
          reviewMode: coverage?.mode ?? null,
          coverageBaseSha: coverage?.baseSha ?? null,
          coverageComplete: coverage?.complete ? 1 : 0,
        }).changes === 1
    );
  }

  markGenerationFailed(
    generation: number,
    error: string,
    now: string
  ): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE reviews
            SET phase = 'failed', error = @error, completed_at = @now
          WHERE generation = @generation AND phase IN ('queued','running')`
        )
        .run({ generation, error, now }).changes === 1
    );
  }

  /** Recover only work that had not crossed the durable posting boundary. */
  recoverOrphans(now: string): number {
    return this.#db
      .prepare(
        `UPDATE reviews
            SET phase = 'failed',
                error = 'orphaned: process restarted before posting',
                completed_at = @now
          WHERE phase IN ('queued','running')`
      )
      .run({ now }).changes;
  }

  get(ref: ReviewRef): ReviewRecord | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM reviews
          WHERE owner = @owner AND repo = @repo
            AND pull_number = @pull_number AND head_sha = @head_sha
          ORDER BY generation DESC
          LIMIT 1`
      )
      .get(ref) as ReviewRecord | undefined;
  }

  getGeneration(generation: number): ReviewRecord | undefined {
    return this.#db
      .prepare("SELECT * FROM reviews WHERE generation = @generation")
      .get({ generation }) as ReviewRecord | undefined;
  }

  currentForChange(ref: ChangeRef): ReviewRecord | undefined {
    return this.#db
      .prepare(
        `SELECT reviews.*
           FROM current_reviews current
           JOIN reviews ON reviews.generation = current.current_generation
          WHERE current.owner = @owner AND current.repo = @repo
            AND current.pull_number = @pull_number`
      )
      .get(ref) as ReviewRecord | undefined;
  }

  latestCoverageForChange(
    ref: ChangeRef,
    target: { ref: string; head_sha: string },
  ): ReviewRecord | undefined {
    return this.#db.prepare(
      `SELECT * FROM reviews
        WHERE owner = @owner AND repo = @repo AND pull_number = @pull_number
          AND target_ref = @target_ref AND target_head_sha = @target_head_sha
          AND phase = 'posted' AND coverage_complete = 1
        ORDER BY generation DESC LIMIT 1`,
    ).get({
      ...ref,
      target_ref: target.ref,
      target_head_sha: target.head_sha,
    }) as ReviewRecord | undefined;
  }

  close(): void {
    this.#db.close();
  }
}
