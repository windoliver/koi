/**
 * Nexus-backed ForgeStore implementation.
 *
 * Stores each BrickArtifact as a JSON file on a Nexus server via JSON-RPC.
 * Suitable for multi-node deployments where all nodes share a central
 * Nexus filesystem.
 *
 * Search uses client-side filtering: glob all brick files, read each in
 * bounded batches, then post-filter with matchesBrickQuery + sortBricks.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickUpdate,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
  StoreChangeEvent,
} from "@koi/core";
import { conflict, notFound } from "@koi/core";
import { createListenerSet } from "@koi/event-delivery";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import {
  applyBrickUpdate,
  matchesBrickQuery,
  sortBricks,
  validateBrickArtifact,
} from "@koi/validation";
import { batchMap } from "./shared/batch-map.js";
import { validatePathSegment, wrapNexusError } from "./shared/nexus-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "bricks";
const DEFAULT_CONCURRENCY = 10;

export interface NexusForgeStoreConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly concurrency?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Optional integrity check callback invoked on save. Return `{ ok: false }` to reject. */
  readonly verifyOnSave?:
    | ((brick: import("@koi/core").BrickArtifact) => { readonly ok: boolean })
    | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed ForgeStore for multi-node deployments. */
export function createNexusForgeStore(config: NexusForgeStoreConfig): ForgeStore {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  const listeners = createListenerSet<StoreChangeEvent>();

  // --- Internal helpers ---------------------------------------------------

  function brickPath(id: BrickId): string {
    return `${basePath}/${id}.json`;
  }

  /** Unwrap Nexus response — handles string, pre-parsed object, and { __type__: "bytes", data: base64 }. */
  function unwrapNexusValue(value: unknown): unknown {
    if (typeof value === "string") return JSON.parse(value);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { readonly __type__?: string }).__type__ === "bytes" &&
      typeof (value as { readonly data?: unknown }).data === "string"
    ) {
      return JSON.parse(atob((value as { readonly data: string }).data));
    }
    return value;
  }

  async function readBrick(id: BrickId): Promise<Result<BrickArtifact, KoiError>> {
    const readResult = await client.rpc<unknown>("read", { path: brickPath(id) });
    if (!readResult.ok) {
      if (
        readResult.error.code === "NOT_FOUND" ||
        (readResult.error.code === "EXTERNAL" &&
          readResult.error.message.toLowerCase().includes("not found"))
      ) {
        return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
      }
      return readResult as Result<BrickArtifact, KoiError>;
    }
    try {
      const parsed: unknown = unwrapNexusValue(readResult.value);
      return validateBrickArtifact(parsed, `nexus:${id}`);
    } catch (e: unknown) {
      return { ok: false, error: wrapNexusError("INTERNAL", `Failed to parse brick ${id}`, e) };
    }
  }

  async function writeBrick(brick: BrickArtifact): Promise<Result<void, KoiError>> {
    // Retry with backoff on 429 (Nexus rate limit). Startup writes (companion skills,
    // demo seed) can exhaust the burst budget — forge saves need resilience.
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
      const result = await client.rpc<null>("write", {
        path: brickPath(brick.id),
        content: JSON.stringify(brick),
      });
      if (result.ok) return { ok: true, value: undefined };
      if (!result.error.retryable || attempt === MAX_RETRIES) return result;
    }
    // Unreachable but satisfies return type
    return {
      ok: false,
      error: { code: "INTERNAL", message: "Retry exhausted", retryable: false, context: {} },
    };
  }

  // --- ForgeStore methods -------------------------------------------------

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(brick.id, "Brick ID");
    if (!segCheck.ok) {
      return segCheck;
    }
    // Write-time integrity verification (when configured)
    if (config.verifyOnSave !== undefined) {
      const check = config.verifyOnSave(brick);
      if (!check.ok) {
        return {
          ok: false,
          error: wrapNexusError(
            "VALIDATION",
            `Integrity check failed on save for ${brick.id}`,
            undefined,
          ),
        };
      }
    }
    // Stamp storeVersion=1 on first save (preserve existing if present)
    const versioned: BrickArtifact =
      brick.storeVersion !== undefined ? brick : { ...brick, storeVersion: 1 };
    const result = await writeBrick(versioned);
    if (result.ok) listeners.notify({ kind: "saved", brickId: versioned.id });
    return result;
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    return readBrick(id);
  };

  // Performance: O(N) client-side scan — globs all brick files, reads each
  // over the network in batches, then filters in-memory. Acceptable for
  // local/small deployments (N < ~200 bricks) but degrades linearly:
  //   N=500:  ~50 batches, noticeable latency
  //   N=1000: multi-second search, poor CLI UX
  //   N=5000+: effectively unusable for interactive commands
  // Fix: server-side search RPC or migration to a store with native query
  // support. Blocking for the remote registry (WS4+5).
  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const rawGlob = await client.rpc<unknown>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!rawGlob.ok) return rawGlob as Result<readonly BrickArtifact[], KoiError>;
    // Nexus glob returns { matches: string[] } — extract the array
    const globValue = rawGlob.value;
    const globResult = {
      ok: true as const,
      value: Array.isArray(globValue)
        ? (globValue as readonly string[])
        : Array.isArray((globValue as { readonly matches?: unknown }).matches)
          ? (globValue as { readonly matches: readonly string[] }).matches
          : ([] as readonly string[]),
    };

    // let justified: accumulates first infrastructure error from parallel reads
    let infrastructureError: KoiError | undefined;

    const bricks = await batchMap(
      globResult.value,
      async (path): Promise<BrickArtifact | undefined> => {
        if (infrastructureError !== undefined) return undefined;
        const readResult = await client.rpc<string>("read", { path });
        if (!readResult.ok) {
          // File may have been deleted between glob and read — treat as skip
          const msg = readResult.error.message.toLowerCase();
          if (
            readResult.error.code === "NOT_FOUND" ||
            (readResult.error.code === "EXTERNAL" && msg.includes("not found"))
          ) {
            return undefined;
          }
          infrastructureError = readResult.error;
          return undefined;
        }
        try {
          const parsed: unknown = unwrapNexusValue(readResult.value);
          const validated = validateBrickArtifact(parsed, `nexus:search:${path}`);
          if (!validated.ok) {
            console.warn(`Skipping invalid brick at ${path}: validation failed`);
            return undefined;
          }
          return validated.value;
        } catch (e: unknown) {
          console.warn(`Skipping corrupt brick at ${path}: ${String(e)}`);
          return undefined;
        }
      },
      concurrency,
    );

    if (infrastructureError !== undefined) {
      return { ok: false, error: infrastructureError };
    }

    const validBricks = bricks.filter((b): b is BrickArtifact => b !== undefined);
    const filtered = validBricks.filter((brick) => matchesBrickQuery(brick, query));
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });

    if (query.limit !== undefined) {
      return { ok: true, value: sorted.slice(0, query.limit) };
    }
    return { ok: true, value: sorted };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    const existsResult = await client.rpc<boolean>("exists", { path: brickPath(id) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const result = await client.rpc<null>("delete", { path: brickPath(id) });
    if (!result.ok) return result;
    listeners.notify({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  // Note: optimistic locking is client-side (read → check → write). Under
  // concurrent multi-node writers, two callers can read the same version,
  // both pass the check, and both write — losing one update. True atomicity
  // requires a server-side CAS operation in Nexus (not yet implemented).
  // For single-node or low-contention use this eliminates most real conflicts.
  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    const loadResult = await readBrick(id);
    if (!loadResult.ok) return loadResult;

    // Optimistic locking: reject if version mismatch
    if (updates.expectedVersion !== undefined) {
      const currentVersion = loadResult.value.storeVersion ?? 0;
      if (currentVersion !== updates.expectedVersion) {
        return {
          ok: false,
          error: conflict(
            id,
            `Version conflict on brick ${id}: expected version ${String(updates.expectedVersion)}, current version ${String(currentVersion)}`,
          ),
        };
      }
    }

    const applied = applyBrickUpdate(loadResult.value, updates);
    // Bump storeVersion on every successful update
    const nextVersion = (loadResult.value.storeVersion ?? 0) + 1;
    const updated: BrickArtifact = { ...applied, storeVersion: nextVersion };
    const writeResult = await writeBrick(updated);
    if (!writeResult.ok) return writeResult;
    listeners.notify({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    // NFS exists returns { exists: boolean }, not a bare boolean.
    const result = await client.rpc<{ readonly exists: boolean } | boolean>("exists", {
      path: brickPath(id),
    });
    if (!result.ok) return result;
    const val = result.value;
    const boolVal = typeof val === "boolean" ? val : (val as { exists?: boolean }).exists === true;
    return { ok: true, value: boolVal };
  };

  // Track unsubscribe functions for dispose
  const unsubscribers = new Set<() => void>();

  const watch = (listener: (event: StoreChangeEvent) => void): (() => void) => {
    const unsub = listeners.subscribe(listener);
    unsubscribers.add(unsub);
    return () => {
      unsub();
      unsubscribers.delete(unsub);
    };
  };

  const dispose = (): void => {
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.clear();
  };

  return { save, load, search, remove, update, exists, watch, dispose };
}
