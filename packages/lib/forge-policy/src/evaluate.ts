import type { ForgeScope } from "@koi/core";
import type { ForgeCandidate, ForgePolicyVerdict } from "@koi/forge-types";
import type { ForgePolicyConfig, PolicyOverride } from "./config.js";

/** Per-call inputs to `evaluatePolicy`. */
export interface EvaluatePolicyOptions {
  /**
   * Candidate spec used to compute artifact complexity. Required whenever
   * `config.maxComplexity` is set — `evaluatePolicy` fails closed (deny)
   * if the gate is configured but `spec` is absent.
   */
  readonly spec?: Readonly<Record<string, unknown>> | undefined;

  /**
   * Caller-supplied complexity metric that replaces the default
   * UTF-8-byte-length heuristic. Returned values that are not finite,
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
 * Result of `evaluatePolicy`. Always carries both the post-override
 * `verdict` (the one the caller should act on) and the pre-override
 * `baseVerdict` (the underlying check result before any override). When
 * `overrideApplied` is `true`, an operator override relaxed the
 * `baseVerdict` to `verdict`. Both are surfaced so the audit trail can
 * record what an override actually bypassed.
 */
export interface PolicyEvaluation {
  readonly verdict: ForgePolicyVerdict;
  readonly baseVerdict: ForgePolicyVerdict;
  readonly overrideApplied: boolean;
}

/**
 * Pure, synchronous, deterministic policy evaluator. Evaluates checks in
 * fixed order (allowed kind → forbidden namespace → max complexity → max
 * scope → approval threshold) and returns the verdict from the first
 * failing check. If every check passes the verdict is `allow`.
 *
 * An override (`options.override.granted === true`) rewrites a `deny` or
 * `require-approval` verdict to `allow` and sets `overrideApplied: true`
 * on the result. The override never tightens an already-`allow` verdict.
 *
 * Fail-closed cases (return `deny`):
 *   - `config.maxComplexity` is set but `options.spec` is absent.
 *   - `options.spec` cannot be canonicalized (cyclic reference or
 *     non-JSON-safe value such as `BigInt` / function / `Symbol`).
 */
export function evaluatePolicy(
  candidate: ForgeCandidate,
  config: ForgePolicyConfig,
  options: EvaluatePolicyOptions = {},
): PolicyEvaluation {
  const baseVerdict = evaluateChecks(candidate, config, options);
  const verdict = applyOverride(baseVerdict, options.override);
  const overrideApplied = verdict !== baseVerdict;
  return { verdict, baseVerdict, overrideApplied };
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
    const complexity = computeComplexity(options.spec, options.complexityOf);
    if (!complexity.ok) {
      return { decision: "deny", reason: complexity.reason };
    }
    if (complexity.score > config.maxComplexity) {
      return {
        decision: "deny",
        reason: `spec complexity ${complexity.score} exceeds maxComplexity ${config.maxComplexity}`,
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

type ComplexityResult =
  | { readonly ok: true; readonly score: number }
  | { readonly ok: false; readonly reason: string };

function computeComplexity(
  spec: Readonly<Record<string, unknown>> | undefined,
  custom: ((spec: Readonly<Record<string, unknown>>) => number) | undefined,
): ComplexityResult {
  if (spec === undefined) {
    return {
      ok: false,
      reason: "spec is required when maxComplexity is configured",
    };
  }
  // Validate AND detach the spec in a single pass. The walker reads via
  // descriptor `.value` only (never through getters or Proxy traps) and
  // builds a fully-detached plain-data clone. Canonicalization then runs
  // against the clone, so the original `spec` is never touched again
  // after validation — no user code can fire during scoring.
  const validation = validatePlainSpec(spec);
  if (!validation.ok) {
    return { ok: false, reason: `spec is not plain JSON data: ${validation.reason}` };
  }
  const canonical = canonicalize(validation.clone);
  if (canonical === undefined) {
    return {
      ok: false,
      reason: "spec could not be canonicalized",
    };
  }
  if (custom !== undefined) {
    let raw: unknown;
    try {
      raw = custom(spec);
    } catch {
      // A throwing scorer must produce a deterministic deny — never let
      // the exception escape the policy path.
      return { ok: false, reason: "complexityOf threw — failing closed" };
    }
    const score = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    return { ok: true, score };
  }
  return { ok: true, score: utf8ByteLength(canonical) };
}

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
  return TEXT_ENCODER.encode(s).byteLength;
}

type ValidationResult =
  | { readonly ok: true; readonly clone: unknown }
  | { readonly ok: false; readonly reason: string };

const OK_NULL: ValidationResult = { ok: true, clone: null };

function ok(clone: unknown): ValidationResult {
  return { ok: true, clone };
}

/**
 * Recursively validates that `spec` is side-effect-free, plain JSON data:
 *
 *   - allowed values: `null`, `string`, `number` (incl. non-finite),
 *     `boolean`, `undefined`, plain `Object` / `Array`
 *   - rejected: `bigint`, `function`, `symbol`, getters / setters, any
 *     own property named `"toJSON"`, any non-plain prototype (Date, Map,
 *     class instances), `Proxy`-trapped objects, and cycles
 *
 * Both objects AND arrays are walked by `Object.getOwnPropertyDescriptor`,
 * so accessor slots are detected by descriptor and never read through
 * `[[Get]]`. The whole walk is wrapped in `try/catch` so a `Proxy` whose
 * trap throws (or any unexpected reflection failure) degrades to a
 * deterministic deny rather than escaping the policy gate.
 */
function validatePlainSpec(value: unknown): ValidationResult {
  try {
    return validatePlainValue(value, new WeakSet());
  } catch {
    return {
      ok: false,
      reason: "spec inspection threw — likely a Proxy trap or hostile reflection target",
    };
  }
}

function validatePlainValue(value: unknown, seen: WeakSet<object>): ValidationResult {
  if (value === null) return OK_NULL;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean" || type === "undefined") {
    return ok(value);
  }
  if (type === "bigint") return { ok: false, reason: "BigInt is not JSON-safe" };
  if (type === "function") return { ok: false, reason: "function values are not allowed" };
  if (type === "symbol") return { ok: false, reason: "symbol values are not allowed" };
  if (type !== "object") return { ok: false, reason: `unsupported value type '${type}'` };

  const obj = value as object;
  if (seen.has(obj)) return { ok: false, reason: "cyclic reference" };

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return { ok: false, reason: "non-plain object (custom prototype)" };
  }
  if (Object.hasOwn(obj, "toJSON")) {
    return { ok: false, reason: "own toJSON method is not allowed (pre-serialize the spec)" };
  }

  seen.add(obj);
  const result = validatePlainContainer(obj, seen);
  seen.delete(obj);
  return result;
}

/**
 * Walks own enumerable property descriptors of `obj` (which may be a
 * plain object or an array). Reads values only via `descriptor.value` so
 * a getter at any key — numeric or string — is detected and rejected
 * before its `[[Get]]` would fire. Builds a detached clone of the
 * validated subtree so downstream canonicalization never reaches back to
 * the original object (and therefore cannot trigger Proxy `get` traps).
 */
function validatePlainContainer(obj: object, seen: WeakSet<object>): ValidationResult {
  const isArray = Array.isArray(obj);
  const cloneArr: unknown[] = [];
  // Null-prototype accumulator so an own `__proto__` key on the spec
  // becomes an ordinary data property on the clone instead of mutating
  // the clone's prototype (which would silently drop it from JSON
  // serialization and let attackers hide a large subtree under
  // `__proto__` past the complexity gate).
  const cloneObj: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(obj);
  for (const k of keys) {
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (desc === undefined) continue;
    if (desc.get !== undefined || desc.set !== undefined) {
      return { ok: false, reason: `getter/setter on key '${k}'` };
    }
    const r = validatePlainValue(desc.value, seen);
    if (!r.ok) return r;
    if (isArray) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0) cloneArr[idx] = r.clone;
    } else {
      cloneObj[k] = r.clone;
    }
  }
  return ok(isArray ? cloneArr : cloneObj);
}

/**
 * Canonical JSON serialization with sorted keys at every object level so
 * two semantically equal specs produce equal scores. MUST be called only
 * after `validatePlainSpec` has confirmed the graph is plain JSON data —
 * once validated, no user code (getters, toJSON) can execute during the
 * walk. Returns `undefined` if the value cannot be stringified (defensive
 * — should not happen on a validated graph).
 */
function canonicalize(value: unknown): string | undefined {
  try {
    const out = JSON.stringify(value, sortKeysReplacer);
    return out ?? "";
  } catch {
    return undefined;
  }
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  // Null-prototype target so `record["__proto__"]` becomes a real own
  // property on `sorted` rather than mutating its prototype chain.
  const sorted: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(record).sort()) {
    sorted[k] = record[k];
  }
  return sorted;
}
