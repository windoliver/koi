/**
 * Delivery policy resolution and application (Decision 5, 8, 16).
 *
 * Wraps a SpawnChildResult with a delivery-aware consumption strategy:
 * - streaming: zero overhead, caller iterates runtime.run() directly
 * - deferred: consumes child stream in background, pushes final output to parent inbox
 * - on_demand: consumes child stream in background, writes RunReport to ReportStore
 */

import type {
  AgentId,
  DeliveryPolicy,
  EngineEvent,
  EngineInput,
  EngineOutput,
  InboxComponent,
  InboxItem,
  InboxMode,
  ReportStore,
  RunReport,
} from "@koi/core";
import { DEFAULT_DELIVERY_POLICY, runId, sessionId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { SpawnChildResult } from "./types.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve effective delivery policy: spawn option > manifest > streaming default.
 */
export function resolveDeliveryPolicy(
  spawnDelivery: DeliveryPolicy | undefined,
  manifestDelivery: DeliveryPolicy | undefined,
): DeliveryPolicy {
  if (spawnDelivery !== undefined) return spawnDelivery;
  if (manifestDelivery !== undefined) return manifestDelivery;
  return DEFAULT_DELIVERY_POLICY;
}

// ---------------------------------------------------------------------------
// Application config & handle
// ---------------------------------------------------------------------------

export interface ApplyDeliveryPolicyConfig {
  readonly spawnResult: SpawnChildResult;
  readonly policy: DeliveryPolicy;
  readonly parentInbox?: InboxComponent | undefined;
  readonly reportStore?: ReportStore | undefined;
  readonly parentAgentId?: AgentId | undefined;
}

export interface DeliveryHandle {
  readonly spawnResult: SpawnChildResult;
  /**
   * For deferred/on_demand: call this instead of iterating runtime.run().
   * Consumes the child stream in background, delivers result per policy.
   * For streaming: undefined (caller uses runtime.run() directly).
   */
  readonly runChild?: (input: EngineInput) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from EngineOutput content blocks.
 * Returns empty string if no text blocks found.
 */
function extractOutputText(output: EngineOutput): string {
  const texts: string[] = [];
  for (const block of output.content) {
    if (block.kind === "text") {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/**
 * Consume an async iterable of EngineEvents, returning the done event's output.
 * Accumulates text_delta and tool_result output as a fallback so output is not
 * lost when the final done.output.content is empty (matches createTextCollector logic).
 * Throws if no done event is received (stream ended prematurely).
 */
async function consumeStream(stream: AsyncIterable<EngineEvent>): Promise<EngineOutput> {
  let output: EngineOutput | undefined; // let: assigned inside for-await loop
  let textBuffer = ""; // let: accumulated text_delta fallback
  let lastToolResult = ""; // let: last tool_result / tool_call_end fallback
  for await (const event of stream) {
    if (event.kind === "text_delta") {
      textBuffer += event.delta;
    } else if (event.kind === "tool_result") {
      // Prefer tool_result (carries real execution output).
      const result = event.output;
      if (typeof result === "string") {
        lastToolResult = result;
      } else if (typeof result === "object" && result !== null) {
        lastToolResult = JSON.stringify(result);
      }
    } else if (event.kind === "tool_call_end") {
      // Legacy fallback: engine streams that haven't migrated to tool_result.
      const result = event.result;
      if (typeof result === "string") {
        lastToolResult = result;
      } else if (typeof result === "object" && result !== null) {
        lastToolResult = JSON.stringify(result);
      }
    } else if (event.kind === "done") {
      output = event.output;
    }
  }
  if (output === undefined) {
    throw KoiRuntimeError.from(
      "INTERNAL",
      "Child stream ended without a done event — delivery policy cannot extract output",
    );
  }
  // If done.output.content is empty, inject the accumulated incremental output.
  // This matches createTextCollector's fallback logic for batch-output engines.
  if (output.content.length === 0 && (textBuffer.length > 0 || lastToolResult.length > 0)) {
    const accumulated = textBuffer.length > 0 ? textBuffer : lastToolResult;
    return {
      ...output,
      content: [{ kind: "text", text: accumulated }],
    };
  }
  return output;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply delivery policy as a post-spawn wrapper.
 *
 * - streaming: early return, zero overhead (Decision 16)
 * - deferred: returns runChild() that consumes events & pushes to inbox
 * - on_demand: returns runChild() that consumes events & writes RunReport
 */
export function applyDeliveryPolicy(config: ApplyDeliveryPolicyConfig): DeliveryHandle {
  const { policy, spawnResult } = config;

  // Hot path: streaming = no wrapper (Decision 16)
  if (policy.kind === "streaming") {
    return { spawnResult };
  }

  if (policy.kind === "deferred") {
    return {
      spawnResult,
      runChild: async (input: EngineInput): Promise<void> => {
        const stream = spawnResult.runtime.run(input);
        let output: EngineOutput; // let: assigned in try block
        try {
          output = await consumeStream(stream);
        } catch (e: unknown) {
          if (e instanceof KoiRuntimeError) throw e;
          throw new Error("Deferred delivery: child stream error", { cause: e });
        }

        const text = extractOutputText(output);
        const inbox = config.parentInbox;
        if (inbox === undefined) return;

        const mode: InboxMode =
          policy.kind === "deferred" && policy.inboxMode !== undefined
            ? policy.inboxMode
            : "collect";

        const item: InboxItem = {
          id: `delivery-${spawnResult.childPid.id}-${Date.now()}`,
          from: spawnResult.childPid.id,
          mode,
          content: text,
          priority: 0,
          createdAt: Date.now(),
        };

        const accepted = inbox.push(item);
        if (!accepted) {
          // Treat inbox rejection as a hard delivery failure. The child ran successfully
          // but its output cannot be delivered — throwing here causes createAgentSpawnFn's
          // background task to catch it and push an error item to the parent inbox so the
          // caller can observe the failure rather than silently losing the result.
          throw KoiRuntimeError.from(
            "INTERNAL",
            `Deferred delivery: parent inbox at capacity, child output lost for agent ${spawnResult.childPid.id}`,
            { retryable: false, context: { childId: spawnResult.childPid.id } },
          );
        }
      },
    };
  }

  // on_demand
  return {
    spawnResult,
    runChild: async (input: EngineInput): Promise<void> => {
      const startedAt = Date.now();
      const stream = spawnResult.runtime.run(input);
      let output: EngineOutput; // let: assigned in try block
      try {
        output = await consumeStream(stream);
      } catch (e: unknown) {
        if (e instanceof KoiRuntimeError) throw e;
        throw new Error("On-demand delivery: child stream error", { cause: e });
      }

      const store = config.reportStore;
      if (store === undefined) return;

      const text = extractOutputText(output);
      const childId = spawnResult.childPid.id;

      const report: RunReport = {
        agentId: childId,
        sessionId: sessionId(`delivery-${childId}`),
        runId: runId(`delivery-${childId}-${Date.now()}`),
        summary: text,
        duration: {
          startedAt,
          completedAt: Date.now(),
          durationMs: output.metrics.durationMs,
          totalTurns: output.metrics.turns,
          totalActions: 0,
          truncated: false,
        },
        actions: [],
        artifacts: [],
        issues: [],
        cost: {
          inputTokens: output.metrics.inputTokens,
          outputTokens: output.metrics.outputTokens,
          totalTokens: output.metrics.totalTokens,
          ...(output.metrics.costUsd !== undefined
            ? { estimatedCostUsd: output.metrics.costUsd }
            : {}),
        },
        recommendations: [],
      };

      try {
        await store.put(report);
      } catch (e: unknown) {
        throw new Error("On-demand delivery: ReportStore.put() failed", { cause: e });
      }
    },
  };
}
