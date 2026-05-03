import type {
  ForgeStageDigest,
  ForgeVerificationSummary,
  KoiError,
  KoiErrorCode,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { StageContext, StageOutcome, VerifierStage, VerifyOptions } from "./types.js";

function stageError(code: KoiErrorCode, stage: string, message: string, cause?: unknown): KoiError {
  return {
    code,
    message,
    retryable: RETRYABLE_DEFAULTS[code],
    context: { stage },
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * Deep-freeze a summary so neither callers nor any cache backend can hand
 * back mutable state. Applied to fresh results before returning AND to every
 * cache hit before it's trusted.
 */
function freezeSummary(summary: ForgeVerificationSummary): ForgeVerificationSummary {
  return Object.freeze({
    passed: summary.passed,
    sandbox: summary.sandbox,
    totalDurationMs: summary.totalDurationMs,
    stageResults: Object.freeze(summary.stageResults.map((d) => Object.freeze({ ...d }))),
  });
}

function fingerprintStages<I>(stages: readonly VerifierStage<I>[]): string {
  // JSON-encode so reserved characters in `name` or `version` cannot collide.
  // `sandboxed` is part of the identity so flipping a stage from non-sandbox
  // to sandbox (without bumping `version`) cannot reuse old non-sandbox
  // cache entries and have them returned as `sandbox: true`.
  return JSON.stringify(stages.map((s) => [s.name, s.version ?? "0", s.sandboxed === true]));
}

function composeCacheKey<I>(
  namespace: string,
  artifactDigest: string,
  stages: readonly VerifierStage<I>[],
): string {
  // JSON-encode each component so neither namespace nor digest can contain a
  // separator that aliases a different (namespace, digest, stages) tuple.
  return JSON.stringify([namespace, artifactDigest, fingerprintStages(stages)]);
}

/**
 * Validate that a cached summary actually corresponds to the current stage
 * list AND trust posture. A corrupted, malicious, or stale cache backend
 * can otherwise return an empty `stageResults` array (or one with the wrong
 * stage names) and the pipeline would skip every check while reporting
 * `passed: true`. Also rejects entries whose stored `sandbox` claim differs
 * from the current static declaration — defense in depth: stage `sandboxed`
 * is already part of the cache key, so a divergence here means the backend
 * is replaying across keys it should never satisfy.
 */
function isCachedSummaryConsistent<I>(
  summary: ForgeVerificationSummary,
  stages: readonly VerifierStage<I>[],
  declaredSandbox: boolean,
): boolean {
  if (summary.passed !== true) return false;
  if (summary.sandbox !== declaredSandbox) return false;
  if (!Array.isArray(summary.stageResults)) return false;
  if (summary.stageResults.length !== stages.length) return false;
  for (let i = 0; i < stages.length; i++) {
    const expected = stages[i];
    const got = summary.stageResults[i];
    if (expected === undefined || got === undefined) return false;
    if (got.stage !== expected.name) return false;
    if (got.passed !== true) return false;
  }
  return true;
}

/**
 * Deterministic JSON of a frozen, validated snapshot. Sorted keys at every
 * level so two structurally-equal artifacts always produce the same string.
 * Throws on cycles — used as the artifact-side cache key, callers without a
 * cycle-tolerant artifact get cache bypass (a correctness-preserving miss),
 * not a false hit. NEVER invokes caller code: by the time we reach here,
 * the snapshot is plain data that was already cloned and frozen.
 */
/**
 * Encode a primitive leaf for the canonical key. JSON.stringify is not
 * injective for JS values: NaN/±Infinity all serialize to "null", -0
 * serializes to "0", and `undefined` yields the literal undefined (which
 * breaks string concatenation). Each ambiguous case gets a sentinel token
 * so two distinct artifacts cannot collide to the same cache key.
 */
function encodePrimitive(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"#NaN"';
    if (value === Number.POSITIVE_INFINITY) return '"#+Infinity"';
    if (value === Number.NEGATIVE_INFINITY) return '"#-Infinity"';
    if (Object.is(value, -0)) return '"#-0"';
    return String(value);
  }
  if (value === undefined) return '"#undefined"';
  if (typeof value === "bigint") return `"#bigint:${value.toString()}"`;
  // string, boolean, null all serialize unambiguously
  return JSON.stringify(value);
}

function canonicalJson(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value !== "object") return encodePrimitive(value);
  if (seen.has(value)) {
    throw new Error("snapshot contains a cycle; cannot derive a deterministic cache key");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, seen)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], seen)}`);
  return `{${parts.join(",")}}`;
}

async function runStage<I>(
  stage: VerifierStage<I>,
  artifact: I,
  ctx: StageContext,
): Promise<{
  readonly outcome: StageOutcome;
  readonly durationMs: number;
  readonly thrown?: unknown;
}> {
  const started = performance.now();
  try {
    const outcome = await stage.run(artifact, ctx);
    return { outcome, durationMs: performance.now() - started };
  } catch (e: unknown) {
    return {
      outcome: { ok: false, reason: "stage threw", cause: e },
      durationMs: performance.now() - started,
      thrown: e,
    };
  }
}

/**
 * Sequential verification orchestrator.
 *
 * Runs each stage in order, recording its `ForgeStageDigest`. Stops at the
 * first `{ ok: false }` outcome and returns a `KoiError` carrying the
 * failing stage name. On full success, optionally caches the resulting
 * `ForgeVerificationSummary` keyed by `options.cacheKey` composed with a
 * stage-list fingerprint. A cache hit skips all stages.
 *
 * Cache writes are best-effort: a `cache.set` failure does not turn a
 * successful verification into a rejection. Cache reads, in contrast,
 * propagate (a read failure means we cannot prove the cache is empty, so
 * we must not silently re-run and risk a duplicate side effect from
 * stages — callers that want different semantics can wrap the cache).
 */
export async function runPipeline<I>(
  stages: readonly VerifierStage<I>[],
  artifact: I,
  options?: VerifyOptions,
): Promise<Result<ForgeVerificationSummary>> {
  // Fail closed: a misconfigured caller, feature flag, or assembly bug
  // must NOT silently turn "no verifier configured" into "artifact passed".
  if (stages.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message: "runPipeline requires at least one stage; refusing to fail-open.",
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
      },
    };
  }

  const namespace = options?.namespace ?? "";
  const cache = options?.cache;
  const signal = options?.signal;

  // Snapshot the artifact via structuredClone before BOTH fingerprinting
  // AND running stages. This binds the cache key, the verification work,
  // and the cached pass result to the same immutable bytes — a stage
  // cannot mutate nested artifact content after the fingerprint is
  // computed and cause a later run to receive a cached pass for content
  // it never verified. structuredClone handles Date, Map, Set, typed
  // arrays, etc.; functions and class instances are out of scope and
  // will throw — surface that as INVALID_CONFIG.
  // Bound the pre-stage work by an aborted signal too — validation +
  // structuredClone of a large or malicious artifact must not consume CPU
  // after the caller has given up.
  if (signal?.aborted) {
    return {
      ok: false,
      error: stageError("TIMEOUT", "<snapshot>", "Pipeline aborted before snapshot."),
    };
  }
  let snapshot: I;
  try {
    // Reject anything that is not a primitive or a plain-data object root.
    if (artifact === null || typeof artifact !== "object") {
      const t = typeof artifact;
      if (t !== "string" && t !== "number" && t !== "boolean" && t !== "undefined") {
        throw new TypeError(
          `Artifact root has unsupported type "${t}"; verifier requires plain-data artifacts.`,
        );
      }
      snapshot = artifact;
    } else {
      // Pre-clone validation walks the ORIGINAL artifact graph using only
      // descriptor reads — no value-getter invocation, no Object.entries.
      // Catches hidden state (symbol keys, non-enumerable, accessors) that
      // structuredClone would silently drop, AND class instances whose
      // prototype clone would strip. For Proxy-wrapped artifacts, the
      // ownKeys/getOwnPropertyDescriptor traps may fire — bounded by the
      // graph size and never deeper than data descriptors carry (data
      // descriptors hold .value eagerly, so no caller getter is invoked
      // by the walk). Same Proxy-trap exposure surface as structuredClone
      // itself — we accept it once here in exchange for catching attacks
      // that would otherwise be invisible to every stage.
      rejectUnsupportedShape(artifact, "$", new WeakSet<object>());
      // Clone — runs in V8 internals on a graph we already proved to be
      // pure data. Symbol/non-enumerable rejection above means clone cannot
      // silently elide caller state: the snapshot is bit-equivalent to
      // every observable own data property of the original.
      let cloned: I;
      try {
        cloned = structuredClone(artifact);
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : "non-cloneable artifact";
        throw new TypeError(`Artifact is not structured-cloneable: ${detail}`);
      }
      snapshot = cloned;
      deepFreeze(snapshot);
    }
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : "non-cloneable artifact";
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message: detail,
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
        cause: e,
      },
    };
  }
  // Sandbox is derived from the static stage declarations, never from
  // arbitrary stage runtime self-reports — same source on fresh runs and
  // cache hits, so the trust signal cannot diverge across cache state.
  const declaredSandbox = stages.some((s) => s.sandboxed === true);

  let composedKey: string | undefined;
  if (cache !== undefined) {
    try {
      // Derive the artifact-side digest INTERNALLY from the validated frozen
      // snapshot. No caller callback runs on the verifier stack — earlier
      // designs accepted an `artifactFingerprint` function, but invoking
      // caller code in the trusted verification path negates the point of
      // the snapshot boundary. canonicalJson is sorted-keys + cycle-rejecting,
      // so two structurally-equal artifacts always produce the same key and
      // a cyclic snapshot bypasses caching rather than aliasing.
      const digest = canonicalJson(snapshot, new WeakSet<object>());
      composedKey = composeCacheKey(namespace, digest, stages);
    } catch (e: unknown) {
      // Cyclic snapshot (or other digest failure) — bypass caching for this
      // run. A correctness-preserving miss is strictly better than a hit
      // bound to a non-deterministic key. Operators can correlate via debug.
      console.debug("[forge-verifier] cache bypassed (snapshot not cacheable):", e);
      composedKey = undefined;
    }
  }

  if (composedKey !== undefined && cache !== undefined) {
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError("TIMEOUT", "<cache>", "Pipeline aborted before cache lookup."),
      };
    }
    let hit: Awaited<ReturnType<typeof cache.get>>;
    try {
      hit = await cache.get(composedKey);
    } catch (e: unknown) {
      // Cache READS map to a typed Result. The advertised contract is
      // exception-free; a backend outage during read is a stage-attributable
      // INTERNAL error, not an unhandled rejection that crashes the caller.
      // Reads are NOT silently swallowed (unlike writes): a read failure
      // means we cannot prove the cache is empty, so re-running stages
      // could double-execute side effects. Surface and let the caller
      // decide.
      const detail = e instanceof Error ? e.message : "cache.get threw";
      return {
        ok: false,
        error: stageError("INTERNAL", "<cache>", `Cache read failed: ${detail}`, e),
      };
    }
    // Re-check after the await — a remote cache.get can take real time and
    // a caller that aborted during the read must not receive a cached pass
    // they explicitly gave up on.
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError("TIMEOUT", "<cache>", "Pipeline aborted during cache lookup."),
      };
    }
    // Bind the returned envelope to the key we asked for. A backend that
    // ignores its key parameter, leaks across tenants, or replays a stale
    // entry under a different key would otherwise be trusted as a hit. The
    // envelope check + structural check together require the backend to
    // round-trip the exact (key, summary) we wrote.
    if (
      hit !== undefined &&
      typeof hit === "object" &&
      hit !== null &&
      hit.key === composedKey &&
      isCachedSummaryConsistent(hit.summary, stages, declaredSandbox)
    ) {
      return {
        ok: true,
        value: freezeSummary({
          passed: hit.summary.passed,
          sandbox: declaredSandbox,
          totalDurationMs: hit.summary.totalDurationMs,
          stageResults: hit.summary.stageResults,
        }),
      };
    }
    // Inconsistent, malformed, or wrong-key hit — treat as a miss and re-verify.
  }

  // let justified: digests accumulates immutably-replaced array as stages run.
  let digests: readonly ForgeStageDigest[] = [];
  let totalDurationMs = 0;

  for (const stage of stages) {
    if (signal?.aborted === true) {
      return {
        ok: false,
        error: stageError("TIMEOUT", stage.name, `Pipeline aborted before stage "${stage.name}"`),
      };
    }

    // `previous` is documented as read-only, but the readonly modifier is a
    // compile-time fiction. A buggy or hostile stage could otherwise cast
    // it away and rewrite the recorded verification trail. Expose a frozen
    // shallow copy whose elements are themselves frozen.
    const ctx: StageContext = {
      previous: Object.freeze(digests.map((d) => Object.freeze({ ...d }))),
      ...(signal !== undefined ? { signal } : {}),
    };
    const { outcome, durationMs, thrown } = await runStage(stage, snapshot, ctx);
    totalDurationMs += durationMs;

    if (!outcome.ok) {
      const code: KoiErrorCode = thrown !== undefined ? "INTERNAL" : "VALIDATION";
      const message =
        thrown !== undefined
          ? `Stage "${stage.name}" threw: ${describeThrown(thrown)}`
          : `Stage "${stage.name}" failed: ${outcome.reason}`;
      return {
        ok: false,
        error: stageError(code, stage.name, message, outcome.cause),
      };
    }

    // Validate that an EXPLICIT runtime self-report agrees with the static
    // declaration. Omitted `outcome.sandboxed` means "no override" — the
    // declaration stands. This matches the API where `sandboxed` is
    // optional on `StageOutcome`. Only an explicit, conflicting value
    // (e.g. declared sandboxed:true but returned sandboxed:false) fails.
    if (outcome.sandboxed !== undefined && outcome.sandboxed !== (stage.sandboxed === true)) {
      return {
        ok: false,
        error: stageError(
          "INVALID_CONFIG",
          stage.name,
          `Stage "${stage.name}" runtime sandboxed=${outcome.sandboxed} explicitly disagrees with static sandboxed=${stage.sandboxed === true}.`,
        ),
      };
    }

    digests = [...digests, { stage: stage.name, passed: true, durationMs }];

    // Re-check abort *after* every stage (including the last) and *before*
    // returning success. A long-running stage that finishes after the signal
    // fires must not be allowed to commit a pass result the caller has
    // already given up on. (`signal.aborted` is mutable; TS narrows on the
    // entry check above so we read it through the maybe-undefined wrapper.)
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError(
          "TIMEOUT",
          stage.name,
          `Pipeline aborted during or after stage "${stage.name}"`,
        ),
      };
    }
  }

  // Freeze before either returning or caching so a caller-mutated summary
  // cannot poison the cache and a stage cannot rewrite the trail through a
  // retained reference.
  const summary = freezeSummary({
    passed: true,
    sandbox: declaredSandbox,
    totalDurationMs,
    stageResults: digests,
  });

  if (composedKey !== undefined && cache !== undefined) {
    try {
      await cache.set(composedKey, { key: composedKey, summary });
    } catch (e: unknown) {
      // Cache writes are best-effort. A backend outage must not flip a
      // successful verification into a rejection. Surface via console.debug
      // so operators can correlate; the next run will simply repopulate.
      console.debug("[forge-verifier] cache.set failed (ignored):", e);
    }
  }

  return { ok: true, value: summary };
}

/**
 * Reject artifacts that contain types whose mutability cannot be enforced by
 * `Object.freeze`, or whose snapshot would silently differ from the original.
 *
 * - Typed arrays / DataView / ArrayBuffer: `Object.freeze` throws on populated
 *   typed arrays in V8, and a frozen typed array's underlying buffer is still
 *   mutable. We do not support binary blobs in the artifact graph yet.
 * - `Map` / `Set`: `Object.freeze` does NOT block `.set` / `.add` / `.delete`,
 *   so a frozen collection is still mutable at the API surface. Reject
 *   instead of pretending it's immutable.
 * - Class instances (non-plain objects): `structuredClone` silently strips the
 *   prototype, so stages would receive a plain-object that is not equal to
 *   what the caller passed in and the cached pass would attest to a different
 *   shape than the input.
 */
function rejectUnsupportedShape(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") {
    // Functions and symbols nested inside a graph are also rejected here
    // (typeof "object" excludes them). structuredClone would throw, but
    // catching it here gives a much better path-rooted error message.
    if (typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(
        `Artifact at ${path} has unsupported type "${typeof value}"; verifier requires plain-data artifacts.`,
      );
    }
    return;
  }
  // Cycle guard: a self-referential plain object is legal for
  // `structuredClone`, but unbounded recursion here would let a crafted
  // artifact knock the verifier over. Validate each object exactly once.
  if (seen.has(value)) return;
  seen.add(value);
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set
  ) {
    throw new TypeError(
      `Artifact at ${path} contains ${value.constructor.name}; verifier requires plain-data artifacts (Map/Set/typed-array unsupported).`,
    );
  }
  if (Array.isArray(value)) {
    // Use descriptor walk for ALL own keys, including numeric indices, so a
    // hostile array with `Object.defineProperty(arr, "0", { get() { ... } })`
    // is rejected without firing the getter. Also rejects symbol keys,
    // accessors, non-enumerable, and extra named props.
    const arrSymbols = Object.getOwnPropertySymbols(value);
    if (arrSymbols.length > 0) {
      throw new TypeError(
        `Artifact at ${path} (array) has symbol-keyed own properties; verifier requires plain-data artifacts.`,
      );
    }
    const arrDescs = Object.getOwnPropertyDescriptors(value);
    for (const [k, desc] of Object.entries(arrDescs)) {
      if (k === "length") continue;
      if (typeof desc.get === "function" || typeof desc.set === "function") {
        throw new TypeError(
          `Artifact at ${path}.${k} (array property) is an accessor (getter/setter); verifier rejects accessors so caller code never executes during validation.`,
        );
      }
      if (desc.enumerable !== true) {
        throw new TypeError(
          `Artifact at ${path}.${k} (array property) is non-enumerable; verifier requires plain-data artifacts.`,
        );
      }
      if (!/^\d+$/.test(k)) {
        // Extra named properties on arrays are not preserved by
        // structuredClone, so reject rather than silently drop.
        throw new TypeError(
          `Artifact at ${path}.${k} (array property) is a non-index own property; verifier requires plain-data arrays (extra named properties are not preserved by structuredClone).`,
        );
      }
      rejectUnsupportedShape(desc.value, `${path}[${k}]`, seen);
    }
    return;
  }
  // Non-plain object (class instance, etc.): structuredClone strips the
  // prototype. Reject so the cached pass cannot attest to a different shape
  // than what the caller actually passed in.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `Artifact at ${path} is a non-plain object (${proto.constructor.name}); verifier requires plain-data artifacts.`,
    );
  }
  // Reject any symbol-keyed own properties — structuredClone drops them, so
  // they would never appear in the snapshot, the cache key, or what stages
  // see, even though the caller's artifact carries them.
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new TypeError(
      `Artifact at ${path} has symbol-keyed own properties; verifier requires plain-data artifacts (symbol keys are not preserved by structuredClone).`,
    );
  }
  // Use descriptor walk (NOT Object.entries) so getters are NOT invoked
  // during validation. Reject accessors and non-enumerable own properties
  // outright — both would either execute caller code on the verifier's
  // call stack or be silently dropped from the snapshot.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [k, desc] of Object.entries(descriptors)) {
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      throw new TypeError(
        `Artifact at ${path}.${k} is an accessor (getter/setter); verifier rejects accessors so caller code never executes during validation.`,
      );
    }
    if (desc.enumerable !== true) {
      throw new TypeError(
        `Artifact at ${path}.${k} is non-enumerable; verifier requires plain-data artifacts (non-enumerable properties are not preserved by structuredClone).`,
      );
    }
    rejectUnsupportedShape(desc.value, `${path}.${k}`, seen);
  }
}

/**
 * Recursively freeze plain objects and arrays. Map/Set/typed arrays are
 * rejected upstream by `rejectUnsupportedShape`, so we never reach them here.
 * Already-frozen substructures are skipped to avoid redundant work.
 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return;
  }
  for (const v of Object.values(value)) deepFreeze(v);
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === "string") return thrown;
  return "non-Error throw";
}
