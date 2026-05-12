import type {
  AgentGroupId,
  AgentId,
  ScratchpadComponent,
  ScratchpadEntry,
  ScratchpadEntrySummary,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusScratchpadConfig {
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly transport: NexusTransport;
  readonly methodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
  /**
   * Optional local component used as a startup-only escape hatch when
   * the configured Nexus transport fails its initial health probe.
   * Once `createNexusScratchpad()` returns, the chosen authority is
   * fixed for the lifetime of the instance — runtime RPC failures are
   * NEVER routed to the fallback, because the two backends do not
   * share state and silently rerouting would fork the source of truth
   * and produce effective data loss for the caller.
   */
  readonly fallback?: ScratchpadComponent | undefined;
}

export interface NexusScratchpadEntryRecord
  extends Omit<ScratchpadEntry, "path" | "groupId" | "authorId"> {
  readonly path: string;
  readonly groupId: string;
  readonly authorId: string;
}

export interface NexusScratchpadWriteResponse {
  readonly path: string;
  readonly generation: number;
  readonly sizeBytes: number;
}

export interface NexusScratchpadReadResponse {
  readonly entry: NexusScratchpadEntryRecord;
}

export interface NexusScratchpadListResponse {
  readonly entries: readonly (Omit<ScratchpadEntrySummary, "path" | "groupId" | "authorId"> & {
    readonly path: string;
    readonly groupId: string;
    readonly authorId: string;
  })[];
  /**
   * Opaque continuation token. When present, the caller must invoke `list`
   * again with `cursor: nextCursor` to drain the remainder. When absent the
   * snapshot is exhaustive.
   */
  readonly nextCursor?: string | undefined;
}
