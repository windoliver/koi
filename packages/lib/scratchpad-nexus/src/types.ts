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
  readonly fallback?: ScratchpadComponent | undefined;
  readonly methodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
  /**
   * Capability flag declaring that the configured Nexus server honors the
   * `nextCursor` pagination contract. Defaults to `true`: an absent
   * `nextCursor` is taken as proof that the snapshot is exhaustive and the
   * tracker can synthesize delete events. Set to `false` only when targeting
   * a legacy server that ignores the cursor field — in that compatibility
   * mode a terminal page of exactly `pageSize` entries is treated as
   * ambiguous and delete synthesis is skipped for that round.
   */
  readonly serverSupportsPagination?: boolean | undefined;
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
