/**
 * Pure reducer for TUI state.
 *
 * (state, action) → state — no side effects, fully testable without React.
 * Accumulates EngineEvent streaming deltas into materialized TuiMessages.
 */

import type { EngineEvent } from "@koi/core/engine";
import type {
  CumulativeMetrics,
  PlanTask,
  SessionInfo,
  SessionSummary,
  TuiAction,
  TuiAssistantBlock,
  TuiMessage,
  TuiState,
} from "./types.js";
import { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_SESSIONS, MAX_TOOL_OUTPUT_CHARS } from "./types.js";

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
 * Bound an unknown tool result to a safe string for storage.
 * Serializes non-string values with a size-limited JSON.stringify,
 * catching circular/non-serializable inputs gracefully.
 */
function capResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return capOutput(result);
  try {
    const json = JSON.stringify(result);
    // JSON.stringify returns undefined for functions, symbols, etc.
    if (json === undefined) return "[unserializable]";
    return capOutput(json);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Append a streaming delta to the last block of the given kind,
 * or create a new block if the last block is a different kind.
 *
 * No cap applied — assistant text/thinking is user-facing content
 * that should not be truncated. Memory is bounded by the 1000-message
 * compaction and by individual conversation turn length.
 */
function appendDelta(state: TuiState, delta: string, blockKind: "text" | "thinking"): TuiState {
  if (delta === "") return state;

  const { messages, found } = ensureAssistant(state.messages);
  const lastBlock = found.msg.blocks.at(-1);

  let updatedBlocks: readonly TuiAssistantBlock[];
  if (lastBlock?.kind === blockKind) {
    updatedBlocks = replaceAt(found.msg.blocks, found.msg.blocks.length - 1, {
      kind: blockKind,
      text: lastBlock.text + delta,
    });
  } else {
    updatedBlocks = [...found.msg.blocks, { kind: blockKind, text: delta }];
  }

  return {
    ...state,
    messages: updateAssistant(messages, found, { blocks: updatedBlocks }),
  };
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
      return { ...state, messages: maybeCompact([...closed, newMsg]), agentStatus: "processing" };
    }

    case "turn_end": {
      const messages = closeActiveAssistant(state.messages);
      const next = messages === state.messages ? state : { ...state, messages };
      return next.agentStatus === "idle" ? next : { ...next, agentStatus: "idle" };
    }

    case "done": {
      const messages = finalizeAssistant(state.messages);
      const m = event.output.metrics;
      const prev = state.cumulativeMetrics;
      const cumulativeMetrics: CumulativeMetrics = {
        totalTokens: prev.totalTokens + m.totalTokens,
        inputTokens: prev.inputTokens + m.inputTokens,
        outputTokens: prev.outputTokens + m.outputTokens,
        // Count as a user round trip only when the engine actually ran at least one
        // model call. Interrupted/no-op completions emit done with m.turns === 0
        // and should not inflate the session counter.
        turns: m.turns > 0 ? prev.turns + 1 : prev.turns,
        // Default prev.engineTurns to prev.turns (conservative floor): each
        // historical user turn required at least one model call, so engineTurns
        // should never migrate below the existing turn count. This keeps the
        // status bar amplification signal honest for restored legacy sessions.
        engineTurns: (prev.engineTurns ?? prev.turns) + m.turns,
        costUsd: m.costUsd !== undefined ? (prev.costUsd ?? 0) + m.costUsd : prev.costUsd,
      };
      const base = { ...state, cumulativeMetrics, agentStatus: "idle" as const };
      return messages === state.messages ? base : { ...base, messages };
    }

    // ----- Text accumulation -----
    case "text_delta":
      return appendDelta(state, event.delta, "text");

    case "thinking_delta":
      return appendDelta(state, event.delta, "thinking");

    // ----- Tool call lifecycle -----
    case "tool_call_start": {
      const { messages, found } = ensureAssistant(state.messages);
      const callId = event.callId as string;
      const existing = findToolBlock(found.msg.blocks, callId);
      // Capture initial args if present (some producers emit args on start, not via deltas)
      const initialArgs =
        event.args !== undefined ? capOutput(JSON.stringify(event.args)) : undefined;

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
        result: capResult(event.result),
      });

      return {
        ...state,
        messages: updateAssistant(state.messages, found, { blocks: updatedBlocks }),
      };
    }

    // ----- Plan/progress events -----
    case "plan_update": {
      const planTasks = event.tasks.map((t) => ({
        id: t.id as string,
        subject: t.subject,
        status: t.status as string,
        ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
        ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy as string } : {}),
      }));
      return { ...state, planTasks };
    }

    case "task_progress": {
      const taskId = event.taskId as string;
      const newStatus = event.status as string;
      // Extract blockedBy from detail field (format: "blocked:<taskId>")
      const detail = event.detail;
      const blockedBy =
        detail !== undefined && detail.startsWith("blocked:") ? detail.slice(8) : undefined;

      const buildTask = (existingBlockedBy?: string): PlanTask => ({
        id: taskId,
        subject: event.subject,
        status: newStatus,
        ...(event.activeForm !== undefined ? { activeForm: event.activeForm } : {}),
        ...(blockedBy !== undefined
          ? { blockedBy }
          : existingBlockedBy !== undefined && newStatus === "pending"
            ? { blockedBy: existingBlockedBy }
            : {}),
      });

      if (state.planTasks === null) {
        return { ...state, planTasks: [buildTask()] };
      }
      const idx = state.planTasks.findIndex((t) => t.id === taskId);
      if (idx < 0) {
        return { ...state, planTasks: [...state.planTasks, buildTask()] };
      }
      const existing = state.planTasks[idx];
      const updated = buildTask(existing?.blockedBy);
      const planTasks = [
        ...state.planTasks.slice(0, idx),
        updated,
        ...state.planTasks.slice(idx + 1),
      ];
      return { ...state, planTasks };
    }

    // ----- Events the TUI ignores -----
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
    case "agent_spawned":
    case "agent_status_changed":
      return state;

    default:
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
      return action.modal === null && state.modal === null
        ? state
        : { ...state, modal: action.modal };

    case "set_connection_status":
      return action.status === state.connectionStatus
        ? state
        : { ...state, connectionStatus: action.status };

    case "set_layout":
      return action.tier === state.layoutTier ? state : { ...state, layoutTier: action.tier };

    case "set_zoom":
      return action.level === state.zoomLevel ? state : { ...state, zoomLevel: action.level };

    case "add_error": {
      const errorBlock: TuiAssistantBlock = {
        kind: "error",
        code: action.code,
        message: action.message,
      };
      // Only append to the active (streaming) assistant turn.
      // Check BEFORE finalization so completed turns are never mutated.
      const active = findLastAssistant(state.messages);
      if (active?.msg.streaming) {
        const finalized = finalizeAssistant(state.messages);
        const found = findLastAssistant(finalized);
        if (found) {
          return {
            ...state,
            agentStatus: "error",
            messages: updateAssistant(finalized, found, {
              blocks: [...found.msg.blocks, errorBlock],
              streaming: false,
            }),
          };
        }
      }
      // No active turn — create a standalone error message (agentStatus unchanged)
      const implicit: TuiMessage = {
        kind: "assistant",
        id: `assistant-error-${state.messages.length}`,
        blocks: [errorBlock],
        streaming: false,
      };
      return { ...state, messages: maybeCompact([...state.messages, implicit]) };
    }

    case "clear_messages":
      if (state.messages.length === 0 && state.agentStatus === "idle" && state.planTasks === null)
        return state;
      return { ...state, messages: [], agentStatus: "idle", planTasks: null };

    case "permission_response": {
      // Dismiss the permission modal if the requestId matches the active prompt.
      // The bridge (side-effect listener) handles resolving the Promise — the
      // reducer only manages UI state.
      if (
        state.modal?.kind !== "permission-prompt" ||
        state.modal.prompt.requestId !== action.requestId
      ) {
        return state;
      }
      return { ...state, modal: null };
    }

    case "set_session_info": {
      const sessionInfo: SessionInfo = {
        modelName: action.modelName,
        provider: action.provider,
        sessionName: action.sessionName,
      };
      return { ...state, sessionInfo };
    }

    case "set_session_list": {
      // Sort by most-recent-first without mutating the incoming array.
      const sorted = [...action.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const sessions: readonly SessionSummary[] = sorted.slice(0, MAX_SESSIONS);
      return { ...state, sessions };
    }

    case "set_slash_query":
      return action.query === state.slashQuery ? state : { ...state, slashQuery: action.query };

    case "load_history": {
      if (action.messages.length === 0) return state;
      const historical: TuiMessage[] = [];
      let assistantIdx = 0;
      let userIdx = 0;
      for (const msg of action.messages) {
        if (msg.senderId === "user") {
          historical.push({
            kind: "user",
            id: `history-user-${userIdx++}`,
            blocks: msg.content,
          });
        } else if (msg.senderId === "assistant") {
          const text = msg.content
            .filter((b) => b.kind === "text")
            .map((b) => (b as { readonly kind: "text"; readonly text: string }).text)
            .join("");
          if (text.length > 0) {
            historical.push({
              kind: "assistant",
              id: `history-assistant-${assistantIdx++}`,
              blocks: [{ kind: "text", text }],
              streaming: false,
            });
          }
        }
        // tool entries are skipped — they're in conversationHistory for model context
        // but not needed in the display (no tool_call/tool_result rendering in replay)
      }
      if (historical.length === 0) return state;
      // Prepend history before any live messages accumulated since load_history was queued.
      return { ...state, messages: maybeCompact([...historical, ...state.messages]) };
    }

    default:
      return state;
  }
}
