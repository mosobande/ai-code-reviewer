import { createHash } from "node:crypto";
import { parseDocument, visit } from "yaml";

export const REVIEW_POLICY_FILE = ".acr.yml";

export type ApprovalMode = "human" | "bot";
export type ReviewPolicy = {
  approval: ApprovalMode;
  automatic: boolean;
  depth: "default" | "contextual" | "diff-only";
};
export type ReviewPolicyOverrides = Partial<ReviewPolicy>;
export type TrustedPolicyFileObservation =
  | { state: "observed"; blobSha: string; content: string }
  | { state: "absent" }
  | { state: "incomplete"; reason: string };

export type ReviewPolicySnapshot = {
  schemaVersion: 2;
  targetRef: string;
  targetHeadSha: string;
  fileState: TrustedPolicyFileObservation["state"];
  blobSha: string | null;
  contentDigest: string | null;
  instance: ReviewPolicy;
  overrides: ReviewPolicyOverrides | null;
  sources: Record<keyof ReviewPolicy, "instance" | ".acr.yml">;
  effective: ReviewPolicy | null;
  digest: string;
  error: string | null;
};

const MAX_POLICY_BYTES = 16 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseReviewGate(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(raw)}`);
}

export function parseInstanceReviewPolicy(
  env: Record<string, string | undefined>,
): ReviewPolicy {
  const raw = env.ACR_APPROVAL_MODE;
  const approval = raw?.trim().toLowerCase() || "human";
  if (approval !== "human" && approval !== "bot") {
    throw new Error(`ACR_APPROVAL_MODE must be "human" or "bot", got ${JSON.stringify(raw)}`);
  }
  return { approval, automatic: false, depth: "default" };
}

export function parseRepositoryPolicy(content: string): {
  review: ReviewPolicyOverrides;
  contentDigest: string;
} {
  if (Buffer.byteLength(content, "utf8") > MAX_POLICY_BYTES) {
    throw new Error(`${REVIEW_POLICY_FILE} exceeds the 16 KiB limit`);
  }
  if (content.includes("\u0000") || content.includes("\uFFFD")) {
    throw new Error(`${REVIEW_POLICY_FILE} is not valid UTF-8 text`);
  }

  const document = parseDocument(content, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) {
    throw new Error(`${REVIEW_POLICY_FILE} is invalid YAML: ${document.errors[0]!.message}`);
  }
  let hasIdentity = false;
  visit(document, {
    Alias: () => {
      hasIdentity = true;
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor) {
        hasIdentity = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (hasIdentity) {
    throw new Error(`${REVIEW_POLICY_FILE} aliases and anchors are not allowed`);
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error(`${REVIEW_POLICY_FILE} aliases are not allowed`);
  }
  if (!isRecord(parsed) || !onlyKeys(parsed, ["version", "review"]) || !("version" in parsed)) {
    throw new Error(`${REVIEW_POLICY_FILE} must contain only version and review`);
  }
  if (parsed.version !== 2) {
    throw new Error(`${REVIEW_POLICY_FILE} version must be 2`);
  }
  if (!isRecord(parsed.review) || !onlyKeys(parsed.review, ["approval", "automatic", "depth"])) {
    throw new Error(`${REVIEW_POLICY_FILE} review must contain only approval, automatic, and depth`);
  }
  const review: ReviewPolicyOverrides = {};
  if ("approval" in parsed.review) {
    if (parsed.review.approval !== "human" && parsed.review.approval !== "bot") {
      throw new Error(`${REVIEW_POLICY_FILE} review.approval must be human or bot`);
    }
    review.approval = parsed.review.approval;
  }
  if ("automatic" in parsed.review) {
    if (typeof parsed.review.automatic !== "boolean") {
      throw new Error(`${REVIEW_POLICY_FILE} review.automatic must be true or false`);
    }
    review.automatic = parsed.review.automatic;
  }
  if ("depth" in parsed.review) {
    if (parsed.review.depth !== "contextual" && parsed.review.depth !== "diff-only") {
      throw new Error(`${REVIEW_POLICY_FILE} review.depth must be contextual or diff-only`);
    }
    review.depth = parsed.review.depth;
  }
  return { review, contentDigest: sha256(canonical({ version: 2, review })) };
}

export function resolveReviewPolicy(
  instance: ReviewPolicy,
  targetRef: string,
  targetHeadSha: string,
  observed: TrustedPolicyFileObservation,
): ReviewPolicySnapshot {
  let overrides: ReviewPolicyOverrides | null = {};
  let effective: ReviewPolicy | null = instance;
  let contentDigest: string | null = null;
  let error: string | null = null;
  const sources: ReviewPolicySnapshot["sources"] = {
    approval: "instance", automatic: "instance", depth: "instance",
  };

  if (observed.state === "observed") {
    try {
      const parsed = parseRepositoryPolicy(observed.content);
      overrides = parsed.review;
      contentDigest = parsed.contentDigest;
      effective = { ...instance, ...overrides };
      if (overrides.approval !== undefined) sources.approval = ".acr.yml";
      if (overrides.automatic !== undefined) sources.automatic = ".acr.yml";
      if (overrides.depth !== undefined) sources.depth = ".acr.yml";
    } catch (caught) {
      overrides = null;
      effective = null;
      contentDigest = sha256(observed.content);
      error = `invalid ${REVIEW_POLICY_FILE}: ${caught instanceof Error ? caught.message : "invalid policy"}`;
    }
  } else if (observed.state === "incomplete") {
    overrides = null;
    effective = null;
    error = `${REVIEW_POLICY_FILE} could not be read completely: ${observed.reason}`;
  }

  const core = {
    schemaVersion: 2 as const,
    targetRef,
    targetHeadSha,
    fileState: observed.state,
    blobSha: observed.state === "observed" ? observed.blobSha : null,
    contentDigest,
    instance,
    overrides,
    sources,
    effective,
    error,
  };
  return { ...core, digest: sha256(canonical(core)) };
}
