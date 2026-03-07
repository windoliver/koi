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
import { notFound } from "@koi/core";
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

  async function readBrick(id: BrickId): Promise<Result<BrickArtifact, KoiError>> {
    const readResult = await client.rpc<string>("read", { path: brickPath(id) });
    if (!readResult.ok) {
      if (
        readResult.error.code === "NOT_FOUND" ||
        (readResult.error.code === "EXTERNAL" &&
          readResult.error.message.toLowerCase().includes("not found"))
      ) {
        return { ok: false, error: notFound(id, `Brick not found: ${id}`) };
      }
      return readResult;
    }
    try {
      const parsed: unknown = JSON.parse(readResult.value);
      return validateBrickArtifact(parsed, `nexus:${id}`);
    } catch (e: unknown) {
      return { ok: false, error: wrapNexusError("INTERNAL", `Failed to parse brick ${id}`, e) };
    }
  }

  async function writeBrick(brick: BrickArtifact): Promise<Result<void, KoiError>> {
    const result = await client.rpc<null>("write", {
      path: brickPath(brick.id),
      content: JSON.stringify(brick),
    });
    if (!result.ok) return result;
    return { ok: true, value: undefined };
  }

  // --- ForgeStore methods -------------------------------------------------

  const save = async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(brick.id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    const result = await writeBrick(brick);
    if (result.ok) listeners.notify({ kind: "saved", brickId: brick.id });
    return result;
  };

  const load = async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    return readBrick(id);
  };

  const search = async (query: ForgeQuery): Promise<Result<readonly BrickArtifact[], KoiError>> => {
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

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
          const parsed: unknown = JSON.parse(readResult.value);
          const validated = validateBrickArtifact(parsed, `nexus:search:${path}`);
          if (!validated.ok) return undefined;
          return validated.value;
        } catch (_e: unknown) {
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

  const update = async (id: BrickId, updates: BrickUpdate): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    const loadResult = await readBrick(id);
    if (!loadResult.ok) return loadResult;

    const updated = applyBrickUpdate(loadResult.value, updates);
    const writeResult = await writeBrick(updated);
    if (!writeResult.ok) return writeResult;
    listeners.notify({ kind: "updated", brickId: id });
    return { ok: true, value: undefined };
  };

  const exists = async (id: BrickId): Promise<Result<boolean, KoiError>> => {
    const segCheck = validatePathSegment(id, "Brick ID");
    if (!segCheck.ok) return segCheck;
    return client.rpc<boolean>("exists", { path: brickPath(id) });
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
