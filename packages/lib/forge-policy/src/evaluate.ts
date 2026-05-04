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
    const complexity = computeComplexity(options.spec, options.complexityOf, config.maxComplexity);
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
  maxComplexity: number,
): ComplexityResult {
  if (spec === undefined) {
    return {
      ok: false,
      reason: "spec is required when maxComplexity is configured",
    };
  }
  // Default path uses `maxComplexity` as the lower-bound budget. The
  // custom-scorer path opts out of byte-length scoring but still keeps
  // a generous *structural* budget (`STRUCTURAL_BUDGET_BYTES`) so a
  // hostile caller cannot use a tiny `complexityOf` to amplify
  // validation/cloning cost on a multi-MB spec. Honest specs are well
  // below this ceiling.
  const useStructuralCap = custom !== undefined;
  const lowerBoundBudget = useStructuralCap ? STRUCTURAL_BUDGET_BYTES : maxComplexity;
  const budgetLabel = useStructuralCap ? "structuralBudgetBytes" : "maxComplexity";
  // Validate AND detach the spec in a single pass. The walker reads via
  // descriptor `.value` only (never through getters or Proxy traps) and
  // builds a fully-detached plain-data clone. Canonicalization then runs
  // against the clone, so the original `spec` is never touched again
  // after validation — no user code can fire during scoring.
  //
  // The walker also accumulates a *lower-bound* JSON byte count against
  // `lowerBoundBudget` and bails out as soon as that bound is exceeded,
  // so an attacker who packs many sparse arrays — each under the
  // per-array cap but summing past the budget — cannot force the gate
  // to materialize a multi-MB canonical string before denying. When a
  // custom scorer is in play we skip the budget short-circuit (no
  // serialization cost on that path).
  const validation = validatePlainSpec(spec, lowerBoundBudget, budgetLabel);
  if (!validation.ok) {
    return { ok: false, reason: `spec is not plain JSON data: ${validation.reason}` };
  }
  // Custom-scorer path short-circuits BEFORE canonicalization so we
  // never pay the serialization cost when the caller explicitly opted
  // out of the byte-length heuristic.
  if (custom !== undefined) {
    // Hand the scorer the validated detached clone directly — NEVER
    // the original spec. The clone is plain JSON data: ordinary
    // objects (with `Object.prototype` available so `hasOwnProperty`
    // etc. work), every `__proto__` key is a regular own data property
    // (installed via `defineProperty`, not assignment), arrays are
    // dense (holes/`undefined` materialized as own `null`), no
    // getters, no Proxy traps, no cycles.
    const cloneForScorer = validation.clone as Readonly<Record<string, unknown>>;
    let raw: unknown;
    try {
      raw = custom(cloneForScorer);
    } catch {
      // A throwing scorer must produce a deterministic deny — never let
      // the exception escape the policy path.
      return { ok: false, reason: "complexityOf threw — failing closed" };
    }
    const score = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    return { ok: true, score };
  }
  const canonical = canonicalize(validation.clone);
  if (canonical === undefined) {
    return {
      ok: false,
      reason: "spec could not be canonicalized",
    };
  }
  return { ok: true, score: utf8ByteLength(canonical) };
}

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
  return TEXT_ENCODER.encode(s).byteLength;
}

/**
 * Hard upper bound on a single array's length during validation.
 * Prevents an oversized sparse array (e.g. `Array(2**30)`) from forcing
 * the gate to allocate / serialize a multi-GB string before producing a
 * deny. Honest specs are well below this.
 *
 * Exported so callers can document acceptance criteria from the
 * implementation cap; this is a hard implementation limit, not a
 * tunable policy field.
 */
export const MAX_ARRAY_LENGTH = 100_000;

/**
 * Structural lower-bound budget applied even when a custom
 * `complexityOf` scorer is supplied. Stops a hostile spec from forcing
 * the validator to clone a multi-MB graph just so a tiny custom score
 * lets it through. Conservative ceiling at 10 MB.
 *
 * Exported so callers using `complexityOf` can document this implicit
 * upper bound; this is a hard implementation limit, not a tunable
 * policy field.
 */
export const STRUCTURAL_BUDGET_BYTES = 10_000_000;

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
interface WalkState {
  readonly seen: WeakSet<object>;
  /** Mutable: bytes consumed so far against the lower-bound budget. */
  consumed: number;
  /** Hard ceiling for `consumed` — exceeding this is an early fail-closed deny. */
  readonly budget: number;
  /** Human-readable label for `budget` so deny reasons name the right limit. */
  readonly budgetLabel: string;
}

class BudgetExceeded extends Error {
  constructor(consumed: number, budget: number, label: string) {
    super(`spec lower-bound complexity ${consumed} exceeds ${label} (${budget})`);
  }
}

function validatePlainSpec(value: unknown, budget: number, budgetLabel: string): ValidationResult {
  const state: WalkState = { seen: new WeakSet(), consumed: 0, budget, budgetLabel };
  try {
    return validatePlainValue(value, state);
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      return { ok: false, reason: e.message };
    }
    return {
      ok: false,
      reason: "spec inspection threw — likely a Proxy trap or hostile reflection target",
    };
  }
}

function charge(state: WalkState, bytes: number): void {
  state.consumed += bytes;
  if (state.consumed > state.budget) {
    throw new BudgetExceeded(state.consumed, state.budget, state.budgetLabel);
  }
}

/**
 * Charges the exact JSON-encoded UTF-8 byte length of `s` (including the
 * two surrounding quotes) WITHOUT materializing the escaped form. Bails
 * out via `BudgetExceeded` as soon as the running total overruns the
 * budget — so a 100 MB hostile string is not allocated a second time
 * just to measure it.
 */
function chargeJsonStringBytes(state: WalkState, s: string): void {
  let pending = 2; // surrounding quotes
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) {
      pending += 2; // \" or \\
    } else if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      pending += 2; // \b \t \n \f \r
    } else if (c < 0x20) {
      pending += 6; // \u00XX
    } else if (c < 0x80) {
      pending += 1;
    } else if (c < 0x800) {
      pending += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate: must be paired with an immediately-following
      // low surrogate (DC00–DFFF) to be a valid 4-byte UTF-8 codepoint.
      // Otherwise JSON.stringify escapes it as `\udXXX` (6 ASCII bytes).
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        pending += 4;
        i++;
      } else {
        pending += 6;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // Lone low surrogate → JSON.stringify emits `\udXXX` (6 bytes).
      pending += 6;
    } else {
      pending += 3;
    }
    // Flush every 4096 chars so we early-exit on huge hostile strings
    // long before we walk to the end.
    if ((i & 0xfff) === 0xfff) {
      charge(state, pending);
      pending = 0;
    }
  }
  if (pending > 0) charge(state, pending);
}

function validatePlainValue(value: unknown, state: WalkState): ValidationResult {
  if (value === null) {
    charge(state, 4); // "null"
    return OK_NULL;
  }
  const type = typeof value;
  if (type === "string") {
    // Streaming UTF-8/escape-aware byte count. Bails out early via
    // BudgetExceeded once the running total overruns the budget, so a
    // hostile multi-MB string is never serialized just to measure it.
    chargeJsonStringBytes(state, value as string);
    return ok(value);
  }
  if (type === "boolean") {
    charge(state, value ? 4 : 5); // "true" / "false"
    return ok(value);
  }
  if (type === "number") {
    // Exact JSON-encoded byte length. Non-finite numbers (NaN, ±Infinity)
    // serialize as `null` in JSON.stringify, which is the same form the
    // canonicalize pass produces — charge 4 to stay consistent.
    const n = value as number;
    charge(state, Number.isFinite(n) ? String(n).length : 4);
    return ok(value);
  }
  if (type === "undefined") {
    // Caller (the array path in validatePlainContainer) charges 4 for
    // explicit-undefined array elements. In object context the property
    // is silently omitted by JSON.stringify, so it costs 0 here.
    return ok(value);
  }
  if (type === "bigint") return { ok: false, reason: "BigInt is not JSON-safe" };
  if (type === "function") return { ok: false, reason: "function values are not allowed" };
  if (type === "symbol") return { ok: false, reason: "symbol values are not allowed" };
  if (type !== "object") return { ok: false, reason: `unsupported value type '${type}'` };

  const obj = value as object;
  if (state.seen.has(obj)) return { ok: false, reason: "cyclic reference" };

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return { ok: false, reason: "non-plain object (custom prototype)" };
  }
  if (Object.hasOwn(obj, "toJSON")) {
    return { ok: false, reason: "own toJSON method is not allowed (pre-serialize the spec)" };
  }

  state.seen.add(obj);
  const result = validatePlainContainer(obj, state);
  state.seen.delete(obj);
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
function validatePlainContainer(obj: object, state: WalkState): ValidationResult {
  const isArray = Array.isArray(obj);
  const arrLength = isArray ? readArrayLength(obj as readonly unknown[]) : 0;

  if (isArray && arrLength > MAX_ARRAY_LENGTH) {
    return {
      ok: false,
      reason: `array length ${arrLength} exceeds MAX_ARRAY_LENGTH (${MAX_ARRAY_LENGTH})`,
    };
  }

  // Charge framing bytes: brackets/braces (`[]` or `{}`) plus the
  // length-1 commas between elements. For arrays this is independent of
  // content and trips the budget for huge sparse arrays before we even
  // touch the per-slot loop.
  charge(state, 2);
  if (isArray && arrLength > 1) charge(state, arrLength - 1);

  if (isArray) {
    return validatePlainArrayByIndex(obj as readonly unknown[], arrLength, state);
  }

  // Object: JSON.stringify only serializes own enumerable string-keyed
  // properties, so iterating Object.keys is exact. The clone uses an
  // ordinary `{}` (so caller scorers see Object.prototype methods like
  // `hasOwnProperty`) but we install keys via `Object.defineProperty`
  // so an own `__proto__` key remains a regular data property instead
  // of mutating the prototype chain.
  const cloneObj: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  let firstObjectKey = true;
  for (const k of keys) {
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (desc === undefined) continue;
    if (desc.get !== undefined || desc.set !== undefined) {
      return { ok: false, reason: `getter/setter on key '${k}'` };
    }
    // Charge key bytes even when `desc.value === undefined`.
    // `JSON.stringify` would omit such keys (canonical bytes = 0), but
    // we still walk every descriptor and `defineProperty` each one, so
    // an attacker can otherwise stuff millions of `undefined` properties
    // past the budget while the canonical-byte counter stays at zero.
    // The budget is therefore a *work* lower-bound, not strictly a
    // canonical-JSON byte bound.
    if (desc.value === undefined) {
      chargeJsonStringBytes(state, k);
      Object.defineProperty(cloneObj, k, {
        value: undefined,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }
    if (!firstObjectKey) charge(state, 1);
    firstObjectKey = false;
    // Exact JSON-encoded UTF-8 bytes for the key + 1 for the colon.
    chargeJsonStringBytes(state, k);
    charge(state, 1);
    const r = validatePlainValue(desc.value, state);
    if (!r.ok) return r;
    Object.defineProperty(cloneObj, k, {
      value: r.clone,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return ok(cloneObj);
}

/**
 * Walks an array by numeric index — NOT by `Object.keys` — so
 * non-enumerable indexed properties (which `JSON.stringify` still
 * serializes) cannot escape the policy gate. Also rejects extra
 * non-index own properties, since the canonical pass would not include
 * those in the score.
 */
function validatePlainArrayByIndex(
  arr: readonly unknown[],
  length: number,
  state: WalkState,
): ValidationResult {
  // Reject any extra (non-index) own enumerable properties — those are
  // ignored by JSON.stringify and would create a score / serialization
  // mismatch.
  for (const k of Object.keys(arr)) {
    if (!isCanonicalArrayIndex(k, length)) {
      return {
        ok: false,
        reason: `array carries non-index own property '${k}' — not JSON-safe`,
      };
    }
  }

  // Materialize every index as an own slot so reads cannot fall
  // through to `Array.prototype` (defends against ambient prototype
  // pollution during scoring). Holes and `undefined` both serialize as
  // `null` in JSON, so we store `null` for them on the detached clone.
  const cloneArr: unknown[] = new Array(length);
  for (let i = 0; i < length; i++) {
    const desc = Object.getOwnPropertyDescriptor(arr, i);
    if (desc === undefined) {
      charge(state, 4); // hole → "null"
      cloneArr[i] = null;
      continue;
    }
    if (desc.get !== undefined || desc.set !== undefined) {
      return { ok: false, reason: `getter/setter on array index ${i}` };
    }
    const r = validatePlainValue(desc.value, state);
    if (!r.ok) return r;
    if (desc.value === undefined) {
      charge(state, 4); // explicit undefined → "null"
      cloneArr[i] = null;
    } else {
      cloneArr[i] = r.clone;
    }
  }
  return ok(cloneArr);
}

/**
 * Canonical array-index predicate matching `JSON.stringify` behavior:
 * the key must be the literal decimal representation of a non-negative
 * integer below `length` — `"0"`, `"1"`, ..., but NOT `"01"`, `"1.0"`,
 * `"-0"`, `" 1"`, or `"1e1"`. This is the same canonicalization used by
 * `Array.prototype` for "real" indices.
 */
const CANONICAL_INDEX_RE = /^(0|[1-9][0-9]*)$/;

function isCanonicalArrayIndex(k: string, length: number): boolean {
  if (!CANONICAL_INDEX_RE.test(k)) return false;
  const idx = Number(k);
  return Number.isInteger(idx) && idx >= 0 && idx < length;
}

/** Reads `length` via descriptor so a getter on `length` cannot fire. */
function readArrayLength(arr: readonly unknown[]): number {
  const desc = Object.getOwnPropertyDescriptor(arr, "length");
  const value = desc?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
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
