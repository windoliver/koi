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
   * `nextCursor` pagination contract. Defaults to `false` for safety
   * against version skew: against a legacy or partially upgraded server
   * that ignores the cursor field, a full first page would otherwise look
   * authoritative and trigger spurious `deleted` events for entries that
   * actually live on later pages. Set to `true` only when the connected
   * Nexus server has positively advertised pagination support — in that
   * mode a terminal page of any size is treated as exhaustive and the
   * tracker is free to synthesize delete events.
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
