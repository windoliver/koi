/**
 * Pure reducer for TUI state.
 *
 * (state, action) → state — no side effects, fully testable without React.
 * Accumulates EngineEvent streaming deltas into materialized TuiMessages.
 */

import type { EngineEvent } from "@koi/core/engine";
import type { TuiAction, TuiAssistantBlock, TuiMessage, TuiState } from "./types.js";
import { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_TOOL_OUTPUT_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Assistant message type (narrowed)
// ---------------------------------------------------------------------------

type AssistantMessage = TuiMessage & { readonly kind: "assistant" };
type ToolCallBlock = TuiAssistantBlock & { readonly kind: "tool_call" };

interface FoundAssistant {
  readonly msg: AssistantMessage;
  readonly idx: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the last assistant message (the one being streamed to). */
function findLastAssistant(messages: readonly TuiMessage[]): FoundAssistant | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.kind === "assistant") {
      return { msg, idx: i };
    }
  }
  return undefined;
}

/** Replace a single element in a readonly array by index. */
function replaceAt<T>(arr: readonly T[], idx: number, value: T): readonly T[] {
  return arr.with(idx, value);
}

/** Update the last assistant message in the messages array. */
function updateAssistant(
  messages: readonly TuiMessage[],
  found: FoundAssistant,
  update: Partial<Pick<AssistantMessage, "blocks" | "streaming">>,
): readonly TuiMessage[] {
  return replaceAt(messages, found.idx, { ...found.msg, ...update });
}

/** Close (stop streaming) any active assistant message. */
function closeActiveAssistant(messages: readonly TuiMessage[]): readonly TuiMessage[] {
  const found = findLastAssistant(messages);
  if (!found?.msg.streaming) return messages;
  return updateAssistant(messages, found, { streaming: false });
}

/**
 * Close the active assistant and mark any in-flight tool_call blocks as "error".
 * Called on terminal `done` events where the engine has finished but tool calls
 * may not have received their `tool_call_end`.
 */
function finalizeAssistant(messages: readonly TuiMessage[]): readonly TuiMessage[] {
  const found = findLastAssistant(messages);
  if (!found) return messages;

  // Mark any "running" tool blocks as "error" — they won't get a tool_call_end
  const hasRunningTools = found.msg.blocks.some(
    (b) => b.kind === "tool_call" && b.status === "running",
  );
  const updatedBlocks = hasRunningTools
    ? found.msg.blocks.map((b) =>
        b.kind === "tool_call" && b.status === "running" ? { ...b, status: "error" as const } : b,
      )
    : found.msg.blocks;

  const needsUpdate = found.msg.streaming || hasRunningTools;
  if (!needsUpdate) return messages;

  return updateAssistant(messages, found, {
    streaming: false,
    blocks: updatedBlocks,
  });
}

/** Apply hysteresis compaction if messages reach or exceed threshold. */
function maybeCompact(messages: readonly TuiMessage[]): readonly TuiMessage[] {
  if (messages.length >= COMPACT_THRESHOLD) {
    return messages.slice(-MAX_MESSAGES);
  }
  return messages;
}

/** Cap a string to MAX_TOOL_OUTPUT_CHARS via tail-slice. */
function capOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(-MAX_TOOL_OUTPUT_CHARS) : text;
}

/**
 * Ensure there is a streaming assistant message to write deltas into.
 * If none exists, creates an implicit one (handles orphan deltas).
 */
function ensureAssistant(messages: readonly TuiMessage[]): {
  readonly messages: readonly TuiMessage[];
  readonly found: FoundAssistant;
} {
  const existing = findLastAssistant(messages);
  if (existing?.msg.streaming) {
    return { messages, found: existing };
  }
  const implicit: AssistantMessage = {
    kind: "assistant",
    id: `assistant-implicit-${messages.length}`,
    blocks: [],
    streaming: true,
  };
  const updated = maybeCompact([...messages, implicit]);
  return { messages: updated, found: { msg: implicit, idx: updated.length - 1 } };
}

/** Find a tool_call block by callId within an assistant's blocks. */
function findToolBlock(
  blocks: readonly TuiAssistantBlock[],
  callId: string,
): { readonly block: ToolCallBlock; readonly blockIdx: number } | undefined {
  const blockIdx = blocks.findIndex((b) => b.kind === "tool_call" && b.callId === callId);
  if (blockIdx < 0) return undefined;
  const block = blocks[blockIdx];
  if (block?.kind !== "tool_call") return undefined;
  return { block, blockIdx };
}

// ---------------------------------------------------------------------------
// Engine event handler
// ---------------------------------------------------------------------------

function reduceEngineEvent(state: TuiState, event: EngineEvent): TuiState {
  switch (event.kind) {
    // ----- Turn lifecycle -----
    case "turn_start": {
      // Finalize (not just close) — stranded tool calls from the prior turn become "error"
      const closed = finalizeAssistant(state.messages);
      const newMsg: TuiMessage = {
        kind: "assistant",
        id: `assistant-${event.turnIndex}`,
        blocks: [],
        streaming: true,
      };
      return { ...state, messages: maybeCompact([...closed, newMsg]) };
    }

    case "turn_end": {
      const messages = closeActiveAssistant(state.messages);
      return messages === state.messages ? state : { ...state, messages };
    }

    case "done": {
      const messages = finalizeAssistant(state.messages);
      return messages === state.messages ? state : { ...state, messages };
    }

    // ----- Text accumulation -----
    case "text_delta": {
      if (event.delta === "") return state;

      const { messages, found } = ensureAssistant(state.messages);
      const lastBlock = found.msg.blocks.at(-1);

      let updatedBlocks: readonly TuiAssistantBlock[];
      if (lastBlock?.kind === "text") {
        updatedBlocks = replaceAt(found.msg.blocks, found.msg.blocks.length - 1, {
          kind: "text",
          text: lastBlock.text + event.delta,
        });
      } else {
        updatedBlocks = [...found.msg.blocks, { kind: "text", text: event.delta }];
      }

      return {
        ...state,
        messages: updateAssistant(messages, found, { blocks: updatedBlocks }),
      };
    }

    case "thinking_delta": {
      if (event.delta === "") return state;

      const { messages, found } = ensureAssistant(state.messages);
      const lastBlock = found.msg.blocks.at(-1);

      let updatedBlocks: readonly TuiAssistantBlock[];
      if (lastBlock?.kind === "thinking") {
        updatedBlocks = replaceAt(found.msg.blocks, found.msg.blocks.length - 1, {
          kind: "thinking",
          text: lastBlock.text + event.delta,
        });
      } else {
        updatedBlocks = [...found.msg.blocks, { kind: "thinking", text: event.delta }];
      }

      return {
        ...state,
        messages: updateAssistant(messages, found, { blocks: updatedBlocks }),
      };
    }

    // ----- Tool call lifecycle -----
    case "tool_call_start": {
      const { messages, found } = ensureAssistant(state.messages);
      const callId = event.callId as string;
      const existing = findToolBlock(found.msg.blocks, callId);
      // Capture initial args if present (some producers emit args on start, not via deltas)
      const initialArgs = event.args !== undefined ? JSON.stringify(event.args) : undefined;

      const newBlock: TuiAssistantBlock = {
        kind: "tool_call",
        callId,
        toolName: event.toolName,
        status: "running",
        ...(initialArgs !== undefined ? { args: initialArgs } : {}),
      };

      let updatedBlocks: readonly TuiAssistantBlock[];
      if (existing) {
        updatedBlocks = replaceAt(found.msg.blocks, existing.blockIdx, newBlock);
      } else {
        updatedBlocks = [...found.msg.blocks, newBlock];
      }

      return {
        ...state,
        messages: updateAssistant(messages, found, { blocks: updatedBlocks }),
      };
    }

    case "tool_call_delta": {
      // tool_call_delta streams argument JSON fragments (model generating the call),
      // NOT tool execution output. Accumulate into `args`.
      const found = findLastAssistant(state.messages);
      if (!found) return state;

      const callId = event.callId as string;
      const tool = findToolBlock(found.msg.blocks, callId);
      if (!tool) return state;

      const appended = (tool.block.args ?? "") + event.delta;
      const updatedBlocks = replaceAt(found.msg.blocks, tool.blockIdx, {
        ...tool.block,
        args: capOutput(appended),
      });

      return {
        ...state,
        messages: updateAssistant(state.messages, found, { blocks: updatedBlocks }),
      };
    }

    case "tool_call_end": {
      // tool_call_end.result carries the accumulated tool call object
      // (parsed args + execution result). Store it as `result`.
      const found = findLastAssistant(state.messages);
      if (!found) return state;

      const callId = event.callId as string;
      const tool = findToolBlock(found.msg.blocks, callId);
      if (!tool) return state;

      const updatedBlocks = replaceAt(found.msg.blocks, tool.blockIdx, {
        ...tool.block,
        status: "complete",
        result: event.result,
      });

      return {
        ...state,
        messages: updateAssistant(state.messages, found, { blocks: updatedBlocks }),
      };
    }

    // ----- Events the TUI ignores -----
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
    case "agent_spawned":
    case "agent_status_changed":
      return state;
  }
}

// ---------------------------------------------------------------------------
// Top-level reducer
// ---------------------------------------------------------------------------

/** Pure reducer: (state, action) → state. */
export function reduce(state: TuiState, action: TuiAction): TuiState {
  switch (action.kind) {
    case "engine_event":
      return reduceEngineEvent(state, action.event);

    case "add_user_message": {
      const newMsg: TuiMessage = {
        kind: "user",
        id: action.id,
        blocks: action.blocks,
      };
      const messages = maybeCompact([...state.messages, newMsg]);
      return { ...state, messages };
    }

    case "set_view":
      return action.view === state.activeView ? state : { ...state, activeView: action.view };

    case "set_modal":
      return { ...state, modal: action.modal };

    case "set_connection_status":
      return action.status === state.connectionStatus
        ? state
        : { ...state, connectionStatus: action.status };

    case "set_layout":
      return action.tier === state.layoutTier ? state : { ...state, layoutTier: action.tier };

    case "clear_messages":
      return state.messages.length === 0 ? state : { ...state, messages: [] };
  }
}
