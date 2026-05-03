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
 * list. A corrupted, malicious, or stale cache backend can otherwise return
 * an empty `stageResults` array (or one with the wrong stage names) and the
 * pipeline would skip every check while reporting `passed: true`.
 */
function isCachedSummaryConsistent<I>(
  summary: ForgeVerificationSummary,
  stages: readonly VerifierStage<I>[],
): boolean {
  if (summary.passed !== true) return false;
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
  options?: VerifyOptions<I>,
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

  const fingerprint = options?.artifactFingerprint;
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
      // Descriptor-based validation runs FIRST: it never invokes accessors,
      // never reads array indices via `[i]`, and never traps a Proxy via
      // value access. (Reflective ops like Object.getOwnPropertyDescriptors
      // and getPrototypeOf still pass through Proxy traps, but they cannot
      // run arbitrary computation on declared-data fields without being
      // detected as accessors and rejected.) Then structuredClone produces
      // the trusted snapshot, and the snapshot is deep-frozen.
      rejectUnsupportedShape(artifact, "$", new WeakSet<object>());
      snapshot = structuredClone(artifact);
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
  if (fingerprint !== undefined && cache !== undefined) {
    try {
      composedKey = composeCacheKey(namespace, fingerprint(snapshot), stages);
    } catch (e: unknown) {
      // A throwing fingerprint function is a caller bug, but it must stay
      // inside the Result envelope — the public contract is exception-free.
      const detail = e instanceof Error ? e.message : "fingerprint threw";
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: `artifactFingerprint threw: ${detail}`,
          retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
          cause: e,
        },
      };
    }
  }

  if (composedKey !== undefined && cache !== undefined) {
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError("TIMEOUT", "<cache>", "Pipeline aborted before cache lookup."),
      };
    }
    const hit = await cache.get(composedKey);
    // Re-check after the await — a remote cache.get can take real time and
    // a caller that aborted during the read must not receive a cached pass
    // they explicitly gave up on.
    if (signal?.aborted) {
      return {
        ok: false,
        error: stageError("TIMEOUT", "<cache>", "Pipeline aborted during cache lookup."),
      };
    }
    if (hit !== undefined && isCachedSummaryConsistent(hit, stages)) {
      return {
        ok: true,
        value: freezeSummary({
          passed: hit.passed,
          sandbox: declaredSandbox,
          totalDurationMs: hit.totalDurationMs,
          stageResults: hit.stageResults,
        }),
      };
    }
    // Inconsistent or malformed hit — treat as a miss and re-verify.
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

    // Validate that the stage's runtime self-report agrees with its static
    // declaration. A stage that returns sandboxed:true without declaring
    // sandboxed:true (or vice versa) makes the cached/fresh sandbox values
    // diverge — fail closed at config boundary instead.
    if ((outcome.sandboxed ?? false) !== (stage.sandboxed ?? false)) {
      return {
        ok: false,
        error: stageError(
          "INVALID_CONFIG",
          stage.name,
          `Stage "${stage.name}" runtime sandboxed=${outcome.sandboxed === true} disagrees with static sandboxed=${stage.sandboxed === true}.`,
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
      await cache.set(composedKey, summary);
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
