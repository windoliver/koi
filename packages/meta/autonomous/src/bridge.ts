/**
 * Harness → Handoff bridge factory.
 *
 * Reads the final HarnessSnapshot from the snapshot chain store,
 * maps it to a HandoffEnvelope, and stores it for the receiving agent.
 * Idempotent: calling onHarnessCompleted() multiple times returns the same result.
 */

import type { ChainId, HandoffId, KoiError, Result } from "@koi/core";
import { chainId } from "@koi/core";
import type { LongRunningHarness } from "@koi/long-running";
import { mapSnapshotToEnvelope } from "./map-snapshot.js";
import type { HarnessHandoffBridge, HarnessHandoffBridgeConfig } from "./types.js";

/**
 * Create a harness-to-handoff bridge.
 *
 * The bridge reads the harness snapshot on demand (when onHarnessCompleted is called),
 * maps it to a HandoffEnvelope, and stores it in the handoff store.
 *
 * Exactly one of `targetAgentId` or `resolveTarget` must be provided.
 */
export function createHarnessHandoffBridge(
  harness: LongRunningHarness,
  config: HarnessHandoffBridgeConfig,
): HarnessHandoffBridge {
  const hasStatic = config.targetAgentId !== undefined;
  const hasDynamic = config.resolveTarget !== undefined;
  if (hasStatic && hasDynamic) {
    throw new Error("HarnessHandoffBridgeConfig: provide targetAgentId OR resolveTarget, not both");
  }
  if (!hasStatic && !hasDynamic) {
    throw new Error(
      "HarnessHandoffBridgeConfig: one of targetAgentId or resolveTarget is required",
    );
  }
  // let justified: mutable idempotency state — tracks whether the bridge has already fired
  let fired = false;
  let cachedResult: Result<HandoffId, KoiError> | undefined;

  const harnessChainId: ChainId = chainId(harness.harnessId);

  const onHarnessCompleted = async (): Promise<Result<HandoffId, KoiError>> => {
    // Idempotent: return cached result if already fired
    if (fired && cachedResult !== undefined) {
      return cachedResult;
    }

    // Read the latest snapshot from the harness store
    const headResult = await config.harnessStore.head(harnessChainId);
    if (!headResult.ok) {
      const error: KoiError = {
        code: "NOT_FOUND",
        message: `Failed to read harness snapshot: ${headResult.error.message}`,
        retryable: false,
        context: { harnessId: harness.harnessId },
      };
      return { ok: false, error };
    }

    const node = headResult.value;
    if (node === undefined) {
      const error: KoiError = {
        code: "NOT_FOUND",
        message: "No harness snapshot found — harness may not have started",
        retryable: false,
        context: { harnessId: harness.harnessId },
      };
      return { ok: false, error };
    }

    const snapshot = node.data;
    if (snapshot.phase !== "completed") {
      const error: KoiError = {
        code: "VALIDATION",
        message: `Harness phase is "${snapshot.phase}", expected "completed"`,
        retryable: false,
        context: { harnessId: harness.harnessId, phase: snapshot.phase },
      };
      return { ok: false, error };
    }

    // Resolve target agent ID — static or dynamic
    // Safety: constructor validation guarantees exactly one of these is defined
    let targetAgentId = config.targetAgentId; // let justified: may be reassigned from resolveTarget
    if (targetAgentId === undefined && config.resolveTarget !== undefined) {
      try {
        targetAgentId = await config.resolveTarget(snapshot);
      } catch (e: unknown) {
        const error: KoiError = {
          code: "VALIDATION",
          message: e instanceof Error ? e.message : "resolveTarget threw an unexpected error",
          retryable: false,
          context: { harnessId: harness.harnessId },
        };
        return { ok: false, error };
      }
    }

    if (targetAgentId === undefined) {
      const error: KoiError = {
        code: "VALIDATION",
        message: "resolveTarget returned undefined — could not determine target agent",
        retryable: false,
        context: { harnessId: harness.harnessId },
      };
      return { ok: false, error };
    }

    // Map snapshot to envelope
    const envelope = mapSnapshotToEnvelope(snapshot, targetAgentId, config.nextPhaseInstructions);

    // Store envelope
    const putResult = await config.handoffStore.put(envelope);
    if (!putResult.ok) {
      const error: KoiError = {
        code: "INTERNAL",
        message: `Failed to store handoff envelope: ${putResult.error.message}`,
        retryable: false,
        context: { harnessId: harness.harnessId, handoffId: envelope.id },
      };
      return { ok: false, error };
    }

    // Mark as fired and cache the result
    fired = true;
    const handoffId: HandoffId = envelope.id;
    cachedResult = { ok: true, value: handoffId };

    // Fire event callback
    config.onEvent?.({ kind: "handoff:prepared", envelope });

    return cachedResult;
  };

  const hasFired = (): boolean => fired;

  return { onHarnessCompleted, hasFired };
}
