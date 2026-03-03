/**
 * Nexus-backed persistence backend for MemoryComponent.
 *
 * Stores memory facts as JSON files on a Nexus server. Each entity's
 * facts are stored in a single JSON file.
 *
 * Path convention:
 *   /memory/entities/{slug}.json
 *
 * This provides a pluggable backend that memory-fs can use instead
 * of direct filesystem writes, enabling multi-node deployments.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { validatePathSegment, wrapNexusError } from "./shared/nexus-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single memory fact (stored as part of an entity's fact array). */
export interface MemoryFact {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
  readonly source: string;
  readonly createdAt: number;
}

/** Pluggable persistence backend for memory facts. */
export interface MemoryPersistenceBackend {
  readonly readFacts: (entity: string) => Promise<Result<readonly MemoryFact[], KoiError>>;
  readonly writeFacts: (
    entity: string,
    facts: readonly MemoryFact[],
  ) => Promise<Result<void, KoiError>>;
  readonly removeFacts: (entity: string) => Promise<Result<void, KoiError>>;
  readonly listEntities: () => Promise<Result<readonly string[], KoiError>>;
  readonly close: () => void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = "/memory/entities";

export interface NexusMemoryBackendConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly basePath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed MemoryPersistenceBackend. */
export function createNexusMemoryBackend(
  config: NexusMemoryBackendConfig,
): MemoryPersistenceBackend {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  function entityPath(entity: string): string {
    return `${basePath}/${entity}.json`;
  }

  const readFacts = async (entity: string): Promise<Result<readonly MemoryFact[], KoiError>> => {
    const segCheck = validatePathSegment(entity, "Entity name");
    if (!segCheck.ok) return segCheck;
    const r = await client.rpc<string>("read", { path: entityPath(entity) });
    if (!r.ok) {
      if (r.error.code === "EXTERNAL" || r.error.code === "NOT_FOUND") {
        return { ok: true, value: [] };
      }
      return r;
    }
    try {
      return { ok: true, value: JSON.parse(r.value) as readonly MemoryFact[] };
    } catch (e: unknown) {
      return {
        ok: false,
        error: wrapNexusError("INTERNAL", `Failed to parse memory facts for ${entity}`, e),
      };
    }
  };

  const writeFacts = async (
    entity: string,
    facts: readonly MemoryFact[],
  ): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(entity, "Entity name");
    if (!segCheck.ok) return segCheck;
    const r = await client.rpc<null>("write", {
      path: entityPath(entity),
      content: JSON.stringify(facts),
    });
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  };

  const removeFacts = async (entity: string): Promise<Result<void, KoiError>> => {
    const segCheck = validatePathSegment(entity, "Entity name");
    if (!segCheck.ok) return segCheck;
    const existsResult = await client.rpc<boolean>("exists", { path: entityPath(entity) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFound(entity, `Memory entity not found: ${entity}`) };
    }
    const r = await client.rpc<null>("delete", { path: entityPath(entity) });
    if (!r.ok) return r;
    return { ok: true, value: undefined };
  };

  const listEntities = async (): Promise<Result<readonly string[], KoiError>> => {
    const globResult = await client.rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

    const entities = globResult.value.map((p) => {
      const fileName = p.split("/").pop() ?? "";
      return fileName.replace(".json", "");
    });
    return { ok: true, value: entities };
  };

  const close = (): void => {
    // No persistent resources to release for Nexus RPC
  };

  return { readFacts, writeFacts, removeFacts, listEntities, close };
}
