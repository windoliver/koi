/**
 * Thin Nexus RPC wrapper for scratchpad operations.
 *
 * All wire types are local — they never leak into the public API.
 */

import type {
  AgentGroupId,
  AgentId,
  KoiError,
  Result,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadFilter,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteResult,
} from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Wire types (local)
// ---------------------------------------------------------------------------

interface NexusWriteResponse {
  readonly path: string;
  readonly generation: number;
  readonly sizeBytes: number;
}

interface NexusReadResponse {
  readonly path: string;
  readonly content: string;
  readonly generation: number;
  readonly groupId: string;
  readonly authorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface NexusGenerationResponse {
  readonly generation: number;
}

interface NexusListResponse {
  readonly entries: readonly NexusReadResponse[];
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface ScratchpadClient {
  readonly write: (
    groupId: AgentGroupId,
    authorId: AgentId,
    path: ScratchpadPath,
    content: string,
    expectedGeneration?: ScratchpadGeneration,
    ttlSeconds?: number,
    metadata?: Record<string, unknown>,
  ) => Promise<Result<ScratchpadWriteResult, KoiError>>;

  readonly read: (
    groupId: AgentGroupId,
    path: ScratchpadPath,
  ) => Promise<Result<ScratchpadEntry, KoiError>>;

  readonly generation: (
    groupId: AgentGroupId,
    path: ScratchpadPath,
  ) => Promise<Result<ScratchpadGeneration, KoiError>>;

  readonly list: (
    groupId: AgentGroupId,
    filter?: ScratchpadFilter,
  ) => Promise<Result<readonly ScratchpadEntrySummary[], KoiError>>;

  readonly delete: (groupId: AgentGroupId, path: ScratchpadPath) => Promise<Result<void, KoiError>>;

  readonly provision: (groupId: AgentGroupId) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Wire → domain mapping
// ---------------------------------------------------------------------------

function mapEntry(raw: NexusReadResponse): ScratchpadEntry {
  return {
    path: raw.path as ScratchpadPath,
    content: raw.content,
    generation: raw.generation as ScratchpadGeneration,
    groupId: raw.groupId as AgentGroupId,
    authorId: raw.authorId as AgentId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    sizeBytes: raw.sizeBytes,
    ...(raw.ttlSeconds !== undefined ? { ttlSeconds: raw.ttlSeconds } : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
  };
}

function mapSummary(raw: NexusReadResponse): ScratchpadEntrySummary {
  return {
    path: raw.path as ScratchpadPath,
    generation: raw.generation as ScratchpadGeneration,
    groupId: raw.groupId as AgentGroupId,
    authorId: raw.authorId as AgentId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    sizeBytes: raw.sizeBytes,
    ...(raw.ttlSeconds !== undefined ? { ttlSeconds: raw.ttlSeconds } : {}),
    ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a scratchpad client using the shared Nexus JSON-RPC transport. */
export function createScratchpadClient(nexus: NexusClient): ScratchpadClient {
  return {
    write: async (groupId, authorId, path, content, expectedGeneration, ttlSeconds, metadata) => {
      const params: Record<string, unknown> = {
        groupId,
        authorId,
        path,
        content,
      };
      if (expectedGeneration !== undefined) params.expectedGeneration = expectedGeneration;
      if (ttlSeconds !== undefined) params.ttlSeconds = ttlSeconds;
      if (metadata !== undefined) params.metadata = metadata;

      const result = await nexus.rpc<NexusWriteResponse>("scratchpad.write", params);
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          path: result.value.path as ScratchpadPath,
          generation: result.value.generation as ScratchpadGeneration,
          sizeBytes: result.value.sizeBytes,
        },
      };
    },

    read: async (groupId, path) => {
      const result = await nexus.rpc<NexusReadResponse>("scratchpad.read", { groupId, path });
      if (!result.ok) return result;
      return { ok: true, value: mapEntry(result.value) };
    },

    generation: async (groupId, path) => {
      const result = await nexus.rpc<NexusGenerationResponse>("scratchpad.generation", {
        groupId,
        path,
      });
      if (!result.ok) return result;
      return { ok: true, value: result.value.generation as ScratchpadGeneration };
    },

    list: async (groupId, filter) => {
      const params: Record<string, unknown> = { groupId };
      if (filter?.glob !== undefined) params.glob = filter.glob;
      if (filter?.authorId !== undefined) params.authorId = filter.authorId;
      if (filter?.limit !== undefined) params.limit = filter.limit;

      const result = await nexus.rpc<NexusListResponse>("scratchpad.list", params);
      if (!result.ok) return result;
      return { ok: true, value: result.value.entries.map(mapSummary) };
    },

    delete: async (groupId, path) => {
      return nexus.rpc<void>("scratchpad.delete", { groupId, path });
    },

    provision: async (groupId) => {
      return nexus.rpc<void>("scratchpad.provision", { groupId });
    },
  };
}
