/**
 * Configuration and handle types for the filesystem rollback middleware.
 */

import type {
  ChainId,
  FileOpRecord,
  FileSystemBackend,
  KoiError,
  KoiMiddleware,
  NodeId,
  Result,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";

/** Configuration for the filesystem rollback middleware. */
export interface FsRollbackConfig {
  readonly store: SnapshotChainStore<FileOpRecord>;
  readonly chainId: ChainId;
  readonly backend: FileSystemBackend;
  /** Tool ID prefix to match against (e.g., "fs"). Default: "fs". */
  readonly toolPrefix?: string | undefined;
  /** Maximum file size to capture in bytes. Default: 1MB. */
  readonly maxCaptureSize?: number | undefined;
  /** Optional function to get current event index for correlation with event-trace. */
  readonly getEventIndex?: (() => number) | undefined;
}

/** Handle returned by the factory, exposing middleware and rollback operations. */
export interface FsRollbackHandle {
  readonly middleware: KoiMiddleware;
  readonly rollbackTo: (targetNodeId: NodeId) => Promise<Result<number, KoiError>>;
  readonly getRecords: () => Promise<Result<readonly SnapshotNode<FileOpRecord>[], KoiError>>;
}
