import type { ForgeStageDigest, ForgeVerificationSummary, KoiErrorCode, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import {
  composeCacheKey,
  fingerprintStages,
  freezeSummary,
  isCachedSummaryConsistent,
  stageError,
} from "./cache-key.js";
import { canonicalJson } from "./canonical.js";
import { cacheId, inflight, waitWithSignal } from "./inflight.js";
import { describeThrown, runStage } from "./run-stage.js";
import { deepFreeze, rejectUnsupportedShape } from "./snapshot.js";
import type { StageContext, VerifierStage, VerifyOptions } from "./types.js";

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
  const stageTimeoutMs = options?.stageTimeoutMs;

  // Validate stageTimeoutMs eagerly — silently coercing 0/negative/NaN
  // into "no timeout" turns a misconfiguration into the unbounded hang
  // this option exists to prevent. Fail closed.
  if (
    stageTimeoutMs !== undefined &&
    !(typeof stageTimeoutMs === "number" && Number.isFinite(stageTimeoutMs) && stageTimeoutMs > 0)
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message: `VerifyOptions.stageTimeoutMs must be a finite positive number when set; got ${String(stageTimeoutMs)}.`,
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
      },
    };
  }

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

  // Cache is NOT a security boundary — a backend that can write
  // structurally-correct envelopes can mint forged passes without any
  // stage running. Require every call site to explicitly acknowledge
  // that the supplied backend's write path is restricted to trusted
  // producers. Without this acknowledgment the cache is rejected — the
  // trust decision must live at the call site, not behind a default.
  if (cache !== undefined && options?.acknowledgeTrustedCache !== true) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message:
          "VerifyOptions.cache requires acknowledgeTrustedCache: true. The cache is a TRUSTED storage optimization, not a security boundary — a backend that can write envelopes can forge passing attestations. Pass this flag only when the backend's write path is restricted to trusted producers.",
        retryable: RETRYABLE_DEFAULTS.INVALID_CONFIG,
      },
    };
  }

  // Require executionContextKey whenever results may be SHARED across
  // callers (cache + coalesceUncached). Stages may close over ambient
  // state (auth, tenant policy, feature flags); silently substituting
  // "" lets one caller's pass satisfy another caller's request that
  // would have evaluated different ambient context. Force callers to
  // either declare a stable context fingerprint or accept that they
  // cannot share results.
  const sharesResults = cache !== undefined || options?.coalesceUncached === true;
  const ctxRaw = options?.executionContextKey;
  if (sharesResults && (typeof ctxRaw !== "string" || ctxRaw.length === 0)) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message:
          "VerifyOptions.executionContextKey is required (non-empty string) when results may be shared across callers (cache or coalesceUncached). It partitions cache + single-flight by ambient stage context (auth, tenant policy, feature flags). Use a stable hash of any context the stage closures observe.",
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

  // Always derive the snapshot digest — used for both cache key (when a
  // cache is provided) and single-flight coalescing (always). Without
  // this, two concurrent uncached callers would each run every stage,
  // duplicating non-idempotent side effects (sandbox jobs, external
  // APIs, quota burns). Cyclic snapshots produce no deterministic key
  // and are rejected upfront for side-effecting pipelines below.
  let snapshotDigest: string | undefined;
  let cyclic = false;
  try {
    snapshotDigest = canonicalJson(snapshot, {
      onStack: new WeakSet<object>(),
      seen: new WeakMap<object, number>(),
      budget: { count: 0 },
      refCounter: 0,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string } | undefined)?.code;
    if (code === "FORGE_VERIFIER_CYCLE") {
      cyclic = true;
    } else {
      const detail = e instanceof Error ? e.message : "snapshot digest failed";
      return {
        ok: false,
        error: stageError("INTERNAL", "<snapshot>", `Snapshot digest failed: ${detail}`, e),
      };
    }
  }

  // Cyclic snapshots cannot be deterministically fingerprinted; cache
  // is bypassed for them. Single-flight is intentionally NOT applied to
  // uncached runs (see inflightKey below for rationale), so cyclic
  // artifacts simply run un-coalesced like any other uncached call.
  let composedKey: string | undefined;
  if (cache !== undefined && snapshotDigest !== undefined) {
    if (typeof namespace !== "string") {
      // Unreachable: validated above when cache !== undefined.
      throw new Error("namespace must be a string when cache is provided");
    }
    composedKey = composeCacheKey(
      namespace,
      snapshotDigest,
      stages,
      options?.executionContextKey,
      stageTimeoutMs,
    );
  } else if (cache !== undefined && cyclic) {
    // Cache write/read still bypassed for cyclic snapshots even on
    // non-sandboxed pipelines — no deterministic key to bind by.
    console.debug("[forge-verifier] cache bypassed (cyclic snapshot)");
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
  // Single-flight key includes cache backend identity, cacheReadFailure
  // policy, AND stageTimeoutMs so two callers coalesce only when they
  // would observe the same result. A trusted-cache caller MUST NOT
  // inherit a forged pass from an untrusted-cache caller, a `"fail"`
  // caller MUST NOT be dragged into a `"miss"` leader's silent
  // re-execution after a backend outage, and a strict-timeout caller
  // MUST NOT inherit a looser-timeout leader's safeguards.
  const stageTimeoutKey = stageTimeoutMs !== undefined ? String(stageTimeoutMs) : "none";
  const ctxKey = options?.executionContextKey ?? "";
  // Single-flight scope:
  //   - Cached runs (cache + ack provided): always coalesce. Key
  //     includes cache identity, policy, timeout, executionContextKey,
  //     and composed key.
  //   - Uncached runs: only coalesce when the caller explicitly opts
  //     in via `coalesceUncached: true`. Stage identity from
  //     descriptors alone is too weak to alias closures safely; the
  //     opt-in is the caller's acknowledgment that closures + ambient
  //     context are equivalent across coalesced peers. Cyclic
  //     snapshots have no digest → cannot coalesce regardless.
  const stagesFp = fingerprintStages(stages);
  let inflightKey: string | undefined;
  if (snapshotDigest !== undefined) {
    if (composedKey !== undefined && cache !== undefined) {
      inflightKey = `cached|${cacheId(cache)}|${cacheReadFailure}|${stageTimeoutKey}|${ctxKey}|${composedKey}`;
    } else if (options?.coalesceUncached === true) {
      inflightKey = `uncached|${cacheReadFailure}|${stageTimeoutKey}|${ctxKey}|${stagesFp}|${snapshotDigest}`;
    }
  }

  if (inflightKey !== undefined) {
    const existing = inflight.get(inflightKey);
    // Attach to the existing entry ONLY if the leader's pipeline
    // signal is not already aborted. A leader whose internal signal
    // has fired is doomed: its stage loop will short-circuit with
    // TIMEOUT on the next iteration. Letting an unaborted follower
    // attach would convert one caller's cancellation into another
    // caller's spurious failure — a particularly nasty under-load
    // race because it only appears in the narrow window between the
    // leader's abort and the stage loop noticing it. When the leader
    // is already doomed, evict the entry and become a fresh leader.
    // (The doomed leader's promise still settles to TIMEOUT for any
    // followers that already attached before the abort.)
    if (existing !== undefined) {
      if (existing.leaderPipelineSignal?.aborted === true) {
        inflight.delete(inflightKey);
      } else if (signal?.aborted === true) {
        // Follower is dead on arrival: do NOT detach the leader from
        // its own cancellation path (detach is irreversible and would
        // prevent the leader's abort from short-circuiting the shared
        // work even though no live consumer ever joined). Just return
        // a TIMEOUT directly without coalescing.
        return waitWithSignal(existing.promise, signal);
      } else {
        existing.detach();
        existing.registerConsumer(signal);
        if (signal === undefined) return existing.promise;
        return waitWithSignal(existing.promise, signal);
      }
    }
  }

  // `pipelineSignal` is the signal the stage loop honors.
  //   - Solo run (no inflightKey): caller's own signal — straightforward.
  //   - Cache-backed run with possible coalescing: start with an internal
  //     mirror of the caller's signal so a SOLO caller still aborts the
  //     work. When a follower joins (above), `detach()` unwires the
  //     mirror so the leader's signal no longer aborts the shared work.
  // `liveConsumers` tracks callers still awaiting the shared result at
  // cache-write time. Mere attachment is NOT enough — a follower that
  // attaches and then aborts before consumption never accepted the
  // result, and if every participating caller (leader + followers)
  // aborts before completion, we must NOT cache a `passed: true`
  // entry that no live caller actually received. Increments on
  // attachment; decrements when a caller's own signal aborts (which
  // is what causes their `waitWithSignal` to resolve to TIMEOUT
  // instead of the shared result).
  //
  // Starts at 1 for the leader (or 0 if `work()` is invoked directly
  // without inflight registration — see solo-run paths).
  // The leader is the first live consumer. If their own signal aborts
  // before `work()` resolves, decrement so the cache-write gate can
  // see "leader gone".
  let liveConsumers = 1;
  const decrementConsumer = (): void => {
    if (liveConsumers > 0) liveConsumers -= 1;
  };
  // Track every (signal, listener) pair we install so they can be
  // removed in a finally-style sweep after `work()` settles. Without
  // this, the listeners outlive the verification and accumulate on
  // long-lived caller signals (e.g. request-scoped controllers reused
  // across many verifications), turning the hot path into a memory
  // leak.
  const installedListeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const installListener = (sig: AbortSignal): void => {
    // Use a FRESH closure per registration. EventTarget dedupes
    // (listener, options) pairs by reference, so installing the same
    // `decrementConsumer` reference twice on a single AbortSignal
    // would decrement only once on abort — bypassing the
    // `liveConsumers === 0` cache-write gate when a leader and
    // follower happen to share an AbortSignal.
    const listener = (): void => decrementConsumer();
    sig.addEventListener("abort", listener, { once: true });
    installedListeners.push({ signal: sig, listener });
  };
  const releaseConsumerListeners = (): void => {
    for (const { signal: s, listener } of installedListeners) {
      s.removeEventListener("abort", listener);
    }
    installedListeners.length = 0;
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      decrementConsumer();
    } else {
      installListener(signal);
    }
  }
  // Register a follower (called from the inflight attach path of a
  // SECOND runPipeline frame). Increments now, decrements if the
  // follower's signal aborts before the shared work resolves.
  const registerConsumer = (followerSignal: AbortSignal | undefined): void => {
    if (followerSignal?.aborted === true) {
      // Already aborted on arrival — they will never observe the
      // result; do not count them.
      return;
    }
    liveConsumers += 1;
    if (followerSignal !== undefined) {
      installListener(followerSignal);
    }
  };
  let detachCallerSignal: () => void = () => {};
  let pipelineSignal: AbortSignal | undefined;
  if (inflightKey === undefined) {
    pipelineSignal = signal;
  } else if (signal === undefined) {
    pipelineSignal = undefined;
  } else {
    const internal = new AbortController();
    if (signal.aborted) {
      internal.abort();
    } else {
      const onAbort = (): void => internal.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      detachCallerSignal = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
    }
    pipelineSignal = internal.signal;
  }

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
      const { outcome, durationMs, thrown, aborted, underlying } = await runStage(
        stage,
        snapshot,
        ctx,
        pipelineSignal,
        stageTimeoutMs,
      );
      // Suppress unhandled rejection on the underlying promise; the
      // race already returned what the caller sees, and we don't keep
      // a reference (the slot lifecycle no longer waits on it).
      void underlying.catch(() => undefined);
      totalDurationMs += durationMs;

      // Pipeline-initiated abort (caller signal OR per-stage watchdog)
      // short-circuits with TIMEOUT regardless of whether the underlying
      // stage promise has settled. The stage may continue running — we
      // cannot kill a Promise — but the caller is unblocked.
      if (aborted === true) {
        return {
          ok: false,
          error: stageError(
            "TIMEOUT",
            stage.name,
            `Stage "${stage.name}" ${outcome.ok ? "" : outcome.reason}`.trim(),
          ),
        };
      }

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
      // Suppress cache.set when no live consumer remains at the moment
      // the shared verification completes. `liveConsumers` starts at 1
      // for the leader and is incremented for each follower that
      // attaches; it decrements whenever a participating caller's
      // signal aborts. If every caller aborted before completion, no
      // live consumer ever accepted this result — caching it would
      // serve a "passed: true" entry that no participant actually
      // received.
      //
      // Drain pending microtasks first so any abort listeners that
      // fired synchronously while the stage loop was finishing have a
      // chance to decrement `liveConsumers` before we make the
      // suppression decision. (Without this yield, an abort that
      // raced the final stage's resolve could be missed.)
      await Promise.resolve();
      if (liveConsumers === 0) {
        console.debug("[forge-verifier] cache.set suppressed (no live consumer)");
      } else {
        try {
          await cache.set(composedKey, { key: composedKey, summary });
          // Best-effort post-write check: if every consumer aborted
          // DURING the cache.set network round-trip, the write has
          // already committed (most cache backends do not expose
          // delete or signal-cancellation). Log so operators can
          // correlate the rare race; we cannot retract a committed
          // write without a delete API on `VerificationCache`. The
          // pre-write microtask drain above eliminates the common
          // synchronous-abort race; this only catches the in-flight
          // network case.
          if (liveConsumers === 0) {
            console.debug(
              "[forge-verifier] cache.set committed but all consumers aborted during write (best-effort race)",
            );
          }
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
    // Register the leader entry BEFORE awaiting work so concurrent
    // followers coalesce. `detach` is invoked on first follower join
    // (see lookup branch above) and unwires the leader caller's signal
    // so the shared work is not killed by the leader's abort once
    // someone else depends on it.
    //
    // Release the in-flight slot as soon as `work()` settles. Earlier
    // revisions held the slot until every underlying stage promise also
    // settled, intending to deduplicate background work for an
    // uncooperative plugin. That choice bricked the key: once the
    // leader returned TIMEOUT, the wedged underlying could never settle
    // (by definition of "uncooperative"), and every subsequent caller
    // for the same artifact/context inherited the stale TIMEOUT for the
    // lifetime of the process — a soft DoS far worse than the
    // duplicated background work it prevented. The library's stated
    // contract for stageTimeoutMs already warns that the underlying
    // work may continue; honoring that contract by allowing fresh
    // verification attempts is the correct tradeoff. Followers that
    // joined while `work()` was running still share the leader's
    // result via the registered entry; only callers arriving AFTER
    // resolution become fresh leaders.
    const promise = work();
    const releaseSlot = promise.finally(() => {
      inflight.delete(key);
      releaseConsumerListeners();
      // Also unwire the leader's caller-signal mirror listener if no
      // follower ever attached (detachCallerSignal was never invoked
      // by a follower). Idempotent — safe to call again.
      detachCallerSignal();
    });
    void releaseSlot;
    inflight.set(key, {
      promise,
      detach: detachCallerSignal,
      leaderPipelineSignal: pipelineSignal,
      registerConsumer,
    });
    return signal !== undefined ? waitWithSignal(promise, signal) : promise;
  }
  // Solo path: still clean up listeners after work() settles so the
  // leader signal is not retained beyond the verification.
  return work().finally(releaseConsumerListeners);
}
