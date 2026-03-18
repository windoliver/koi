/**
 * Push-to-pull bridge: pi Agent.subscribe() (push) → AsyncIterable<EngineEvent> (pull).
 *
 * Uses an AsyncQueue with Promise-based consumer blocking.
 * Maps pi AgentEvent → Koi EngineEvent, filtering out events that have no mapping.
 */

import { toolCallId } from "@koi/core/ecs";
import type { EngineEvent, EngineOutput, EngineStopReason } from "@koi/core/engine";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { StopReason } from "@mariozechner/pi-ai";
import { findToolCallAtContentIndex } from "./content-utils.js";
import type { MetricsAccumulator } from "./metrics.js";

// ---------------------------------------------------------------------------
// AsyncQueue — push/pull bridge
// ---------------------------------------------------------------------------

interface QueueItem<T> {
  readonly value: T;
  readonly done: false;
}

interface QueueEnd {
  readonly done: true;
}

type QueueEntry<T> = QueueItem<T> | QueueEnd;

/**
 * Async queue bridging push producers to pull consumers.
 * Consumers block via Promise when the queue is empty.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: QueueEntry<T>[] = [];
  // Read pointer avoids O(n) Array.shift() — compact periodically to release references
  private readIndex = 0;
  private resolve: ((entry: QueueEntry<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const entry: QueueItem<T> = { value, done: false };
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = undefined;
      r(entry);
    } else {
      this.buffer.push(entry);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const entry: QueueEnd = { done: true };
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = undefined;
      r(entry);
    } else {
      this.buffer.push(entry);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.readIndex < this.buffer.length) {
          const buffered = this.buffer[this.readIndex] as QueueEntry<T>;
          this.readIndex++;
          // Compact buffer periodically to release old references
          if (this.readIndex > 64) {
            this.buffer.splice(0, this.readIndex);
            this.readIndex = 0;
          }
          if (buffered.done) return { done: true, value: undefined };
          return { done: false, value: buffered.value };
        }

        const entry = await new Promise<QueueEntry<T>>((r) => {
          this.resolve = r;
        });

        if (entry.done) return { done: true, value: undefined };
        return { done: false, value: entry.value };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

export function mapStopReason(piReason: StopReason): EngineStopReason {
  switch (piReason) {
    case "stop":
    case "toolUse":
      return "completed";
    case "length":
      return "max_turns";
    case "error":
      return "error";
    case "aborted":
      return "interrupted";
  }
}

// ---------------------------------------------------------------------------
// pi AgentEvent → Koi EngineEvent
// ---------------------------------------------------------------------------

/**
 * Create a subscription handler that maps pi AgentEvents to Koi EngineEvents
 * and pushes them into the provided AsyncQueue.
 *
 * Returns a subscriber function suitable for `piAgent.subscribe()`.
 */
export function createEventSubscriber(
  queue: AsyncQueue<EngineEvent>,
  metrics: MetricsAccumulator,
  toolNameMap?: ReadonlyMap<string, string>,
): (event: AgentEvent) => void {
  /** Reverse-map a sanitized tool name back to the original Koi name. */
  const resolveToolName = (name: string): string => toolNameMap?.get(name) ?? name;
  // Track emitted tool call starts to deduplicate between
  // message_update(toolcall_start) and tool_execution_start events.
  // Cleared on turn_end to prevent unbounded growth.
  const emittedToolCalls = new Set<string>();
  // let justified: turn index increments across subscription lifetime
  let turnIndex = 0;
  // let justified: per-turn guard to prevent double-counting usage when both
  // message_update "done" and turn_end fire for the same turn
  let usageRecordedThisTurn = false;
  // Track error state from turn_end / message_update errors for propagation in agent_end
  // let justified: pi-agent-core sets errorMessage on turn_end messages but the agent_end
  // event only carries final messages — we must track the last error across turns
  let lastStopReason: EngineStopReason = "completed";
  let lastErrorMessage: string | undefined;

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        switch (assistantEvent.type) {
          case "text_delta":
            queue.push({ kind: "text_delta", delta: assistantEvent.delta });
            break;
          case "thinking_delta":
            queue.push({
              kind: "custom",
              type: "thinking_delta",
              data: { delta: assistantEvent.delta },
            });
            break;
          case "toolcall_start": {
            const toolCall = findToolCallAtContentIndex(
              assistantEvent.partial.content,
              assistantEvent.contentIndex,
            );
            if (toolCall && !emittedToolCalls.has(toolCall.id)) {
              emittedToolCalls.add(toolCall.id);
              queue.push({
                kind: "tool_call_start",
                toolName: resolveToolName(toolCall.name),
                callId: toolCallId(toolCall.id),
                args: (toolCall.arguments ?? {}) as Readonly<Record<string, unknown>>,
              });
            }
            break;
          }
          case "done": {
            if (!usageRecordedThisTurn) {
              const msg = assistantEvent.message;
              metrics.addUsage(
                msg.usage.input,
                msg.usage.output,
                msg.usage.cacheRead,
                msg.usage.cacheWrite,
              );
              usageRecordedThisTurn = true;
            }
            break;
          }
          case "error": {
            if (!usageRecordedThisTurn) {
              const errMsg = assistantEvent.error;
              metrics.addUsage(
                errMsg.usage.input,
                errMsg.usage.output,
                errMsg.usage.cacheRead,
                errMsg.usage.cacheWrite,
              );
              usageRecordedThisTurn = true;
            }
            lastStopReason = "error";
            lastErrorMessage = assistantEvent.error.errorMessage ?? "Unknown streaming error";
            break;
          }
          case "toolcall_delta":
            queue.push({
              kind: "tool_call_delta",
              callId: toolCallId(
                (() => {
                  const tc = findToolCallAtContentIndex(
                    assistantEvent.partial.content,
                    assistantEvent.contentIndex,
                  );
                  return tc?.id ?? "";
                })(),
              ),
              delta: assistantEvent.delta,
            });
            break;
          // text_start, text_end, thinking_start, thinking_end,
          // toolcall_end, start → no-op for Koi events
          default:
            break;
        }
        break;
      }

      case "tool_execution_start": {
        // Deduplicate: may already have been emitted via toolcall_start
        if (!emittedToolCalls.has(event.toolCallId)) {
          emittedToolCalls.add(event.toolCallId);
          queue.push({
            kind: "tool_call_start",
            toolName: resolveToolName(event.toolName),
            callId: toolCallId(event.toolCallId),
            args: (event.args ?? {}) as Readonly<Record<string, unknown>>,
          });
        }
        break;
      }

      case "tool_execution_end": {
        queue.push({
          kind: "tool_call_end",
          callId: toolCallId(event.toolCallId),
          result: event.result,
        });
        break;
      }

      case "turn_end": {
        // Pi fires turn_end with the completed AssistantMessage — this is the authoritative
        // source of per-turn token usage. Pi does NOT fire message_update { type: "done" }
        // in practice, so usage must be accumulated here from event.message.usage.
        // Narrow AgentMessage → AssistantMessage before accessing usage (which only exists
        // on AssistantMessage, not UserMessage/ToolResultMessage/CustomAgentMessages).
        if ("role" in event.message && event.message.role === "assistant") {
          if (!usageRecordedThisTurn) {
            const { usage } = event.message;
            metrics.addUsage(usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
          }
          // Always accumulate cost (cost is not included in message_update events)
          if (event.message.usage.cost) {
            metrics.addCost(event.message.usage.cost);
          }
          // Track error state from the assistant message for propagation in agent_end
          const msg = event.message as { readonly stopReason?: string; readonly errorMessage?: string };
          if (msg.stopReason === "error" || msg.errorMessage) {
            lastStopReason = "error";
            lastErrorMessage = msg.errorMessage ?? "Model call failed";
          }
        }
        metrics.addTurn();
        queue.push({ kind: "turn_end", turnIndex });
        turnIndex += 1;
        // Clear dedup set and usage guard per turn to prevent unbounded growth
        emittedToolCalls.clear();
        usageRecordedThisTurn = false;
        break;
      }

      case "agent_end": {
        // Check agent_end messages for error info (catch-block path in pi-agent-core
        // emits agent_end with an error message containing stopReason + errorMessage)
        if (lastStopReason === "completed" && event.messages.length > 0) {
          for (const msg of event.messages) {
            if ("role" in msg && msg.role === "assistant") {
              const aMsg = msg as { readonly stopReason?: string; readonly errorMessage?: string };
              if (aMsg.stopReason === "error" || aMsg.errorMessage) {
                lastStopReason = "error";
                lastErrorMessage = aMsg.errorMessage ?? "Agent ended with error";
                break;
              }
            }
          }
        }

        const { metrics: finalMetrics, metadata } = metrics.finalizeWithMetadata();
        const mergedMetadata: Record<string, unknown> = { ...metadata };
        if (lastErrorMessage) {
          mergedMetadata["errorMessage"] = lastErrorMessage;
        }
        const output: EngineOutput = {
          content: [],
          stopReason: lastStopReason,
          metrics: finalMetrics,
          ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
        };
        queue.push({ kind: "done", output });
        queue.end();
        break;
      }

      // agent_start, turn_start, message_start, message_end,
      // tool_execution_update → no Koi equivalent
      default:
        break;
    }
  };
}
