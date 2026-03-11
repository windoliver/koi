/**
 * AG-UI event handler — maps streaming AG-UI events to TUI store actions.
 *
 * Handles tool call accumulation (TOOL_CALL_START → ARGS → END → RESULT)
 * using a Map keyed by toolCallId to preserve attribution across events.
 */

import type { AguiEvent } from "../client/agui-client.js";
import type { TuiStore } from "../state/store.js";

/** Create an AG-UI event handler wired to a store. */
export function createAguiEventHandler(store: TuiStore): {
  readonly handle: (event: AguiEvent) => void;
  readonly clear: () => void;
} {
  // Tracks name + args across TOOL_CALL_START → ARGS → END → RESULT
  const pending = new Map<string, { name: string; args: string }>();

  function lifecycle(event: string): void {
    store.dispatch({
      kind: "add_message",
      message: { kind: "lifecycle", event, timestamp: Date.now() },
    });
  }

  function handle(event: AguiEvent): void {
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
        store.dispatch({ kind: "append_tokens", text: event.delta });
        break;

      case "TEXT_MESSAGE_END":
        store.dispatch({ kind: "flush_tokens" });
        break;

      case "TOOL_CALL_START":
        pending.set(event.toolCallId, { name: event.toolCallName, args: "" });
        break;

      case "TOOL_CALL_ARGS": {
        const tc = pending.get(event.toolCallId);
        if (tc !== undefined) {
          pending.set(event.toolCallId, { name: tc.name, args: tc.args + event.delta });
        }
        break;
      }

      case "TOOL_CALL_END": {
        const tc = pending.get(event.toolCallId);
        if (tc !== undefined) {
          store.dispatch({
            kind: "add_message",
            message: {
              kind: "tool_call",
              name: tc.name,
              args: tc.args,
              result: undefined,
              timestamp: Date.now(),
            },
          });
        }
        break;
      }

      case "TOOL_CALL_RESULT": {
        const tc = pending.get(event.toolCallId);
        const toolName = tc?.name ?? "unknown";
        pending.delete(event.toolCallId);
        store.dispatch({
          kind: "add_message",
          message: {
            kind: "tool_call",
            name: toolName,
            args: tc?.args ?? "",
            result: event.result,
            timestamp: Date.now(),
          },
        });
        break;
      }

      case "RUN_STARTED":
        store.dispatch({ kind: "set_streaming", isStreaming: true });
        lifecycle("Run started");
        break;

      case "RUN_FINISHED":
        store.dispatch({ kind: "set_streaming", isStreaming: false });
        lifecycle("Run finished");
        break;

      case "RUN_ERROR":
        store.dispatch({ kind: "set_streaming", isStreaming: false });
        lifecycle(`Error: ${event.message}`);
        break;

      case "STEP_STARTED":
        lifecycle(`Step: ${event.stepName}`);
        break;

      case "REASONING_MESSAGE_CONTENT":
        store.dispatch({ kind: "append_tokens", text: event.delta });
        break;

      case "REASONING_MESSAGE_END":
        store.dispatch({ kind: "flush_tokens" });
        break;

      default:
        // TEXT_MESSAGE_START, STEP_FINISHED, STATE_*, CUSTOM, etc.
        break;
    }
  }

  function clear(): void {
    pending.clear();
  }

  return { handle, clear };
}
