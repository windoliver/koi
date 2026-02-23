/**
 * Walks the snapshot chain from head to target node and applies compensating ops.
 */

import type {
  ChainId,
  FileOpRecord,
  FileSystemBackend,
  KoiError,
  NodeId,
  Result,
  SnapshotChainStore,
} from "@koi/core";
import { internal, notFound } from "@koi/core";
import { computeCompensatingOps } from "./compensate.js";

/**
 * Rolls back filesystem changes from the current head to a target node.
 * Walks the snapshot chain, collects FileOpRecords between head and target,
 * computes compensating ops, and applies them via the backend.
 * Returns the number of filesystem operations applied.
 *
 * Limitation: files created during the rolled-back period (previousContent=undefined)
 * are skipped because FileSystemBackend has no delete method. Best-effort per file.
 */
export async function rollbackTo(
  store: SnapshotChainStore<FileOpRecord>,
  chainId: ChainId,
  targetNodeId: NodeId,
  backend: FileSystemBackend,
): Promise<Result<number, KoiError>> {
  // 1. Get current head
  const headResult = await store.head(chainId);
  if (!headResult.ok) {
    return headResult;
  }
  if (headResult.value === undefined) {
    return {
      ok: false,
      error: notFound(chainId, "Chain has no head node"),
    };
  }

  const headNode = headResult.value;

  // 2. Walk ancestors from head
  const ancestorsResult = await store.ancestors({
    startNodeId: headNode.nodeId,
  });
  if (!ancestorsResult.ok) {
    return ancestorsResult;
  }

  // 3. Collect nodes between head and target (exclusive of target)
  const nodesToUndo: FileOpRecord[] = [];
  let foundTarget = false;

  for (const node of ancestorsResult.value) {
    if (node.nodeId === targetNodeId) {
      foundTarget = true;
      break;
    }
    nodesToUndo.push(node.data);
  }

  if (!foundTarget) {
    return {
      ok: false,
      error: notFound(targetNodeId, `Target node ${targetNodeId} not found in chain ancestors`),
    };
  }

  // 4. Compute compensating ops (records are already newest-first from ancestors)
  const ops = computeCompensatingOps(nodesToUndo);

  // 5. Apply compensating ops
  let appliedCount = 0;

  for (const op of ops) {
    switch (op.kind) {
      case "restore": {
        const writeResult = await backend.write(op.path, op.content);
        if (!writeResult.ok) {
          return {
            ok: false,
            error: internal(
              `Failed to restore file ${op.path}: ${writeResult.error.message}`,
              writeResult.error,
            ),
          };
        }
        appliedCount += 1;
        break;
      }
      case "delete":
        // FileSystemBackend has no delete method — skip (best-effort rollback).
        // The file was created during the tool call and didn't exist before.
        break;
      default: {
        const _exhaustive: never = op;
        throw new Error(`Unhandled compensating op kind: ${String(_exhaustive)}`);
      }
    }
  }

  return { ok: true, value: appliedCount };
}
