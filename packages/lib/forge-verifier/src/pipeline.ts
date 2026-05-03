import { types } from "node:util";
import type {
  ForgeStageDigest,
  ForgeVerificationSummary,
  KoiError,
  KoiErrorCode,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { StageContext, StageOutcome, VerifierStage, VerifyOptions } from "./types.js";

/**
 * Process-local single-flight registry. Two `runPipeline` callers that
 * compute the same `composedKey` concurrently both miss in cache.get,
 * both run the full stage pipeline, then race to write the same key.
 * For pure stages this is wasted CPU; for the explicitly-supported
 * non-idempotent stages (sandbox jobs, external APIs, quota-bearing
 * checks), it is duplicated irreversible work.
 *
 * Coalescing here means the FIRST caller's pipeline runs, and any
 * concurrent caller with the same key awaits its result. Followers
 * inherit the leader's success/failure verbatim — including any
 * leader-side abort. A follower's own AbortSignal cannot interrupt
 * the leader (cooperative cancellation is per-pipeline, not per-key).
 *
 * Process-local only: cross-process deduplication requires backend
 * cooperation (e.g. a Redis SET NX), out of scope here.
 */
const inflight = new Map<string, Promise<Result<ForgeVerificationSummary>>>();

/**
 * Per-cache-instance identity for the single-flight key. Two callers
 * coalescing on the same composedKey but DIFFERENT cache backends or
 * DIFFERENT cacheReadFailure policies must not share a leader: a caller
 * with a trusted cache could otherwise inherit a forged pass from a
 * caller with an untrusted cache, and a `"fail"` caller could be dragged
 * into a `"miss"` leader's silent re-execution after a backend outage.
 *
 * Identity uses a `WeakMap` so cache instances that go out of scope do
 * not retain memory; it is per-process and never crosses workers.
 */
const cacheIdentity = new WeakMap<object, string>();
let cacheIdSeq = 0;
function cacheId(cache: object): string {
  const existing = cacheIdentity.get(cache);
  if (existing !== undefined) return existing;
  const id = `c${++cacheIdSeq}`;
  cacheIdentity.set(cache, id);
  return id;
}

/**
 * Race an in-flight leader promise against this caller's own AbortSignal.
 * If the signal fires first, return TIMEOUT to THIS caller — the leader
 * keeps running for other followers. If the leader resolves first, return
 * its result verbatim. Either way, no cross-caller leakage.
 */
async function waitWithSignal(
  leader: Promise<Result<ForgeVerificationSummary>>,
  signal: AbortSignal,
): Promise<Result<ForgeVerificationSummary>> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "Caller aborted while awaiting in-flight verification.",
        retryable: RETRYABLE_DEFAULTS.TIMEOUT,
        context: { stage: "<inflight>" },
      },
    };
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "Caller aborted while awaiting in-flight verification.",
          retryable: RETRYABLE_DEFAULTS.TIMEOUT,
          context: { stage: "<inflight>" },
        },
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    leader.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // Leader threw (should be unreachable — work() always returns Result),
        // but defensively map to INTERNAL inside the envelope rather than
        // letting the rejection propagate.
        const detail = err instanceof Error ? err.message : "in-flight verification threw";
        resolve({
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Leader pipeline threw: ${detail}`,
            retryable: RETRYABLE_DEFAULTS.INTERNAL,
            context: { stage: "<inflight>" },
            cause: err,
          },
        });
      },
    );
  });
}

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
function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isCachedSummaryConsistent<I>(
  summary: unknown,
  stages: readonly VerifierStage<I>[],
  declaredSandbox: boolean,
): summary is ForgeVerificationSummary {
  // Cache backends are explicitly pluggable and may be remote — one
  // corrupted row, buggy adapter, or cross-version payload must not throw
  // a TypeError out of `runPipeline` or pass through values that downstream
  // consumers (e.g. `createForgeProvenance`) reject. Validate every field
  // including duration shape — NaN/Infinity in a cached row would surface
  // as a persistence failure later, far from this boundary.
  if (summary === null || typeof summary !== "object") return false;
  const s = summary as Record<string, unknown>;
  if (s.passed !== true) return false;
  if (s.sandbox !== declaredSandbox) return false;
  if (!isFiniteNonNegative(s.totalDurationMs)) return false;
  if (!Array.isArray(s.stageResults)) return false;
  if (s.stageResults.length !== stages.length) return false;
  for (let i = 0; i < stages.length; i++) {
    const expected = stages[i];
    const got = s.stageResults[i];
    if (expected === undefined || got === null || typeof got !== "object") return false;
    const d = got as Record<string, unknown>;
    if (d.stage !== expected.name) return false;
    if (d.passed !== true) return false;
    if (!isFiniteNonNegative(d.durationMs)) return false;
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
 * injective for JS values:
 *   - NaN / ±Infinity all serialize to "null"
 *   - -0 serializes to "0"
 *   - undefined yields literal undefined (string-concat hazard)
 *   - bigint throws
 *
 * Bare-string sentinels like `"#NaN"` would collide with user strings of
 * the same content. Every leaf instead gets a TYPE TAG prefix unique to
 * its JS type — `s:`, `f:`, `b:`, `n:`, `u:`, `g:` — so the encoded
 * string for a value of one type can never equal the encoded string for
 * a value of any other type. Arrays/objects retain their `[`/`{` prefix
 * and never start with a tag, so they are distinguishable too.
 */
function encodePrimitive(value: unknown): string {
  if (value === null) return "n:";
  if (value === undefined) return "u:";
  if (typeof value === "boolean") return value ? "b:t" : "b:f";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "f:NaN";
    if (value === Number.POSITIVE_INFINITY) return "f:+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "f:-Inf";
    if (Object.is(value, -0)) return "f:-0";
    return `f:${value}`;
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "bigint") return `g:${value.toString()}`;
  // Symbols/functions cannot reach here — rejectUnsupportedShape rejects
  // them upstream — but keep a defensive tag rather than fall through.
  return `?:${JSON.stringify(String(value))}`;
}

/**
 * Hard caps on artifact graph traversal. Both `rejectUnsupportedShape`
 * and `canonicalJson` recurse synchronously over attacker-controlled
 * input; an abort signal cannot interrupt synchronous JS, so the only
 * way to bound preprocessing CPU under cancellation pressure is to bound
 * the input itself.
 *
 *   - DEPTH (256): catches stack-blowing inputs; safely below V8's default
 *     call-stack limit while exceeding any realistic config artifact.
 *   - NODES (50_000): catches wide flat inputs (e.g. an array/object with
 *     1M entries) that the depth cap alone cannot stop. Counts every
 *     visited primitive AND every container so the bound is total work,
 *     not just leaf work.
 */
const MAX_ARTIFACT_DEPTH = 256;
const MAX_ARTIFACT_NODES = 50_000;

interface NodeBudget {
  count: number;
}

interface CanonicalState {
  readonly onStack: WeakSet<object>;
  readonly seen: WeakMap<object, number>;
  readonly budget: NodeBudget;
  refCounter: number;
}

/**
 * Topology-aware canonical serializer. Tracks two things:
 *
 *   - `onStack`: ancestors of the current node — a re-entry is a TRUE
 *     cycle and throws (no deterministic linearization exists).
 *   - `seen`: every previously-visited object → integer ID. Re-encountering
 *     a shared subobject (DAG aliasing) emits `ref:N` instead of recursing.
 *     This makes shared-reference DAGs cacheable AND distinct from
 *     identical-content non-shared graphs: stages observe reference
 *     identity (`a.x === a.y`), so the cached pass is bound to topology.
 */
function canonicalJson(value: unknown, state: CanonicalState, depth = 0): string {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new Error(`snapshot exceeds maximum depth (${MAX_ARTIFACT_DEPTH})`);
  }
  state.budget.count += 1;
  if (state.budget.count > MAX_ARTIFACT_NODES) {
    throw new Error(`snapshot exceeds maximum node count (${MAX_ARTIFACT_NODES})`);
  }
  if (value === null || typeof value !== "object") return encodePrimitive(value);
  if (state.onStack.has(value)) {
    // Tagged so callers can distinguish "expected: cyclic snapshot" from
    // serializer bugs / future regressions and decide bypass-vs-fail.
    const err = new Error("snapshot contains a cycle; cannot derive a deterministic cache key");
    (err as Error & { code?: string }).code = "FORGE_VERIFIER_CYCLE";
    throw err;
  }
  // Topology-aware aliasing: a node reached via a non-back-edge that we've
  // already serialized once gets a stable reference ID. Different DAG
  // topologies produce different keys; identical-content non-shared graphs
  // never collide with shared-reference graphs.
  const priorId = state.seen.get(value);
  if (priorId !== undefined) {
    return `ref:${priorId}`;
  }
  const id = state.refCounter++;
  state.seen.set(value, id);
  state.onStack.add(value);
  try {
    if (Array.isArray(value)) {
      // Iterate 0..length-1 explicitly so a sparse array (`new Array(1)`)
      // does NOT serialize equal to `[]`. `Array.prototype.map` skips holes,
      // which would alias different artifact shapes to the same cache key.
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        parts.push(canonicalJson(value[i], state, depth + 1));
      }
      return `#${id}[${parts.join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], state, depth + 1)}`,
    );
    return `#${id}{${parts.join(",")}}`;
  } finally {
    state.onStack.delete(value);
  }
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

  // Validate stage descriptors up front: name must be a non-empty string,
  // and names must be unique. Without this, an empty-name stage would
  // produce a summary that downstream consumers (e.g. `createForgeProvenance`)
  // refuse to persist — surfacing the misconfiguration far from its source.
  // Duplicate names break cache-key uniqueness AND make stageResults
  // ambiguous for callers correlating digests by name.
  const seenNames = new Set<string>();
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (s === undefined || typeof s.name !== "string" || s.name.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: `Stage at index ${i} has invalid name (must be a non-empty string).`,
          retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
        },
      };
    }
    if (seenNames.has(s.name)) {
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: `Duplicate stage name "${s.name}" at index ${i}; stage names must be unique.`,
          retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
        },
      };
    }
    seenNames.add(s.name);
  }

  const namespace = options?.namespace;
  const cache = options?.cache;
  const cacheReadFailure = options?.cacheReadFailure ?? "fail";
  const signal = options?.signal;

  // When caching is enabled, every stage MUST declare an explicit non-empty
  // `version`. Two different plugin implementations sharing the same
  // (name, sandboxed) tuple but defaulting `version` to `"0"` would alias
  // each other in cache + single-flight slots — one plugin's pass could
  // satisfy another plugin's stage without its logic ever running. Without
  // a cache (solo runs) version is irrelevant: no result is persisted or
  // shared, so the fingerprint never matters.
  if (cache !== undefined) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (s === undefined) continue;
      if (typeof s.version !== "string" || s.version.length === 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_CONFIG",
            message: `Stage "${s.name}" at index ${i} requires an explicit non-empty \`version\` when cache is provided; stage identity must distinguish plugin implementations.`,
            retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
          },
        };
      }
    }
  }

  // Fail closed against silent cross-tenant replay: a shared cache backend
  // with two callers that both forget to set `namespace` would happily serve
  // each other's attestations whenever artifact content + stage metadata
  // match. Require an explicit non-empty namespace whenever a cache is
  // provided. Callers that do not need partitioning can pass any constant.
  if (cache !== undefined && (typeof namespace !== "string" || namespace.length === 0)) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message:
          "VerifyOptions.namespace is required (non-empty string) when cache is provided; defaulting to '' would replay attestations across callers sharing the backend.",
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
      },
    };
  }

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
      rejectUnsupportedShape(artifact, "$", new WeakSet<object>(), { count: 0 });
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
      const digest = canonicalJson(snapshot, {
        onStack: new WeakSet<object>(),
        seen: new WeakMap<object, number>(),
        budget: { count: 0 },
        refCounter: 0,
      });
      if (typeof namespace !== "string") {
        // Unreachable: validated above when cache !== undefined. Defensive
        // guard for the type narrow rather than an `as` cast.
        throw new Error("namespace must be a string when cache is provided");
      }
      composedKey = composeCacheKey(namespace, digest, stages);
    } catch (e: unknown) {
      // Only the EXPECTED cycle case bypasses caching (cyclic artifacts
      // have no deterministic linearization, so a miss + re-verify is the
      // correctness-preserving outcome). Any other digest/key-derivation
      // error indicates a serializer bug or future regression — surface as
      // INTERNAL so callers don't unknowingly re-execute side-effectful
      // stages on a cache disabled by an opaque encoder failure.
      const code = (e as { code?: string } | undefined)?.code;
      if (code === "FORGE_VERIFIER_CYCLE") {
        console.debug("[forge-verifier] cache bypassed (cyclic snapshot):", e);
        composedKey = undefined;
      } else {
        const detail = e instanceof Error ? e.message : "cache key derivation failed";
        return {
          ok: false,
          error: stageError("INTERNAL", "<cache>", `Cache key derivation failed: ${detail}`, e),
        };
      }
    }
  }

  // Single-flight coalescing: if another caller is already verifying the
  // same composedKey in this process, share its work instead of running
  // a duplicate pipeline. Crucially registered BEFORE cache.get + stages
  // so concurrent callers cannot all miss + all run.
  //
  // Cancellation is per-WAITER, not per-key:
  //   - The shared leader pipeline runs WITHOUT any caller's signal, so
  //     no single caller can abort the side effects another caller is
  //     awaiting. Stages run to completion (or in-stage failure).
  //   - Every caller — leader and follower alike — races the shared
  //     promise against its OWN signal via `waitWithSignal`. A caller's
  //     abort returns TIMEOUT to that caller without affecting any other
  //     caller or the leader pipeline itself.
  //   - This trades per-caller cooperative cancellation of stages for
  //     freedom from leader-imposed cancellation. Acceptable because the
  //     non-idempotent stages this pipeline is designed for must not be
  //     interrupted mid-flight by an unrelated caller anyway.
  // Single-flight key includes cache backend identity AND cacheReadFailure
  // policy so two callers coalesce only when they would observe the same
  // result. A trusted-cache caller MUST NOT inherit a forged pass from an
  // untrusted-cache caller, and a `"fail"` caller MUST NOT be dragged into
  // a `"miss"` leader's silent re-execution after a backend outage.
  const inflightKey =
    composedKey !== undefined && cache !== undefined
      ? `${cacheId(cache)}|${cacheReadFailure}|${composedKey}`
      : undefined;

  if (inflightKey !== undefined) {
    const existing = inflight.get(inflightKey);
    if (existing !== undefined) {
      if (signal === undefined) return existing;
      return waitWithSignal(existing, signal);
    }
  }

  // `pipelineSignal` is the signal the stage loop honors. For coalesced
  // (inflightKey-bearing) runs it is `undefined` so the shared pipeline
  // never aborts on one caller's behalf; the caller's own cancellation
  // is enforced at the outer `waitWithSignal` race below. For solo runs
  // (no cache, or no eligible inflight key) it is the caller's own
  // signal — no one else can be awaiting this pipeline.
  const pipelineSignal: AbortSignal | undefined = inflightKey !== undefined ? undefined : signal;

  const work = async (): Promise<Result<ForgeVerificationSummary>> => {
    if (composedKey !== undefined && cache !== undefined) {
      if (pipelineSignal?.aborted) {
        return {
          ok: false,
          error: stageError("TIMEOUT", "<cache>", "Pipeline aborted before cache lookup."),
        };
      }
      let hit: Awaited<ReturnType<typeof cache.get>>;
      try {
        hit = await cache.get(composedKey);
      } catch (e: unknown) {
        // Cache read failure handling is policy: "miss" (default) treats the
        // outage as a cache miss and re-runs stages, so a degraded backend
        // cannot block all verification. "fail" returns INTERNAL inside the
        // Result envelope — appropriate when stages have non-idempotent side
        // effects and silent re-execution must be avoided. Either way, the
        // exception never escapes the documented Promise<Result<...>> contract.
        const detail = e instanceof Error ? e.message : "cache.get threw";
        if (cacheReadFailure === "fail") {
          return {
            ok: false,
            error: stageError("INTERNAL", "<cache>", `Cache read failed: ${detail}`, e),
          };
        }
        console.debug("[forge-verifier] cache.get failed, treating as miss:", e);
        hit = undefined;
      }
      if (pipelineSignal?.aborted) {
        return {
          ok: false,
          error: stageError("TIMEOUT", "<cache>", "Pipeline aborted during cache lookup."),
        };
      }
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
    }

    // let justified: digests accumulates immutably-replaced array as stages run.
    let digests: readonly ForgeStageDigest[] = [];
    let totalDurationMs = 0;

    for (const stage of stages) {
      if (pipelineSignal?.aborted === true) {
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
        ...(pipelineSignal !== undefined ? { signal: pipelineSignal } : {}),
      };
      const { outcome, durationMs, thrown } = await runStage(stage, snapshot, ctx);
      totalDurationMs += durationMs;

      // Validate the resolved outcome shape BEFORE any property destructure.
      // `VerifierStage` is a plugin boundary; a buggy implementation that
      // returns null/undefined/{} or a non-boolean `ok` must surface as a
      // typed Result error inside the envelope, not a TypeError that escapes
      // the documented `Promise<Result<...>>` contract.
      if (
        thrown === undefined &&
        (outcome === null || typeof outcome !== "object" || typeof outcome.ok !== "boolean")
      ) {
        return {
          ok: false,
          error: stageError(
            "INTERNAL",
            stage.name,
            `Stage "${stage.name}" returned a malformed outcome (expected { ok: boolean, ... }).`,
          ),
        };
      }

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

      if (outcome.sandboxed !== undefined && typeof outcome.sandboxed !== "boolean") {
        return {
          ok: false,
          error: stageError(
            "INTERNAL",
            stage.name,
            `Stage "${stage.name}" returned a non-boolean sandboxed value.`,
          ),
        };
      }
      // `sandboxed: true` is an attestation contract: a stage that declares
      // it MUST runtime-confirm by returning `outcome.sandboxed === true`.
      // Omission or `false` means the run did NOT enter the sandbox — the
      // trust bit cannot be set on metadata alone, otherwise a buggy or
      // malicious stage could silently skip isolation while downstream code
      // sees a sandbox-attested verification.
      if (stage.sandboxed === true && outcome.sandboxed !== true) {
        return {
          ok: false,
          error: stageError(
            "INVALID_CONFIG",
            stage.name,
            `Stage "${stage.name}" declares sandboxed=true but did not return outcome.sandboxed=true; runtime confirmation is required for sandbox attestation.`,
          ),
        };
      }
      // Inverse: a stage NOT statically sandboxed must not claim it ran
      // sandboxed — the cache key did not include the sandbox bit, so a
      // later identical stage list would alias to this run's pass.
      if (stage.sandboxed !== true && outcome.sandboxed === true) {
        return {
          ok: false,
          error: stageError(
            "INVALID_CONFIG",
            stage.name,
            `Stage "${stage.name}" returned sandboxed=true but is not statically declared sandboxed.`,
          ),
        };
      }

      digests = [...digests, { stage: stage.name, passed: true, durationMs }];

      // No post-stage abort check on purpose: if a stage already produced a
      // side effect (sandbox job, external API call, quota burn) and then
      // aborted, discarding the success and returning TIMEOUT would force
      // the caller to retry the same irreversible work. The pre-check at the
      // top of the next iteration still catches signals fired between
      // stages — pipeline ABORTS BEFORE starting un-run work, but COMMITS
      // work that already happened.
    }

    // Final abort gate: if the caller aborted while the LAST stage was in
    // flight, do not commit a passing summary or write it to cache. The
    // stage's side effect (if any) has already happened; discarding the
    // attestation is the safe asymmetry — a future run can re-attest, but
    // a cached "passed" we never returned to the caller cannot be undone.
    if (pipelineSignal?.aborted === true) {
      const lastStage = stages[stages.length - 1];
      const lastName = lastStage !== undefined ? lastStage.name : "<final>";
      return {
        ok: false,
        error: stageError(
          "TIMEOUT",
          lastName,
          "Pipeline aborted after final stage; result discarded and not cached.",
        ),
      };
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
      // Suppress cache.set when the initiating caller has aborted. The
      // shared pipeline runs without honoring the leader's signal so it
      // can serve other followers (see pipelineSignal above), but caching
      // a pass for a verification the initiating caller cancelled would
      // let later callers receive a cached "passed" result that the
      // original requester explicitly rejected. Cache writes are best
      // effort anyway — the next live caller will repopulate. (`signal`
      // here is the leader caller's signal closed over from runPipeline.)
      if (signal?.aborted === true) {
        console.debug("[forge-verifier] cache.set suppressed (leader aborted)");
      } else {
        try {
          await cache.set(composedKey, { key: composedKey, summary });
        } catch (e: unknown) {
          // Cache writes are best-effort. A backend outage must not flip a
          // successful verification into a rejection. Surface via console.debug
          // so operators can correlate; the next run will simply repopulate.
          console.debug("[forge-verifier] cache.set failed (ignored):", e);
        }
      }
    }

    return { ok: true, value: summary };
  };

  if (inflightKey !== undefined) {
    const key = inflightKey;
    // The shared pipeline runs without any caller's signal (see
    // pipelineSignal above). Register the promise so concurrent callers
    // coalesce — even when the leader has its own signal. The leader's
    // own cancellation is enforced at the same waitWithSignal boundary
    // as every follower, so leader and follower cancellations are
    // symmetric and never cross-contaminate.
    const promise = work().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return signal !== undefined ? waitWithSignal(promise, signal) : promise;
  }
  return work();
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
function rejectUnsupportedShape(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  budget: NodeBudget,
  depth = 0,
): void {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new TypeError(
      `Artifact at ${path} exceeds maximum depth (${MAX_ARTIFACT_DEPTH}); deeply-nested artifacts are rejected to bound preprocessing CPU under cancellation.`,
    );
  }
  budget.count += 1;
  if (budget.count > MAX_ARTIFACT_NODES) {
    throw new TypeError(
      `Artifact at ${path} exceeds maximum node count (${MAX_ARTIFACT_NODES}); wide artifacts are rejected to bound preprocessing CPU under cancellation.`,
    );
  }
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
  // Proxy detection BEFORE any reflective op. `types.isProxy` is a privileged
  // V8 introspection (Bun + Node both expose it via node:util) that does NOT
  // invoke any handler. A Proxy artifact is rejected here without ever firing
  // a trap, closing the only remaining caller-code-on-verifier-stack path.
  if (types.isProxy(value)) {
    throw new TypeError(
      `Artifact at ${path} is a Proxy; verifier requires plain-data artifacts (Proxy traps would execute caller code on the verifier stack).`,
    );
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
    // Reject sparse arrays: every index in [0, length) MUST have an own
    // data descriptor. A hole would be skipped by Array.prototype.map and
    // alias to a denser array's cache key — different content, same key.
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(arrDescs, String(i))) {
        throw new TypeError(
          `Artifact at ${path}[${i}] is a hole; verifier rejects sparse arrays (holes are skipped by serializers and would alias dense arrays in the cache key).`,
        );
      }
    }
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
      rejectUnsupportedShape(desc.value, `${path}[${k}]`, seen, budget, depth + 1);
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
    rejectUnsupportedShape(desc.value, `${path}.${k}`, seen, budget, depth + 1);
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
