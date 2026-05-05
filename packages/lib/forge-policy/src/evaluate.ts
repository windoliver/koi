import type { ForgeScope } from "@koi/core";
import type { ForgeCandidate, ForgePolicyVerdict } from "@koi/forge-types";
import type { ForgePolicyConfig, PolicyOverride } from "./config.js";
import { computeConfigFingerprint } from "./fingerprint.js";

/** Per-call inputs to `evaluatePolicy`. */
export interface EvaluatePolicyOptions {
  /**
   * Candidate spec used to compute artifact complexity. Required whenever
   * `config.maxComplexity` is set — `evaluatePolicy` fails closed (deny)
   * if the gate is configured but `spec` is absent.
   */
  /**
   * UNSAFE for adversarial input. Live object passed by reference —
   * the validator walks it via reflection (`Object.getPrototypeOf`,
   * `getOwnPropertyDescriptor`, `Object.keys`). On a Proxy or an
   * object with hostile getters, those reflective ops fire trap
   * callbacks during evaluation. The top-level `try/catch` in
   * `validatePlainSpec` degrades trap throws to a deterministic
   * deny, so the verdict is always correct, but trap side effects
   * cannot be prevented when introspecting an attacker-owned
   * object. For untrusted candidate input prefer `specJson`, which
   * crosses a JSON serialization boundary before evaluation and
   * never reflects on the original object.
   */
  readonly spec?: Readonly<Record<string, unknown>> | undefined;

  /**
   * Pre-serialized JSON form of the candidate spec. SAFE for
   * adversarial input: `evaluatePolicy` decodes it via `JSON.parse`
   * inside a fail-closed `try/catch`, then evaluates the parsed
   * plain-data graph. No reflection ever reaches a caller-owned
   * object, so Proxy traps and getter callbacks cannot fire during
   * evaluation. Mutually exclusive with `spec` — supplying both
   * fails closed. Recommended for any deployment that treats the
   * candidate spec as untrusted input.
   */
  readonly specJson?: string | undefined;

  /**
   * Caller-supplied complexity metric that replaces the default
   * UTF-8-byte-length heuristic. Returned values that are not finite,
   * non-negative numbers are treated as `0`.
   */
  readonly complexityOf?: ((spec: Readonly<Record<string, unknown>>) => number) | undefined;

  /**
   * Provenance metadata for the `complexityOf` scorer. Required
   * whenever `complexityOf` is set — `evaluatePolicy` fails closed
   * (deny) otherwise. Both `id` AND `version` are bound into
   * `configFingerprint`. The caller MUST bump `version` whenever the
   * scorer's runtime behavior can change (different closure state,
   * different ambient globals, different feature-flag state, new
   * implementation, etc.). Two evaluations that ran under
   * semantically different scorers must never share `(id, version)`.
   * Function source text is intentionally NOT hashed — closures and
   * ambient state make source text a misleading provenance signal.
   */
  readonly complexityScorer?: { readonly id: string; readonly version: string } | undefined;

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
  /**
   * The override that was supplied to `evaluatePolicy`, echoed back so
   * audit logs can bind the recorded operator-attribution data to the
   * exact evaluation that produced the verdict (preventing a caller
   * from logging a different `grantedBy`/`reason` pair than the one
   * that actually relaxed the verdict).
   */
  readonly override?: PolicyOverride | undefined;
  /**
   * SHA-256 fingerprint of the config that produced this evaluation,
   * computed inside `evaluatePolicy` at decision time. Audit logs use
   * this value (not the live config) so post-evaluation config
   * mutations cannot rewrite the recorded policy identity.
   */
  readonly configFingerprint: string;
  /**
   * The `candidate.id` evaluated. `recordEvaluation` writes this value
   * (not a caller-supplied id) into the audit entry so an authentic
   * evaluation for one candidate cannot be replayed and logged under
   * a different candidate id.
   */
  readonly candidateId: string;
  /**
   * Set on fail-closed evaluations only — names which input failed
   * snapshot validation (or override pre-validation). `undefined` on
   * successful evaluations. Kept separate from `configFingerprint` so
   * audit consumers can join entries back to the real policy version
   * even when the evaluation denied for a malformed override.
   */
  readonly failureKind?: "candidate" | "override" | "config";
  /**
   * Human-readable detail for `failureKind`. `undefined` on successful
   * evaluations. Never embedded into `configFingerprint`.
   */
  readonly failureReason?: string;
}

/** Sentinel `configFingerprint` used when the real fingerprint cannot
 *  be computed (i.e. candidate/override/config snapshot failed before
 *  fingerprinting). Distinct from any real SHA-256 hex digest. */
const UNAVAILABLE_FINGERPRINT = "<unavailable>";

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
/**
 * Closure-private set of authentic `PolicyEvaluation` objects produced
 * by `evaluatePolicy`. Unforgeable: no module-external code holds a
 * reference to this WeakSet, so a caller cannot brand a fabricated
 * literal as authentic. Garbage-collected automatically with the
 * evaluation it brands. Module-duplication is not a concern in this
 * Bun-only monorepo (`linker = "isolated"` ensures a single instance
 * of `@koi/forge-policy` is loaded).
 */
/*
 * KNOWN LIMITATION: `AUTHENTIC_EVALUATIONS` is closure-private to this
 * module instance. If the same package is loaded twice in one process
 * (e.g. multiple bundles, a separate Worker thread, two `require`
 * trees), evaluations from one copy are not recognized by the other
 * — `recordEvaluation` will reject them as fabricated. Bun's
 * `linker = "isolated"` setting ensures a single instance of
 * `@koi/forge-policy` is loaded inside one process; cross-Worker /
 * cross-bundle deployments must serialize evaluations across the
 * boundary and re-evaluate at the persistence-process boundary, or
 * use the same factory instance for both `evaluatePolicy` and
 * `createPolicyAuditLog`. A signed payload + verifying secret is
 * deliberately not used because either (a) the secret is process-
 * local (same constraint as the WeakSet) or (b) the secret is
 * shared across instances (then the signature is forgeable by any
 * holder of the secret). This is a fundamental trust-boundary
 * choice, not a bug.
 */
const AUTHENTIC_EVALUATIONS = new WeakSet<object>();

export function isAuthenticEvaluation(value: unknown): value is PolicyEvaluation {
  return typeof value === "object" && value !== null && AUTHENTIC_EVALUATIONS.has(value);
}

export function evaluatePolicy(
  candidate: ForgeCandidate,
  config: ForgePolicyConfig,
  options: EvaluatePolicyOptions = {},
): PolicyEvaluation {
  // Snapshot every caller-supplied input as deep-frozen plain data
  // BEFORE any caller-controlled code runs. Order matters:
  //   1. `candidate` — captures id/scope/kind/name so a later
  //      `complexityOf` cannot mutate `candidate.id` to forge audit
  //      attribution or `candidate.proposedScope` to bypass scope gates.
  //   2. `override` — captures granted/reason/grantedBy so the same
  //      callback cannot mutate `options.override.granted` to flip the
  //      verdict.
  //   3. `config` — same reasoning, plus the fingerprint is computed
  //      against this snapshot to pin audit identity at decision time.
  // Each snapshot uses a descriptor-only walk that rejects accessors,
  // non-plain prototypes, and BigInt/Symbol/Function values. NOTE: we
  // can't fully neutralize hostile `Proxy` inputs (`Object.keys` and
  // `getOwnPropertyDescriptor` invoke traps) — `Proxy`-wrapped policy
  // inputs are unsupported. Reflective traps that mutate external
  // state during snapshotting are a caller bug; the verdict still
  // depends only on the snapshots, never on the live inputs.
  let candidateSnapshot: ForgeCandidate;
  try {
    candidateSnapshot = descriptorClone(candidate) as ForgeCandidate;
    deepFreeze(candidateSnapshot);
  } catch (e) {
    // Do NOT read any field from the live `candidate` here — that would
    // re-enter caller-controlled code after the snapshot failed.
    return makeFailClosedEvaluation({
      reason: `candidate is not serializable: ${e instanceof Error ? e.message : String(e)}`,
      candidateId: "<invalid>",
      override: undefined,
      kind: "candidate",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Reject malformed candidate.id immediately — the audit writer
  // requires a non-empty string id, and we must not return an authentic
  // evaluation that the caller could act on but would then fail to
  // persist. The fail-closed evaluation uses a sentinel id so the
  // resulting audit entry is itself recordable.
  if (typeof candidateSnapshot.id !== "string" || candidateSnapshot.id.length === 0) {
    return makeFailClosedEvaluation({
      reason: "candidate.id must be a non-empty string",
      candidateId: "<invalid>",
      override: undefined,
      kind: "candidate",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Read every `options.*` field ONCE inside a fail-closed try/catch
  // so a hostile getter / Proxy trap cannot escape as an uncaught
  // exception and turn the policy gate into a DoS. Subsequent code
  // reads from these locals only — the live `options` object is never
  // touched again. Function values (`complexityOf`) cannot be
  // descriptor-cloned, so we capture the reference and let
  // `computeComplexity` defend against a throwing call separately.
  let optionOverride: PolicyOverride | undefined;
  let optionSpec: Readonly<Record<string, unknown>> | undefined;
  let optionSpecJson: string | undefined;
  let optionComplexityOf: ((spec: Readonly<Record<string, unknown>>) => number) | undefined;
  let optionComplexityScorer: { id: string; version: string } | undefined;
  try {
    optionOverride = options.override;
    optionSpec = options.spec;
    optionSpecJson = options.specJson;
    optionComplexityOf = options.complexityOf;
    // Snapshot scorer metadata (id+version) into plain locals so a
    // hostile getter on options.complexityScorer cannot fire later.
    const scorer = options.complexityScorer;
    if (scorer !== undefined) {
      optionComplexityScorer = { id: scorer.id, version: scorer.version };
    }
  } catch (e) {
    return makeFailClosedEvaluation({
      reason: `options getter threw: ${e instanceof Error ? e.message : String(e)}`,
      candidateId: candidateSnapshot.id,
      override: undefined,
      kind: "config",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  let overrideSnapshot: PolicyOverride | undefined;
  try {
    overrideSnapshot =
      optionOverride === undefined
        ? undefined
        : (descriptorClone(optionOverride) as PolicyOverride);
    if (overrideSnapshot !== undefined) deepFreeze(overrideSnapshot);
  } catch (e) {
    return makeFailClosedEvaluation({
      reason: `override is not serializable: ${e instanceof Error ? e.message : String(e)}`,
      candidateId: candidateSnapshot.id,
      override: undefined,
      kind: "override",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Reject ambiguous spec input. Supplying both `spec` (live object)
  // and `specJson` (serialized) is a caller bug — there is no
  // canonical resolution, and the safe path (`specJson`) must not
  // be silently shadowed by the unsafe one.
  if (optionSpec !== undefined && optionSpecJson !== undefined) {
    return makeFailClosedEvaluation({
      reason: "options.spec and options.specJson are mutually exclusive",
      candidateId: candidateSnapshot.id,
      override: overrideSnapshot,
      kind: "config",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Safe path: decode pre-serialized JSON spec at the trust boundary.
  // Reflection never touches caller-owned live objects.
  let resolvedSpec: Readonly<Record<string, unknown>> | undefined = optionSpec;
  if (optionSpecJson !== undefined) {
    // Cap input size BEFORE JSON.parse. A multi-GB caller-controlled
    // JSON string would otherwise burn CPU and exhaust memory inside
    // the parser before any later size guard could fire. Cap matches
    // STRUCTURAL_BUDGET_BYTES so honest inputs that fit the post-
    // parse validator also fit the pre-parse limit. Measure UTF-8
    // bytes — `String.length` counts UTF-16 code units, so a payload
    // of multibyte characters could otherwise stay under the check
    // while exceeding the advertised byte budget by 2-3×.
    // Cheap pre-screen first: a string whose UTF-16 length already
    // exceeds the byte budget cannot fit in UTF-8 either (each code
    // unit is at least one byte). Skips encoding huge strings.
    if (optionSpecJson.length > STRUCTURAL_BUDGET_BYTES) {
      return makeFailClosedEvaluation({
        reason: `options.specJson exceeds MAX_SPEC_JSON_BYTES (${STRUCTURAL_BUDGET_BYTES})`,
        candidateId: candidateSnapshot.id,
        override: overrideSnapshot,
        kind: "config",
        configFingerprint: UNAVAILABLE_FINGERPRINT,
      });
    }
    const specJsonByteLength = new TextEncoder().encode(optionSpecJson).byteLength;
    if (specJsonByteLength > STRUCTURAL_BUDGET_BYTES) {
      return makeFailClosedEvaluation({
        reason: `options.specJson exceeds MAX_SPEC_JSON_BYTES (${STRUCTURAL_BUDGET_BYTES})`,
        candidateId: candidateSnapshot.id,
        override: overrideSnapshot,
        kind: "config",
        configFingerprint: UNAVAILABLE_FINGERPRINT,
      });
    }
    try {
      const parsed = JSON.parse(optionSpecJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return makeFailClosedEvaluation({
          reason: "options.specJson must decode to a plain JSON object",
          candidateId: candidateSnapshot.id,
          override: overrideSnapshot,
          kind: "config",
          configFingerprint: UNAVAILABLE_FINGERPRINT,
        });
      }
      resolvedSpec = parsed as Readonly<Record<string, unknown>>;
    } catch (e) {
      return makeFailClosedEvaluation({
        reason: `options.specJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        candidateId: candidateSnapshot.id,
        override: overrideSnapshot,
        kind: "config",
        configFingerprint: UNAVAILABLE_FINGERPRINT,
      });
    }
  }
  // A custom complexity scorer changes verdict semantics — refuse to
  // emit an audited evaluation under one without (id, version)
  // metadata bound into the fingerprint. The caller MUST bump
  // `version` whenever scorer behavior changes (closures, ambient
  // state, implementation diff). Source-text hashing is intentionally
  // not used as a substitute — it cannot detect mutable closure or
  // ambient-global behavior changes and would give false confidence.
  if (
    optionComplexityOf !== undefined &&
    (optionComplexityScorer === undefined ||
      typeof optionComplexityScorer.id !== "string" ||
      optionComplexityScorer.id.length === 0 ||
      typeof optionComplexityScorer.version !== "string" ||
      optionComplexityScorer.version.length === 0)
  ) {
    return makeFailClosedEvaluation({
      reason:
        "complexityOf requires a complexityScorer with non-empty id and version for audit binding",
      candidateId: candidateSnapshot.id,
      override: overrideSnapshot,
      kind: "config",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Snapshot the config NOW (before override pre-validation) so that an
  // override-validation failure can still record the real policy
  // fingerprint — audit consumers must be able to join malformed-override
  // denials back to the policy version that evaluated them.
  let configSnapshot: ForgePolicyConfig;
  let configFingerprint: string;
  try {
    const result = snapshotConfig(config, optionComplexityScorer);
    configSnapshot = result.snapshot;
    configFingerprint = result.fingerprint;
  } catch (e) {
    return makeFailClosedEvaluation({
      reason: `config is not serializable: ${e instanceof Error ? e.message : String(e)}`,
      candidateId: candidateSnapshot.id,
      override: overrideSnapshot,
      kind: "config",
      configFingerprint: UNAVAILABLE_FINGERPRINT,
    });
  }
  // Validate override metadata for ANY supplied override (granted or
  // not). A blank reason/grantedBy on a granted override could let
  // `applyOverride` authorize the action and then crash
  // `recordEvaluation` — leaving the action as allow without an audit
  // entry. A blank reason/grantedBy on a non-granted override is also
  // rejected by `validateOverride` inside the audit writer, so it
  // would crash audit recording on an otherwise authentic deny. Both
  // cases must fail consistently inside `evaluatePolicy`.
  if (overrideSnapshot !== undefined) {
    const blankReason =
      typeof overrideSnapshot.reason !== "string" || overrideSnapshot.reason.length === 0;
    const blankGrantedBy =
      typeof overrideSnapshot.grantedBy !== "string" || overrideSnapshot.grantedBy.length === 0;
    if (blankReason || blankGrantedBy) {
      const attribution =
        !blankGrantedBy && typeof overrideSnapshot.grantedBy === "string"
          ? ` from grantedBy='${overrideSnapshot.grantedBy}'`
          : "";
      const grantedTag = overrideSnapshot.granted === true ? "granted " : "";
      return makeFailClosedEvaluation({
        reason: `${grantedTag}override missing reason or grantedBy${attribution}`,
        candidateId: candidateSnapshot.id,
        // Drop the malformed override on the fail-closed entry —
        // otherwise the audit writer's `validateOverride` would reject
        // the entry and the decision would be unrecordable.
        override: undefined,
        kind: "override",
        configFingerprint,
      });
    }
  }
  // Pass the trapped option values to evaluateChecks — never the live
  // `options` object — so no further `options.*` getter can fire.
  const baseVerdict = evaluateChecks(candidateSnapshot, configSnapshot, {
    spec: resolvedSpec,
    complexityOf: optionComplexityOf,
    override: overrideSnapshot,
  });
  const verdict = applyOverride(baseVerdict, overrideSnapshot);
  const overrideApplied = verdict !== baseVerdict;
  const evaluation: PolicyEvaluation = Object.freeze({
    verdict: Object.freeze({ ...verdict }),
    baseVerdict: Object.freeze({ ...baseVerdict }),
    overrideApplied,
    override: overrideSnapshot,
    configFingerprint,
    candidateId: candidateSnapshot.id,
  });
  AUTHENTIC_EVALUATIONS.add(evaluation);
  return evaluation;
}

interface ConfigSnapshotResult {
  readonly snapshot: ForgePolicyConfig;
  readonly fingerprint: string;
}

/**
 * Deep-clones `config` to a frozen plain-data snapshot WITHOUT
 * triggering caller-controlled code: every property read goes through
 * `Object.getOwnPropertyDescriptor`, so getters / `toJSON` / Proxy
 * traps never fire. Rejects accessors and non-plain prototypes by
 * throwing — caller wraps the throw and fails closed. The snapshot is
 * what the rest of `evaluatePolicy` reads, so a hostile `complexityOf`
 * cannot mutate the live config mid-evaluation, and a hostile config
 * cannot run side effects during snapshotting.
 */
function snapshotConfig(
  config: ForgePolicyConfig,
  complexityScorer: { readonly id: string; readonly version: string } | undefined,
): ConfigSnapshotResult {
  const cloned = descriptorClone(config) as ForgePolicyConfig;
  return {
    snapshot: deepFreeze(cloned),
    fingerprint: computeConfigFingerprint(cloned, complexityScorer),
  };
}

/**
 * Hard depth ceiling for `descriptorClone`. Honest candidate/config/
 * override inputs are flat (id/name/kind/scope/budget object). Anything
 * deeper than this is either a bug or a hostile graph attempting to
 * exhaust the call stack — fail closed before recursing further.
 */
const MAX_INPUT_DEPTH = 32;

/**
 * Hard ceiling for total descriptor visits across one
 * `descriptorClone` invocation. Stops a hostile candidate/config from
 * stuffing thousands of extra unused fields to force pathological work
 * on the intake path before any verdict is produced. Honest inputs
 * have well under this many fields.
 */
const MAX_INPUT_FIELDS = 1024;

interface CloneState {
  /** Cycle detection — input objects already seen on the current path. */
  readonly seen: WeakSet<object>;
  /** Total descriptor visits so far across the whole walk. */
  count: { value: number };
}

function descriptorClone(value: unknown): unknown {
  return descriptorCloneInner(value, 0, { seen: new WeakSet(), count: { value: 0 } });
}

function descriptorCloneInner(value: unknown, depth: number, state: CloneState): unknown {
  if (depth > MAX_INPUT_DEPTH) {
    throw new Error(`input depth exceeds MAX_INPUT_DEPTH (${MAX_INPUT_DEPTH})`);
  }
  state.count.value += 1;
  if (state.count.value > MAX_INPUT_FIELDS) {
    throw new Error(`input field count exceeds MAX_INPUT_FIELDS (${MAX_INPUT_FIELDS})`);
  }
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean" || t === "undefined") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("non-finite number");
    }
    return value;
  }
  if (t !== "object") {
    // BigInt, Symbol, Function — not JSON-safe, not allowed in policy config.
    throw new Error(`unsupported config value type: ${t}`);
  }
  // Cycle detection — a self-referential candidate/config would
  // otherwise recurse until depth-limit or stack overflow.
  if (state.seen.has(value as object)) {
    throw new Error("cyclic reference in policy input");
  }
  state.seen.add(value as object);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const len = value.length;
    for (let i = 0; i < len; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (desc === undefined) {
        out.push(null); // hole → null (matches JSON.stringify)
        continue;
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new Error(`accessor on array index ${i}`);
      }
      out.push(descriptorCloneInner(desc.value, depth + 1, state));
    }
    state.seen.delete(value as object);
    return out;
  }
  // Reject non-plain prototypes (Date, Map, custom class, Proxy with
  // hostile traps would have already failed the descriptor reads).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("config contains non-plain object");
  }
  const out: Record<string, unknown> = {};
  // `getOwnPropertyNames` (not `Object.keys`) so non-enumerable required
  // fields on the config are preserved into the snapshot. Otherwise a
  // structurally-valid config with `Object.defineProperty(cfg,
  // "allowedKinds", { value: [...], enumerable: false })` would clone
  // to `{}` and crash later in `evaluateChecks`.
  for (const k of Object.getOwnPropertyNames(value as object)) {
    const desc = Object.getOwnPropertyDescriptor(value, k);
    if (desc === undefined) continue;
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new Error(`accessor on key '${k}'`);
    }
    Object.defineProperty(out, k, {
      value: descriptorCloneInner(desc.value, depth + 1, state),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  state.seen.delete(value as object);
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const k of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[k]);
  }
  return Object.freeze(value);
}

interface FailClosedParams {
  readonly reason: string;
  readonly candidateId: string;
  readonly override: PolicyOverride | undefined;
  /** Which input failed snapshot/validation. Recorded as a separate
   *  field on the evaluation so audit consumers can group/filter
   *  failures without parsing the fingerprint. */
  readonly kind: "candidate" | "override" | "config";
  /** Real config fingerprint when the config snapshot already
   *  succeeded (i.e. override-validation failures); else
   *  `UNAVAILABLE_FINGERPRINT`. Kept distinct from `failureReason` so
   *  the policy identity is never overwritten by free-form error text. */
  readonly configFingerprint: string;
}

/**
 * Builds a deterministic fail-closed evaluation when one of the
 * inputs cannot be snapshotted (or override pre-validation rejected
 * a malformed granted override). `configFingerprint` is preserved as
 * the real SHA-256 digest whenever the config was already snapshotted
 * — failure diagnostics live in `failureKind` / `failureReason` so an
 * audit consumer can still join the entry back to the policy version.
 */
function makeFailClosedEvaluation(params: FailClosedParams): PolicyEvaluation {
  const verdict: ForgePolicyVerdict = { decision: "deny", reason: params.reason };
  const override =
    params.override === undefined ? undefined : Object.freeze({ ...params.override });
  const evaluation: PolicyEvaluation = Object.freeze({
    verdict: Object.freeze({ ...verdict }),
    baseVerdict: Object.freeze({ ...verdict }),
    overrideApplied: false,
    override,
    configFingerprint: params.configFingerprint,
    candidateId: params.candidateId,
    failureKind: params.kind,
    failureReason: params.reason,
  });
  AUTHENTIC_EVALUATIONS.add(evaluation);
  return evaluation;
}

function evaluateChecks(
  candidate: ForgeCandidate,
  config: ForgePolicyConfig,
  options: EvaluatePolicyOptions,
): ForgePolicyVerdict {
  // Validate the runtime shape of the snapshotted inputs before any
  // check that would otherwise call `.startsWith`/`.includes` on a
  // non-string — TypeScript types do not survive runtime / cross-process
  // input. Reject missing-or-malformed required fields with a
  // deterministic deny rather than throwing or short-circuiting.
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    return { decision: "deny", reason: "candidate.name must be a non-empty string" };
  }
  if (typeof candidate.kind !== "string" || candidate.kind.length === 0) {
    return { decision: "deny", reason: "candidate.kind must be a non-empty string" };
  }
  if (!Array.isArray(config.allowedKinds) || config.allowedKinds.length === 0) {
    return { decision: "deny", reason: "config.allowedKinds must be a non-empty array" };
  }
  for (const k of config.allowedKinds) {
    if (typeof k !== "string") {
      return { decision: "deny", reason: "config.allowedKinds entries must be strings" };
    }
  }
  if (config.forbiddenNamespaces !== undefined) {
    if (!Array.isArray(config.forbiddenNamespaces)) {
      return {
        decision: "deny",
        reason: "config.forbiddenNamespaces must be an array when defined",
      };
    }
    for (const p of config.forbiddenNamespaces) {
      if (typeof p !== "string") {
        return {
          decision: "deny",
          reason: "config.forbiddenNamespaces entries must be strings",
        };
      }
    }
  }
  // Fail closed on unknown scope values from runtime/deserialized input
  // before any rank comparison runs — otherwise an unrecognized scope
  // would index `SCOPE_RANK` as `undefined` and silently pass both the
  // `>` and `>=` checks below.
  if (!isForgeScope(candidate.proposedScope)) {
    return {
      decision: "deny",
      reason: `unknown proposedScope '${String(candidate.proposedScope)}'`,
    };
  }
  if (!isForgeScope(config.maxScope)) {
    return {
      decision: "deny",
      reason: `unknown config.maxScope '${String(config.maxScope)}'`,
    };
  }
  if (!isForgeScope(config.requireApprovalAtOrAbove)) {
    return {
      decision: "deny",
      reason: `unknown config.requireApprovalAtOrAbove '${String(config.requireApprovalAtOrAbove)}'`,
    };
  }

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
    // Reject malformed maxComplexity values (NaN/Infinity/negative). With
    // NaN, every `score > maxComplexity` comparison is false → the
    // ceiling is silently disabled. With Infinity, the ceiling is
    // effectively removed. Both must fail closed instead.
    if (
      typeof config.maxComplexity !== "number" ||
      !Number.isFinite(config.maxComplexity) ||
      config.maxComplexity < 0
    ) {
      return {
        decision: "deny",
        reason: `config.maxComplexity must be a finite non-negative number, got ${String(config.maxComplexity)}`,
      };
    }
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

function isForgeScope(value: unknown): value is ForgeScope {
  return value === "agent" || value === "zone" || value === "global";
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
  // The validator's per-walk budget is the FIXED structural ceiling —
  // never the operator's `maxComplexity`. The validator charges work
  // bytes that don't always correspond to canonical JSON bytes (e.g.
  // it charges UTF-8 bytes for keys whose values are `undefined`,
  // which canonical JSON omits). Using `maxComplexity` as the
  // validator budget made the policy gate deny small canonical specs
  // based on validator work — a compatibility regression. The actual
  // `maxComplexity` ceiling is enforced separately AFTER
  // canonicalization on the canonical-byte score below. The
  // structural cap still defends against multi-MB hostile inputs
  // forcing cloning/serialization cost before the gate denies.
  const validation = validatePlainSpec(spec, STRUCTURAL_BUDGET_BYTES, "structuralBudgetBytes");
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
    // Reject non-finite numbers (NaN, ±Infinity) outright. JSON.stringify
    // collapses them to `null`, so the byte-length scoring path and a
    // custom-scorer path would disagree about what the spec contains —
    // the policy decision must not depend on values that are not
    // JSON-stable. Fail closed instead.
    const n = value as number;
    if (!Number.isFinite(n)) {
      return { ok: false, reason: "non-finite number is not JSON-safe (NaN/Infinity rejected)" };
    }
    charge(state, String(n).length);
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
