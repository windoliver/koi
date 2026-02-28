/**
 * Nexus permission types — ReBAC relationship tuples and RPC response types.
 */

// ---------------------------------------------------------------------------
// ReBAC relationship tuple (Zanzibar-style)
// ---------------------------------------------------------------------------

/** A Zanzibar-style relationship tuple: subject#relation@object. */
export interface RelationshipTuple {
  /** Subject identifier (e.g., "agent:coder"). */
  readonly subject: string;
  /** Relation name (e.g., "reader", "writer", "deleter"). */
  readonly relation: string;
  /** Object identifier (e.g., "folder:/src", "file:/src/main.ts"). */
  readonly object: string;
}

// ---------------------------------------------------------------------------
// Filesystem operation → ReBAC relation mapping
// ---------------------------------------------------------------------------

/** Maps filesystem operations to ReBAC relation names. */
export const FS_OPERATION_RELATIONS: {
  readonly read: "reader";
  readonly list: "reader";
  readonly search: "reader";
  readonly write: "writer";
  readonly edit: "writer";
  readonly delete: "deleter";
  readonly rename: "writer";
} = {
  read: "reader",
  list: "reader",
  search: "reader",
  write: "writer",
  edit: "writer",
  delete: "deleter",
  rename: "writer",
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// Nexus RPC response types
// ---------------------------------------------------------------------------

/** Response from permissions.check RPC. */
export interface NexusCheckResponse {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Response from permissions.checkBatch RPC. */
export interface NexusCheckBatchResponse {
  readonly results: readonly NexusCheckResponse[];
}

/** Response from revocations.check RPC. */
export interface NexusRevocationCheckResponse {
  readonly revoked: boolean;
}

/** Response from revocations.checkBatch RPC. */
export interface NexusRevocationBatchResponse {
  readonly results:
    | ReadonlyMap<string, boolean>
    | readonly { readonly id: string; readonly revoked: boolean }[];
}
