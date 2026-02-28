/**
 * Squash tool factory — creates a Tool that compresses conversation history
 * at agent-initiated phase boundaries.
 *
 * Flow:
 * 1. Validate args (phase, summary, optional facts)
 * 2. Partition messages into pinned + squashable
 * 3. Split squashable into head (to archive) + tail (to preserve)
 * 4. Archive head messages to SnapshotChainStore
 * 5. Extract facts to memory (best-effort)
 * 6. Queue CompactionResult for the companion middleware
 * 7. Return structured metrics
 */

import { chainId } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { Tool, ToolExecuteOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { PendingQueue, ResolvedSquashConfig, SquashResult } from "./types.js";
import { SQUASH_TOOL_DESCRIPTOR } from "./types.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedArgs {
  readonly phase: string;
  readonly summary: string;
  readonly facts: readonly string[];
}

function validateArgs(
  args: JsonObject,
):
  | { readonly ok: true; readonly value: ValidatedArgs }
  | { readonly ok: false; readonly result: SquashResult } {
  const phase: unknown = args.phase;
  const summary: unknown = args.summary;
  const facts: unknown = args.facts;

  if (typeof phase !== "string" || phase.length === 0) {
    return {
      ok: false,
      result: { ok: false, error: "Missing or empty 'phase' string", code: "VALIDATION" },
    };
  }

  if (typeof summary !== "string" || summary.length === 0) {
    return {
      ok: false,
      result: { ok: false, error: "Missing or empty 'summary' string", code: "VALIDATION" },
    };
  }

  if (facts !== undefined && facts !== null) {
    if (!Array.isArray(facts) || !facts.every((f): f is string => typeof f === "string")) {
      return {
        ok: false,
        result: { ok: false, error: "'facts' must be an array of strings", code: "VALIDATION" },
      };
    }
    return { ok: true, value: { phase, summary, facts } };
  }

  return { ok: true, value: { phase, summary, facts: [] } };
}

// ---------------------------------------------------------------------------
// Message partitioning
// ---------------------------------------------------------------------------

interface Partitioned {
  readonly pinned: readonly InboundMessage[];
  readonly squashable: readonly InboundMessage[];
}

function partitionMessages(messages: readonly InboundMessage[]): Partitioned {
  return {
    pinned: messages.filter((msg) => msg.pinned === true),
    squashable: messages.filter((msg) => msg.pinned !== true),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the `squash` tool for agent-initiated phase-boundary compression.
 *
 * @param config - Resolved config with all defaults applied
 * @param pendingQueue - Encapsulated queue shared with the companion middleware
 * @param getMessages - Returns current conversation messages
 */
export function createSquashTool(
  config: ResolvedSquashConfig,
  pendingQueue: PendingQueue,
  getMessages: () => readonly InboundMessage[],
): Tool {
  return {
    descriptor: SQUASH_TOOL_DESCRIPTOR,
    trustTier: "verified",

    async execute(args: JsonObject, options?: ToolExecuteOptions): Promise<SquashResult> {
      // 1. Validate input
      const validation = validateArgs(args);
      if (!validation.ok) {
        return validation.result;
      }
      const { phase, summary, facts } = validation.value;

      // 2. Check abort signal
      if (options?.signal?.aborted === true) {
        return { ok: false, error: "Aborted before execution", code: "ABORTED" };
      }

      // 3. Partition messages
      const messages = getMessages();
      const { pinned, squashable } = partitionMessages(messages);

      // 4. Early exit: not enough messages to squash
      if (squashable.length <= config.preserveRecent) {
        return {
          ok: true,
          phase,
          originalMessages: 0,
          originalTokens: 0,
          compactedTokens: 0,
          archivedNodeId: undefined,
          factsStored: 0,
        };
      }

      // 5. Split: head (to archive) + tail (to preserve)
      const headMessages = squashable.slice(0, -config.preserveRecent);
      const tailMessages = squashable.slice(-config.preserveRecent);

      // 6. Estimate tokens for head
      const originalTokens = await config.tokenEstimator.estimateMessages(headMessages);

      // 7. Archive head messages
      const archiveChainId = chainId(`squash:${config.sessionId}`);
      const headNodeResult = await config.archiver.head(archiveChainId);
      const parentIds =
        headNodeResult.ok && headNodeResult.value !== undefined
          ? [headNodeResult.value.nodeId]
          : [];

      const putResult = await config.archiver.put(
        archiveChainId,
        headMessages,
        parentIds,
        { phase, timestamp: Date.now() },
        { skipIfUnchanged: true },
      );

      if (!putResult.ok) {
        return {
          ok: false,
          error: `Archive failed: ${putResult.error.message}`,
          code: "ARCHIVE_FAILED",
        };
      }

      const archivedNodeId =
        putResult.value !== undefined ? String(putResult.value.nodeId) : undefined;

      // 8. Extract facts (best-effort — failures are silent, tracked via factsStored count)
      // let justified: tracks successful fact storage count
      let factsStored = 0;
      if (config.memory !== undefined && facts.length > 0) {
        for (const fact of facts) {
          try {
            await config.memory.store(fact, {
              category: phase,
              relatedEntities: [config.sessionId],
            });
            factsStored += 1;
          } catch (_e: unknown) {
            // Best-effort: caller sees partial count in factsStored
          }
        }
      }

      // 9. Build summary message
      const summaryMessage: InboundMessage = {
        content: [{ kind: "text", text: summary }],
        senderId: "system:squash",
        timestamp: Date.now(),
        metadata: { squashed: true, phase },
      };

      // 10. Estimate compacted tokens
      const compactedMessages: readonly InboundMessage[] = [
        ...pinned,
        summaryMessage,
        ...tailMessages,
      ];
      const compactedTokens = await config.tokenEstimator.estimateMessages(compactedMessages);

      // 11. Queue overflow guard: drop oldest if at capacity
      pendingQueue.trimTo(config.maxPendingSquashes);

      // 12. Enqueue CompactionResult for the middleware
      pendingQueue.enqueue({
        result: {
          messages: compactedMessages,
          originalTokens,
          compactedTokens,
          strategy: "squash",
        },
      });

      // 13. Return metrics
      return {
        ok: true,
        phase,
        originalMessages: headMessages.length,
        originalTokens,
        compactedTokens,
        archivedNodeId,
        factsStored,
      };
    },
  };
}
