import type { KoiError, Result, ScratchpadFilter, ScratchpadWriteInput } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type {
  NexusScratchpadListResponse,
  NexusScratchpadReadResponse,
  NexusScratchpadWriteResponse,
} from "./types.js";

export interface NexusScratchpadClient {
  readonly write: (
    groupId: string,
    authorId: string,
    input: ScratchpadWriteInput,
  ) => Promise<Result<NexusScratchpadWriteResponse, KoiError>>;
  readonly read: (
    groupId: string,
    path: string,
  ) => Promise<Result<NexusScratchpadReadResponse, KoiError>>;
  readonly list: (
    groupId: string,
    filter: ScratchpadFilter | undefined,
    limit: number,
  ) => Promise<Result<NexusScratchpadListResponse, KoiError>>;
  readonly delete: (
    groupId: string,
    authorId: string,
    path: string,
  ) => Promise<Result<void, KoiError>>;
}

export function createNexusScratchpadClient(
  transport: NexusTransport,
  prefix: string,
): NexusScratchpadClient {
  return {
    write: (groupId, authorId, input) =>
      transport.call<NexusScratchpadWriteResponse>(`${prefix}.write`, {
        groupId,
        authorId,
        path: input.path,
        content: input.content,
        expectedGeneration: input.expectedGeneration,
        ttlSeconds: input.ttlSeconds,
        metadata: input.metadata,
      }),
    read: (groupId, path) =>
      transport.call<NexusScratchpadReadResponse>(`${prefix}.read`, { groupId, path }),
    list: (groupId, filter, limit) =>
      transport.call<NexusScratchpadListResponse>(`${prefix}.list`, { groupId, filter, limit }),
    delete: async (groupId, authorId, path) => {
      const result = await transport.call<{ readonly ok: true }>(`${prefix}.delete`, {
        groupId,
        authorId,
        path,
      });
      return result.ok ? { ok: true, value: undefined } : result;
    },
  };
}
