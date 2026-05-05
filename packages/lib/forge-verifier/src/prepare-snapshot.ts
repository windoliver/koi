/**
 * Snapshot validation + structured-clone + canonical-digest + cache
 * key derivation. Extracted from pipeline.ts in R37 to keep
 * pipeline.ts under the 400-line soft limit; semantics unchanged.
 */

import type { Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { composeCacheKey, stageError } from "./cache-key.js";
import { canonicalJson } from "./canonical.js";
import { deepFreeze, rejectUnsupportedShape } from "./snapshot.js";
import type { VerifierStage, VerifyOptions } from "./types.js";
import type { ValidatedConfig } from "./validate-options.js";

export interface PreparedSnapshot<I> {
  readonly snapshot: I;
  readonly snapshotDigest: string | undefined;
  readonly composedKey: string | undefined;
  readonly declaredSandbox: boolean;
  readonly cyclic: boolean;
}

export function prepareSnapshot<I>(
  artifact: I,
  stages: readonly VerifierStage<I>[],
  validated: ValidatedConfig,
  options: VerifyOptions | undefined,
): Result<PreparedSnapshot<I>> {
  const { namespace, cache, signal, stageTimeoutMs } = validated;

  if (signal?.aborted) {
    return {
      ok: false,
      error: stageError("TIMEOUT", "<snapshot>", "Pipeline aborted before snapshot."),
    };
  }

  // Snapshot the artifact via structuredClone before BOTH fingerprinting
  // AND running stages — binds the cache key, the verification work, and
  // the cached pass result to the same immutable bytes.
  let snapshot: I;
  try {
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
      // prototype clone would strip.
      rejectUnsupportedShape(artifact, "$", new WeakSet<object>(), { count: 0 });
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
  // cache is provided) and single-flight coalescing (always).
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
  // is bypassed for them.
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
    console.debug("[forge-verifier] cache bypassed (cyclic snapshot)");
  }

  return {
    ok: true,
    value: { snapshot, snapshotDigest, composedKey, declaredSandbox, cyclic },
  };
}
