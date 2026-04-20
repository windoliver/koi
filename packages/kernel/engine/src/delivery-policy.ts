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
  IssueEntry,
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
 * Accumulates text_delta and tool_call_end results as a fallback so output is not
 * lost when the final done.output.content is empty (matches createTextCollector logic).
 * Throws if no done event is received (stream ended prematurely).
 *
 * #1638: when the terminal done is a synthesized activity-timeout abort, the
 * content is empty and the failure only lives in `output.metadata`. A
 * deferred/on-demand child delivery must not represent that as an empty
 * success — fold the termination metadata into a non-empty content block so
 * the inbox item / RunReport captures the failure signal.
 */
async function consumeStream(stream: AsyncIterable<EngineEvent>): Promise<EngineOutput> {
  let output: EngineOutput | undefined; // let: assigned inside for-await loop
  let textBuffer = ""; // let: accumulated text_delta fallback
  let lastToolResult = ""; // let: last tool_call_end fallback
  for await (const event of stream) {
    if (event.kind === "text_delta") {
      textBuffer += event.delta;
    } else if (event.kind === "tool_call_end") {
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
  // Preserve activity-timeout provenance when content is empty (#1638).
  // Without this, a timed-out child appears as a blank completion in the
  // parent inbox / RunReport, masking the failure operators need to see.
  if (output.content.length === 0 && output.metadata?.terminatedBy === "activity-timeout") {
    const reason = output.metadata.terminationReason ?? "unknown";
    const elapsedMs = output.metadata.elapsedMs ?? 0;
    const message =
      textBuffer.length > 0
        ? `${textBuffer}\n\n[Delivery failed: activity-timeout (${reason}) after ${elapsedMs}ms]`
        : `[Delivery failed: activity-timeout (${reason}) after ${elapsedMs}ms]`;
    return { ...output, content: [{ kind: "text", text: message }] };
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
        // #1742 loop-2 round 6: runtime.run() can now throw synchronously
        // (poisoned, disposed, lifecycleInFlight, already-running). Wrap
        // the construction in the same try block as stream consumption so
        // the existing structured error path runs in either case.
        let output: EngineOutput; // let: assigned in try block
        try {
          const stream = spawnResult.runtime.run(input);
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
      // #1742 loop-2 round 6: runtime.run() can throw synchronously now;
      // construct inside the try so synchronous rejection is translated
      // to the same structured delivery error the caller already handles.
      let output: EngineOutput; // let: assigned in try block
      try {
        const stream = spawnResult.runtime.run(input);
        output = await consumeStream(stream);
      } catch (e: unknown) {
        if (e instanceof KoiRuntimeError) throw e;
        throw new Error("On-demand delivery: child stream error", { cause: e });
      }

      const store = config.reportStore;
      if (store === undefined) return;

      const text = extractOutputText(output);
      const childId = spawnResult.childPid.id;

      // Propagate activity-timeout provenance into structured RunReport
      // fields (#1638). Consumers like the TUI summarize reports via
      // `issues` / `duration.truncated` / `cost` counts, not via the free
      // summary text — if we left `truncated: false` and `issues: []`, a
      // timed-out child would appear as a structurally clean run.
      const isTimeout = output.metadata?.terminatedBy === "activity-timeout";
      const timeoutIssues: readonly IssueEntry[] = isTimeout
        ? [
            {
              severity: "critical" as const,
              message: `Run interrupted by activity-timeout (${output.metadata?.terminationReason ?? "unknown"}) after ${output.metadata?.elapsedMs ?? 0}ms`,
              turnIndex:
                typeof output.metadata?.lastSeenTurnIndex === "number"
                  ? Math.max(output.metadata.lastSeenTurnIndex, 0)
                  : 0,
              resolved: false,
            },
          ]
        : [];

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
          truncated: isTimeout,
        },
        actions: [],
        artifacts: [],
        issues: timeoutIssues,
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
