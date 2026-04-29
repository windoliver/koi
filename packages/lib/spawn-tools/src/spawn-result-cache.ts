/**
 * SpawnResultCache — bounded LRU for idempotent agent_spawn retries.
 *
 * Key shape: `${parentAgentId}::${agentName}::${taskId}::${digest}` where
 * `digest` is a hash of (agentName, description, context). Including the
 * digest means a retry with the same `task_id` but updated instructions or
 * context produces a fresh key — we never replay stale output for changed
 * work. Without `context.task_id` (or context entirely) the key is
 * `undefined` and dedup is skipped.
 *
 * `runDeduped` checks the settled-result LRU before invoking the factory.
 * On a hit, the cached output is returned immediately (after a fresh abort
 * check). On a miss, the factory runs to settlement; success is cached if
 * the result is cacheable. Failures are NOT cached.
 *
 * Concurrent in-flight sharing is intentionally NOT performed. Sharing an
 * unsettled Promise would let a second caller receive a placeholder
 * `{ok:true}` admission for non-streaming spawns (deferred / on-demand)
 * before any child has actually completed, which is incorrect for
 * partial-failure recovery. The cost of this conservative choice is that
 * two concurrent calls within the same overlap window each invoke the
 * factory; the cost is bounded by how rare same-key in-flight overlap is
 * in practice. See `docs/L2/spawn-tools.md` "Known limitations" §3.
 *
 * LRU is Map insertion-order: `get` promotes (delete + re-insert), `set`
 * evicts the oldest at capacity. Sync — no async overhead on the hot path.
 *
 * Cap of 256 covers realistic coordinator fan-out (issue #1709).
 */

import { computeContentHash } from "@koi/hash";

export const DEFAULT_SPAWN_CACHE_CAP = 256;

export type SpawnFactoryResult =
  | {
      readonly ok: true;
      readonly output: string;
      /**
       * Whether this result represents a completed child execution and may be
       * cached for future retries. Defaults to `true` when omitted. Set to
       * `false` for deferred / on-demand delivery modes where `spawnFn` returns
       * before the child finishes — caching a partial/empty output would mask
       * a later child failure on retry.
       */
      readonly cacheable?: boolean;
    }
  | { readonly ok: false; readonly error: string };

export type SpawnRunResult =
  | { readonly ok: true; readonly output: string; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: string };

export interface SpawnResultCache {
  readonly get: (key: string) => string | undefined;
  readonly set: (key: string, output: string) => void;
  readonly size: () => number;
  /**
   * Settled-cache dedup. Checks the caller's `signal` before returning a
   * cached entry — a cancelled caller never receives a deduplicated success,
   * because emitting a child output into an aborted parent turn would
   * violate turn-boundary semantics. On miss, invokes `factory`, races its
   * Promise against the signal, and stores the result if cacheable.
   */
  readonly runDeduped: (
    key: string,
    signal: AbortSignal,
    factory: () => Promise<SpawnFactoryResult>,
  ) => Promise<SpawnRunResult>;
}

export function createSpawnResultCache(
  maxEntries: number = DEFAULT_SPAWN_CACHE_CAP,
): SpawnResultCache {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`SpawnResultCache: maxEntries must be a positive integer, got ${maxEntries}`);
  }

  const cache = new Map<string, string>();
  // Per-key in-flight registry. Concurrent same-key callers attach to the
  // first attempt's Promise so only one factory invocation runs per key
  // overlap window. The flag carries the cacheability of the eventual
  // result — `cacheable: false` is propagated to all waiters so they
  // honor the same persistence semantics.
  const inflight = new Map<string, Promise<SpawnFactoryResult>>();
  // Monotonic generation counter per key. Each runDeduped invocation that
  // reaches the factory bumps the generation and remembers the value it
  // owned; an aborted attempt's late background settle only writes to the
  // cache if it still owns the latest generation (i.e. no newer attempt
  // has started since). This prevents an older attempt's output from
  // clobbering a fresher in-flight retry's slot on settle.
  const generations = new Map<string, number>();

  function get(key: string): string | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function set(key: string, output: string): void {
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, output);
  }

  function abortedResult(signal: AbortSignal): SpawnRunResult {
    const reason = signal.reason;
    const message =
      reason instanceof Error ? reason.message : reason === undefined ? "aborted" : String(reason);
    return { ok: false, error: `aborted: ${message}` };
  }

  async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (!signal.aborted) {
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    }
    throw signal.reason ?? new Error("aborted");
  }

  async function runDeduped(
    key: string,
    signal: AbortSignal,
    factory: () => Promise<SpawnFactoryResult>,
  ): Promise<SpawnRunResult> {
    if (signal.aborted) return abortedResult(signal);

    const settled = get(key);
    if (settled !== undefined) {
      return { ok: true, output: settled, deduplicated: true };
    }

    // In-flight coalescing: if another caller is already running the same
    // key, attach to its Promise. Both callers receive identical
    // `SpawnFactoryResult`; cacheable=false placeholders propagate to all
    // waiters so they share the same admission semantics. Only the driver
    // writes to the LRU on settle (via the registered .then handler).
    const pending = inflight.get(key);
    if (pending !== undefined) {
      try {
        const shared = await awaitWithAbort(pending, signal);
        if (!shared.ok) return { ok: false, error: shared.error };
        return { ok: true, output: shared.output, deduplicated: true };
      } catch (err) {
        if (signal.aborted) return abortedResult(signal);
        throw err;
      }
    }

    // Claim a fresh generation for this attempt. Any later attempt for
    // the same key bumps this counter, so the abort backfill below can
    // detect that a newer attempt has superseded ours.
    const myGeneration = (generations.get(key) ?? 0) + 1;
    generations.set(key, myGeneration);

    // Driver path: invoke the factory, register in the inflight map so
    // concurrent waiters can attach. Inflight slot clears on settle (via
    // the .then handler below), independent of when the driver's await
    // observes the result — so an aborted driver doesn't strand waiters.
    const factoryPromise = factory();
    inflight.set(key, factoryPromise);
    factoryPromise.then(
      (settled) => {
        if (
          settled.ok &&
          settled.cacheable !== false &&
          generations.get(key) === myGeneration &&
          !cache.has(key)
        ) {
          set(key, settled.output);
        }
        if (inflight.get(key) === factoryPromise) inflight.delete(key);
      },
      () => {
        if (inflight.get(key) === factoryPromise) inflight.delete(key);
      },
    );

    let result: SpawnFactoryResult;
    try {
      result = await awaitWithAbort(factoryPromise, signal);
    } catch (err) {
      if (signal.aborted) {
        // Driver aborted. Evict the inflight slot immediately so a retry
        // arriving in the abort window drives its own spawn instead of
        // coalescing to a logical attempt that the caller already gave up
        // on. The .then handler above still runs when the orphan settles,
        // backfilling the cache only if no newer attempt has bumped the
        // generation (conservative: keeps the abort-completed result for
        // future retries when no one supersedes it).
        if (inflight.get(key) === factoryPromise) inflight.delete(key);
        return abortedResult(signal);
      }
      throw err;
    }

    if (result.ok) {
      // The .then above already wrote to the cache when cacheable; we
      // don't need to write here again. (Idempotent — set is a no-op
      // overwrite if both fire, but the .then's guards are stricter.)
      return { ok: true, output: result.output, deduplicated: false };
    }
    return { ok: false, error: result.error };
  }

  return {
    get,
    set,
    size: () => cache.size,
    runDeduped,
  };
}

/**
 * Build a stable cache key from spawn identity + request body. Returns
 * `undefined` when no `context.task_id` is available — caller should skip
 * the cache in that case.
 *
 * The digest covers `agentName`, `description`, and the full `context`
 * object so retries with changed instructions produce a different key
 * (no stale-output replay).
 */
export function spawnCacheKey(
  parentAgentId: string,
  agentName: string,
  description: string,
  context: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (context === undefined) return undefined;
  const taskId = context.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  const digest = computeRequestDigest(agentName, description, context);
  // Non-serializable context (BigInt, cyclic refs) can't be hashed
  // deterministically — skip the cache rather than crash the tool.
  if (digest === undefined) return undefined;
  return `${parentAgentId}::${agentName}::${taskId}::${digest}`;
}

function computeRequestDigest(
  agentName: string,
  description: string,
  context: Readonly<Record<string, unknown>>,
): string | undefined {
  // computeContentHash deterministically serializes with sorted object keys,
  // so two contexts with identical data but different key insertion order
  // produce the same digest — and therefore the same cache key.
  // Returns the first 16 hex chars; full SHA-256 is overkill for a 256-entry LRU.
  try {
    return computeContentHash({ agentName, description, context }).slice(0, 16);
  } catch {
    return undefined;
  }
}
