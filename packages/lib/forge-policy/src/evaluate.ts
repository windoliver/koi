import type { ForgeScope } from "@koi/core";
import type { ForgeCandidate, ForgePolicyVerdict } from "@koi/forge-types";
import type { ForgePolicyConfig, PolicyOverride } from "./config.js";

/** Per-call inputs to `evaluatePolicy`. */
export interface EvaluatePolicyOptions {
  /**
   * Candidate spec used to compute artifact complexity. May be omitted
   * when `config.maxComplexity` is also omitted (no complexity gate).
   */
  readonly spec?: Readonly<Record<string, unknown>> | undefined;

  /**
   * Caller-supplied complexity metric that replaces the default
   * JSON-byte-length heuristic. Returned values that are not finite,
   * non-negative numbers are treated as `0`.
   */
  readonly complexityOf?: ((spec: Readonly<Record<string, unknown>>) => number) | undefined;

  /**
   * Explicit operator override. `granted: true` rewrites a `deny` or
   * `require-approval` verdict to `allow`. Never tightens an `allow`.
   */
  readonly override?: PolicyOverride | undefined;
}

/**
 * Pure, synchronous, deterministic policy evaluator. Evaluates checks in
 * fixed order (allowed kind → forbidden namespace → max complexity → max
 * scope → approval threshold) and returns the verdict from the first
 * failing check. If every check passes the verdict is `allow`.
 *
 * An override (`options.override.granted === true`) rewrites a `deny` or
 * `require-approval` verdict to `allow`. The override never tightens an
 * already-`allow` verdict and never changes the order of evaluation —
 * orchestrators that need to log the underlying (pre-override) verdict
 * should call `evaluatePolicy` once without the override and once with it.
 */
export function evaluatePolicy(
  candidate: ForgeCandidate,
  config: ForgePolicyConfig,
  options: EvaluatePolicyOptions = {},
): ForgePolicyVerdict {
  const verdict = evaluateChecks(candidate, config, options);
  return applyOverride(verdict, options.override);
}

function evaluateChecks(
  candidate: ForgeCandidate,
  config: ForgePolicyConfig,
  options: EvaluatePolicyOptions,
): ForgePolicyVerdict {
  if (!config.allowedKinds.includes(candidate.kind)) {
    return {
      decision: "deny",
      reason: `kind '${candidate.kind}' is not in allowedKinds`,
    };
  }

  const forbidden = matchForbiddenNamespace(candidate.name, config.forbiddenNamespaces);
  if (forbidden !== undefined) {
    return {
      decision: "deny",
      reason: `name '${candidate.name}' matches forbidden namespace '${forbidden}'`,
    };
  }

  if (config.maxComplexity !== undefined) {
    const score = computeComplexity(options.spec, options.complexityOf);
    if (score > config.maxComplexity) {
      return {
        decision: "deny",
        reason: `spec complexity ${score} exceeds maxComplexity ${config.maxComplexity}`,
      };
    }
  }

  if (scopeRank(candidate.proposedScope) > scopeRank(config.maxScope)) {
    return {
      decision: "deny",
      reason: `proposedScope '${candidate.proposedScope}' exceeds maxScope '${config.maxScope}'`,
    };
  }

  if (scopeRank(candidate.proposedScope) >= scopeRank(config.requireApprovalAtOrAbove)) {
    return {
      decision: "require-approval",
      reason: `proposedScope '${candidate.proposedScope}' is at or above approval threshold '${config.requireApprovalAtOrAbove}'`,
    };
  }

  return { decision: "allow" };
}

function applyOverride(
  verdict: ForgePolicyVerdict,
  override: PolicyOverride | undefined,
): ForgePolicyVerdict {
  if (override === undefined || override.granted !== true) return verdict;
  if (verdict.decision === "allow") return verdict;
  return { decision: "allow" };
}

const SCOPE_RANK = {
  agent: 0,
  zone: 1,
  global: 2,
} as const satisfies Record<ForgeScope, number>;

function scopeRank(scope: ForgeScope): number {
  return SCOPE_RANK[scope];
}

function matchForbiddenNamespace(
  name: string,
  prefixes: readonly string[] | undefined,
): string | undefined {
  if (prefixes === undefined) return undefined;
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) return prefix;
  }
  return undefined;
}

function computeComplexity(
  spec: Readonly<Record<string, unknown>> | undefined,
  custom: ((spec: Readonly<Record<string, unknown>>) => number) | undefined,
): number {
  if (spec === undefined) return 0;
  if (custom !== undefined) {
    const raw = custom(spec);
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  return canonicalize(spec).length;
}

/**
 * Insertion-order-independent JSON serialization. Keys are sorted at every
 * object level so `{a: 1, b: 2}` and `{b: 2, a: 1}` produce equal scores.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  const obj = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}
