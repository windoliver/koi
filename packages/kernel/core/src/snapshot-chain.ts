/**
 * Generic snapshot chain types — immutable DAG for time travel, fork, and recovery.
 *
 * `SnapshotChainStore<T>` is a generic interface for versioned snapshot chains.
 * It supports linear history, branching (DAG with `parentIds[]`), ancestor
 * walking, and pruning. Reusable for agents (via AgentSnapshot) and bricks.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __chainIdBrand: unique symbol;

/** Branded string for chain identity. Each chain is an independent snapshot sequence. */
export type ChainId = string & { readonly [__chainIdBrand]: "ChainId" };

/** Create a ChainId from a raw string. */
export function chainId(raw: string): ChainId {
  return raw as ChainId;
}

declare const __nodeIdBrand: unique symbol;

/** Branded string for node identity. Each node is a unique snapshot in the DAG. */
export type NodeId = string & { readonly [__nodeIdBrand]: "NodeId" };

/** Create a NodeId from a raw string. */
export function nodeId(raw: string): NodeId {
  return raw as NodeId;
}

// ---------------------------------------------------------------------------
// Snapshot node — immutable DAG node
// ---------------------------------------------------------------------------

/** An immutable node in a snapshot chain DAG. */
export interface SnapshotNode<T> {
  /** Unique identifier for this node. */
  readonly nodeId: NodeId;
  /** The chain this node belongs to. */
  readonly chainId: ChainId;
  /** Parent node IDs. Empty = root, one = linear, many = merge. */
  readonly parentIds: readonly NodeId[];
  /** Content hash for deduplication (skip-if-unchanged). */
  readonly contentHash: string;
  /** The snapshot payload. */
  readonly data: T;
  /** Unix timestamp ms when this node was created. */
  readonly createdAt: number;
  /** Arbitrary metadata (e.g., trigger reason, actor). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Fork reference — lightweight pointer to a branch point
// ---------------------------------------------------------------------------

/** Pointer from a forked chain back to its source node. */
export interface ForkRef {
  /** The node in the source chain that was forked from. */
  readonly parentNodeId: NodeId;
  /** Human-readable label for the fork (e.g., "experiment-a"). */
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Query / options types
// ---------------------------------------------------------------------------

/** Parameters for ancestor walking. */
export interface AncestorQuery {
  /** Node to start walking from. */
  readonly startNodeId: NodeId;
  /** Maximum depth to walk (undefined = walk to root). */
  readonly maxDepth?: number;
}

/** Policy for pruning old snapshots from a chain. */
export interface PruningPolicy {
  /** Maximum number of nodes to retain. */
  readonly retainCount?: number;
  /** Maximum age in ms. Nodes older than `Date.now() - retainDuration` are pruned. */
  readonly retainDuration?: number;
  /** If true, protect branch head nodes from pruning. Default: true. */
  readonly retainBranches?: boolean;
}

/** Options for the `put` operation. */
export interface PutOptions {
  /** If true, skip the write when contentHash matches the current head. */
  readonly skipIfUnchanged?: boolean;
}

// ---------------------------------------------------------------------------
// Chain compactor — optional summarization strategy
// ---------------------------------------------------------------------------

/**
 * Optional strategy for compacting a chain by summarizing old nodes.
 * Future use — not required for v1.
 */
export interface ChainCompactor<T> {
  /** Summarize a sequence of nodes into a single compacted node. */
  readonly compact: (nodes: readonly SnapshotNode<T>[]) => T;
}

// ---------------------------------------------------------------------------
// SnapshotChainStore<T> — the core interface
// ---------------------------------------------------------------------------

/**
 * Generic snapshot chain store supporting DAG topology, content-hash dedup,
 * ancestor walking, forking, and pruning.
 *
 * All fallible operations return `Result<T, KoiError> | Promise<Result<T, KoiError>>`
 * so implementations can be sync (in-memory) or async (SQLite/network).
 */
export interface SnapshotChainStore<T> {
  /**
   * Append a new snapshot node to a chain.
   *
   * @param chainId - Target chain. Created implicitly if it doesn't exist.
   * @param data - The snapshot payload.
   * @param parentIds - Parent node IDs. Empty for root nodes.
   * @param metadata - Optional metadata for this node.
   * @param options - Put options (e.g., skipIfUnchanged).
   * @returns The created node, or undefined if skipped due to unchanged content.
   */
  readonly put: (
    chainId: ChainId,
    data: T,
    parentIds: readonly NodeId[],
    metadata?: Readonly<Record<string, unknown>>,
    options?: PutOptions,
  ) =>
    | Result<SnapshotNode<T> | undefined, KoiError>
    | Promise<Result<SnapshotNode<T> | undefined, KoiError>>;

  /** Retrieve a single node by ID. */
  readonly get: (
    nodeId: NodeId,
  ) => Result<SnapshotNode<T>, KoiError> | Promise<Result<SnapshotNode<T>, KoiError>>;

  /** Get the current head (most recent node) of a chain. Undefined if chain is empty. */
  readonly head: (
    chainId: ChainId,
  ) =>
    | Result<SnapshotNode<T> | undefined, KoiError>
    | Promise<Result<SnapshotNode<T> | undefined, KoiError>>;

  /** List all nodes in a chain, newest first. */
  readonly list: (
    chainId: ChainId,
  ) =>
    | Result<readonly SnapshotNode<T>[], KoiError>
    | Promise<Result<readonly SnapshotNode<T>[], KoiError>>;

  /** Walk ancestors from a start node, optionally limited by depth. */
  readonly ancestors: (
    query: AncestorQuery,
  ) =>
    | Result<readonly SnapshotNode<T>[], KoiError>
    | Promise<Result<readonly SnapshotNode<T>[], KoiError>>;

  /**
   * Create a new chain forked from a node in an existing chain.
   * Returns a ForkRef describing the branch point.
   */
  readonly fork: (
    sourceNodeId: NodeId,
    newChainId: ChainId,
    label: string,
  ) => Result<ForkRef, KoiError> | Promise<Result<ForkRef, KoiError>>;

  /** Prune nodes from a chain according to a policy. Returns the number of nodes removed. */
  readonly prune: (
    chainId: ChainId,
    policy: PruningPolicy,
  ) => Result<number, KoiError> | Promise<Result<number, KoiError>>;

  /** Close the store and release resources. */
  readonly close: () => void | Promise<void>;
}
