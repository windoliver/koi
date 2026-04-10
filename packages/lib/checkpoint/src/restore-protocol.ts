/**
 * Restore protocol — the four-step ordered+idempotent flow that rewinds a
 * session by N turns.
 *
 * Steps (per #1625 design review issue 3A):
 *
 *   1. Walk N steps back through the chain → identify target SnapshotNode
 *   2. Compute compensating ops from FileOpRecord[] between target and head
 *   3. Apply compensating ops to filesystem
 *      (CAS writes are no-ops on hash match; deletes are idempotent)
 *   4. Put a new "rewind marker" snapshot whose parent is the target —
 *      this becomes the new chain head, while the intermediate snapshots
 *      remain in the DAG history (audit trail).
 *
 * Conversation log truncation is NOT in this protocol. The checkpoint
 * package only rewinds file state; the conversation log is owned by
 * @koi/session and integration is a follow-up PR.
 *
 * Crash safety: every step is idempotent. Re-running `restore` after a
 * partial failure converges on the target state because:
 *   - CAS writes are content-addressed (writing the same hash twice is a no-op)
 *   - File deletes are naturally idempotent (missing file = desired state)
 *   - The atomic tmp+rename in step 3 means partially-written files never
 *     surface
 *   - Step 4 creates a NEW snapshot rather than mutating; if it fails on
 *     retry the file system is still consistent with the target state
 */

import type {
  ChainId,
  KoiError,
  NodeId,
  Result,
  SessionId,
  SessionTranscript,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";
import { internal, notFound, validation } from "@koi/core";
import { applyCompensatingOps, computeCompensatingOps } from "./compensating-ops.js";
import type { CheckpointPayload, RewindResult } from "./types.js";

/**
 * Inputs to a restore operation. Either `n` (number of turns to rewind)
 * or an explicit `targetNodeId`. Exactly one must be provided.
 */
export type RestoreTarget =
  | { readonly kind: "by-count"; readonly n: number }
  | { readonly kind: "by-node"; readonly targetNodeId: NodeId };

export interface RestoreInput {
  readonly store: SnapshotChainStore<CheckpointPayload>;
  readonly chainId: ChainId;
  readonly blobDir: string;
  readonly target: RestoreTarget;
  /**
   * Optional `SessionTranscript` for conversation log truncation. If
   * provided AND the target snapshot carries a `transcriptEntryCount`,
   * the protocol calls `transcript.truncate(sessionId, count)` between
   * the file-restore step and the chain-marker step.
   *
   * Pass `undefined` to skip transcript truncation entirely (file state
   * is still restored).
   */
  readonly transcript?: SessionTranscript;
  /** Session ID — required when `transcript` is provided. */
  readonly sessionId?: SessionId;
}

/**
 * Run the four-step restore protocol. Returns a `RewindResult` that the
 * caller can return verbatim from `Checkpoint.rewind`.
 *
 * Errors at any step are mapped to `{ok: false}` rather than thrown — this
 * matches the L0 `Result<T, E>` pattern and lets the caller decide whether
 * to retry, surface the error, or both.
 */
export async function runRestore(input: RestoreInput): Promise<RewindResult> {
  const { store, chainId, blobDir, target, transcript, sessionId } = input;

  // ---- Step 1: locate the current head and walk to the target ----
  const headResult = await store.head(chainId);
  if (!headResult.ok) {
    return { ok: false, error: headResult.error };
  }
  if (headResult.value === undefined) {
    return {
      ok: false,
      error: notFound(chainId, "Cannot rewind: chain has no snapshots yet"),
    };
  }
  const currentHead = headResult.value;

  const targetResult = await locateTarget(store, currentHead, target);
  if (!targetResult.ok) {
    return { ok: false, error: targetResult.error };
  }
  const { targetNode, snapshotsToUndo, turnsRewound } = targetResult.value;

  // Rewinding zero turns is a no-op success — the head doesn't change.
  if (turnsRewound === 0) {
    return {
      ok: true,
      newHeadNodeId: currentHead.nodeId,
      targetNodeId: targetNode.nodeId,
      opsApplied: 0,
      turnsRewound: 0,
      driftWarnings: [],
    };
  }

  // ---- Step 2: compute compensating ops ----
  const ops = computeCompensatingOps(snapshotsToUndo);

  // ---- Step 3: apply ops to the filesystem ----
  const applyResults = await applyCompensatingOps(ops, blobDir);

  // Surface the first hard error (missing blob, write failure, etc).
  // Idempotent skips are not errors.
  let opsApplied = 0;
  for (const r of applyResults) {
    switch (r.kind) {
      case "applied":
      case "skipped-already-current":
        opsApplied += 1;
        break;
      case "skipped-missing-blob":
        return {
          ok: false,
          error: internal(
            `Restore failed: missing blob ${r.contentHash} for ${r.path} (CAS GC may have removed it)`,
          ),
        };
      case "error":
        return {
          ok: false,
          error: internal(`Restore failed at ${r.path}`, r.cause),
        };
    }
  }

  // ---- Step 3b: truncate the conversation transcript (if wired) ----
  // Runs AFTER file restore and BEFORE the chain marker write so that a
  // failure here leaves the chain head unchanged — the user can re-run
  // rewind and converge. The truncate is itself idempotent (truncating to
  // a count <= existing length is safe to repeat).
  if (transcript !== undefined && sessionId !== undefined) {
    const targetCount = targetNode.data.transcriptEntryCount;
    if (targetCount !== undefined) {
      const truncResult = await transcript.truncate(sessionId, targetCount);
      if (!truncResult.ok) {
        return {
          ok: false,
          error: internal(
            `Restore failed: conversation log truncate to ${targetCount} entries failed`,
            truncResult.error,
          ),
        };
      }
    }
  }

  // ---- Step 4: write the rewind marker as a new chain head ----
  // The marker inherits the target's userTurnIndex so the chain's
  // user-turn counter stays consistent after rewind: the next captured
  // turn resumes counting from here, not from where the head was before.
  const markerPayload: CheckpointPayload =
    targetNode.data.transcriptEntryCount !== undefined
      ? {
          turnIndex: targetNode.data.turnIndex,
          userTurnIndex: targetNode.data.userTurnIndex,
          sessionId: targetNode.data.sessionId,
          fileOps: [],
          driftWarnings: [],
          transcriptEntryCount: targetNode.data.transcriptEntryCount,
          capturedAt: Date.now(),
        }
      : {
          turnIndex: targetNode.data.turnIndex,
          userTurnIndex: targetNode.data.userTurnIndex,
          sessionId: targetNode.data.sessionId,
          fileOps: [],
          driftWarnings: [],
          capturedAt: Date.now(),
        };
  const markerMetadata: Readonly<Record<string, unknown>> = {
    "koi:snapshot_status": "complete",
    "koi:rewind_target": targetNode.nodeId,
    "koi:rewind_turns": turnsRewound,
  };
  const markerResult = await store.put(chainId, markerPayload, [targetNode.nodeId], markerMetadata);
  if (!markerResult.ok) {
    return { ok: false, error: markerResult.error };
  }
  if (markerResult.value === undefined) {
    // skipIfUnchanged matched (we don't pass that option, but be defensive).
    return {
      ok: false,
      error: internal("Restore failed: chain store returned undefined from put"),
    };
  }

  // Surface drift warnings from the target snapshot. The user needs to know
  // which paths the rewind cannot restore (bash-mediated changes, etc.) so
  // they can manually reconcile if necessary.
  return {
    ok: true,
    newHeadNodeId: markerResult.value.nodeId,
    targetNodeId: targetNode.nodeId,
    opsApplied,
    turnsRewound,
    driftWarnings: targetNode.data.driftWarnings,
  };
}

interface LocateResult {
  /** The snapshot the rewind lands on. */
  readonly targetNode: SnapshotNode<CheckpointPayload>;
  /** Snapshots between current head and target (inclusive of head, exclusive of target). */
  readonly snapshotsToUndo: readonly SnapshotNode<CheckpointPayload>[];
  /** Number of turns rewound past — `snapshotsToUndo.length`. */
  readonly turnsRewound: number;
}

async function locateTarget(
  store: SnapshotChainStore<CheckpointPayload>,
  currentHead: SnapshotNode<CheckpointPayload>,
  target: RestoreTarget,
): Promise<Result<LocateResult, KoiError>> {
  // Walk the full ancestor chain. For by-count we can't cap depth to `n`
  // anymore because `n` now counts USER turns, not engine turns — a user
  // turn may span multiple ancestors, so the walk depth isn't predictable
  // from n alone. We walk everything and filter by userTurnIndex.
  const ancestorsResult = await store.ancestors({ startNodeId: currentHead.nodeId });
  if (!ancestorsResult.ok) {
    return { ok: false, error: ancestorsResult.error };
  }
  const ancestors = ancestorsResult.value;
  // ancestors[0] is the start node (current head); ancestors[i] is i steps
  // back from head. The CTE returns nodes ordered by depth ASC.

  if (target.kind === "by-count") {
    if (target.n < 0) {
      return { ok: false, error: validation(`rewind count must be >= 0, got ${target.n}`) };
    }
    if (target.n === 0) {
      // Zero-rewind: target IS current head, nothing to undo.
      return {
        ok: true,
        value: { targetNode: currentHead, snapshotsToUndo: [], turnsRewound: 0 },
      };
    }

    // N counts USER turns, not engine turns. From the head's userTurnIndex,
    // find the snapshot whose userTurnIndex equals (headUserTurn - n). A
    // user prompt with tool calls produces multiple engine turns sharing
    // the same userTurnIndex, so `/rewind 1` here undoes the entire
    // prompt — both the tool-call turn and the post-tool summary turn —
    // which is the user-facing semantic.
    const headUserTurn = currentHead.data.userTurnIndex;
    const targetUserTurn = headUserTurn - target.n;

    if (targetUserTurn < 0) {
      // Past the bootstrap (which has userTurnIndex 0) — that's more
      // prompts than exist in the chain.
      return {
        ok: false,
        error: validation(
          `Cannot rewind ${target.n} user turn(s): chain has only ${headUserTurn} user prompt(s) above the bootstrap`,
        ),
      };
    }

    // Walk from head (ancestors[0]) toward the root, finding the FIRST
    // ancestor whose userTurnIndex is <= targetUserTurn. That ancestor is
    // the newest snapshot belonging to the target user turn — land there.
    let targetIdx = -1;
    for (let i = 0; i < ancestors.length; i++) {
      const ui = ancestors[i]?.data.userTurnIndex ?? 0;
      if (ui <= targetUserTurn) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < 0) {
      // No snapshot with a low-enough userTurnIndex — either the chain is
      // corrupt or userTurnIndex values are inconsistent. Treat as validation.
      return {
        ok: false,
        error: validation(
          `Cannot rewind ${target.n} user turn(s): no ancestor with userTurnIndex <= ${targetUserTurn}`,
        ),
      };
    }

    const targetNode = ancestors[targetIdx];
    if (targetNode === undefined) {
      return { ok: false, error: internal("ancestor walk returned undefined entry") };
    }
    const snapshotsToUndo = ancestors.slice(0, targetIdx);
    return {
      ok: true,
      value: { targetNode, snapshotsToUndo, turnsRewound: target.n },
    };
  }

  // by-node: scan the ancestors list for the requested nodeId.
  const idx = ancestors.findIndex((n) => n.nodeId === target.targetNodeId);
  if (idx < 0) {
    return {
      ok: false,
      error: notFound(
        target.targetNodeId,
        `Target node ${target.targetNodeId} not found in chain history`,
      ),
    };
  }
  const targetNode = ancestors[idx];
  if (targetNode === undefined) {
    return { ok: false, error: internal("ancestor walk returned undefined at found index") };
  }
  return {
    ok: true,
    value: {
      targetNode,
      snapshotsToUndo: ancestors.slice(0, idx),
      turnsRewound: idx,
    },
  };
}
