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
import { notFound, RETRYABLE_DEFAULTS } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import {
  applyBrickUpdate,
  matchesBrickQuery,
  sortBricks,
  validateBrickArtifact,
} from "@koi/validation";
import { batchMap } from "./batch-map.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "/forge/bricks";
const DEFAULT_CONCURRENCY = 10;

export interface NexusForgeStoreConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly concurrency?: number;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function brickPath(basePath: string, id: BrickId): string {
  return `${basePath}/${id}.json`;
}

function wrapNexusError(code: KoiError["code"], message: string, cause?: unknown): KoiError {
  return { code, message, retryable: RETRYABLE_DEFAULTS[code] ?? false, cause };
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

  // --- watch notification ---------------------------------------------------
  const changeListeners = new Set<(event: StoreChangeEvent) => void>();

  const notifyListeners = (event: StoreChangeEvent): void => {
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch (_err: unknown) {
        // Listener errors must not break the mutation return path.
      }
    }
  };

  // --- Internal helpers -----------------------------------------------------

  async function readBrick(id: BrickId): Promise<Result<BrickArtifact, KoiError>> {
    const path = brickPath(basePath, id);
    const readResult = await client.rpc<string>("read", { path });
    if (!readResult.ok) {
      // Map Nexus "not found" to our NOT_FOUND
      if (readResult.error.code === "EXTERNAL" || readResult.error.code === "NOT_FOUND") {
        return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
      }
      return readResult;
    }
    try {
      const parsed: unknown = JSON.parse(readResult.value);
      return validateBrickArtifact(parsed, `nexus:${id}`);
    } catch (e: unknown) {
      return {
        ok: false,
        error: wrapNexusError("INTERNAL", `Failed to parse brick ${id}`, e),
      };
    }
  }

  async function writeBrick(brick: BrickArtifact): Promise<Result<void, KoiError>> {
    const path = brickPath(basePath, brick.id);
    const content = JSON.stringify(brick);
    const result = await client.rpc<null>("write", { path, content });
    if (!result.ok) return result;
    return { ok: true, value: undefined };
  }

  // --- ForgeStore methods ---------------------------------------------------

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const result = await writeBrick(brick);
    if (result.ok) notifyListeners({ kind: "saved", brickId: brick.id });
    return result;
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    return readBrick(id);
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    // Glob all brick files
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

    // Read each file in bounded batches
    const bricks = await batchMap(
      globResult.value,
      async (path): Promise<BrickArtifact | undefined> => {
        // Extract id from path: /forge/bricks/brick_abc.json → brick_abc
        const readResult = await client.rpc<string>("read", { path });
        if (!readResult.ok) return undefined;
        try {
          const parsed: unknown = JSON.parse(readResult.value);
          const validated = validateBrickArtifact(parsed, `nexus:search:${path}`);
          if (!validated.ok) return undefined;
          return validated.value;
        } catch (_e: unknown) {
          // Parse/validation failure — skip corrupt brick during search
          return undefined;
        }
      },
      concurrency,
    );

    // Filter out failed reads
    const validBricks = bricks.filter((b): b is BrickArtifact => b !== undefined);

    // Post-filter with matchesBrickQuery
    const filtered = validBricks.filter((brick) => matchesBrickQuery(brick, query));

    // Sort + minFitnessScore filter via sortBricks
    const sorted = sortBricks(filtered, query, { nowMs: Date.now() });

    // Apply limit after sorting
    if (query.limit !== undefined) {
      return { ok: true, value: sorted.slice(0, query.limit) };
    }
    return { ok: true, value: sorted };
  };

  const remove = async (id: BrickId): Promise<Result<void, KoiError>> => {
    const existsResult = await client.rpc<boolean>("exists", {
      path: brickPath(basePath, id),
    });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
    }
    const result = await client.rpc<null>("delete", {
      path: brickPath(basePath, id),
    });
    if (!result.ok) return result;
    notifyListeners({ kind: "removed", brickId: id });
    return { ok: true, value: undefined };
  };

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const loadResult = await readBrick(id);
    if (!loadResult.ok) return loadResult;

    const updated = applyBrickUpdate(loadResult.value, updates);
    const writeResult = await writeBrick(updated);
    if (!writeResult.ok) return writeResult;
    notifyListeners({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    return client.rpc<boolean>("exists", { path: brickPath(basePath, id) });
  };

  const watch = (listener: (event: StoreChangeEvent) => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  const dispose = (): void => {
    changeListeners.clear();
  };

  return { save, load, search, remove, update, exists, watch, dispose };
}
