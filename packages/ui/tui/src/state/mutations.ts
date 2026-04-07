/**
 * Mutation functions for TUI state — direct mutations for SolidJS produce().
 *
 * Each function mutates the draft state in place (called inside produce()).
 * Logic mirrors reduce.ts but uses direct assignment instead of immutable spreads.
 * The pure reducer is kept alongside as a regression safety net (Decision 9A).
 */

import type { EngineEvent } from "@koi/core/engine";
import type {
  CumulativeMetrics,
  PlanTask,
  SessionSummary,
  TuiAction,
  TuiAssistantBlock,
  TuiMessage,
  TuiState,
} from "./types.js";
import { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_SESSIONS, MAX_TOOL_OUTPUT_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Mutable type aliases (produce() strips readonly via proxy — these
// clarify intent for the reader without runtime cost)
// ---------------------------------------------------------------------------

/** Writable view of TuiState inside produce(). */
type Draft = TuiState;

type AssistantMessage = TuiMessage & { readonly kind: "assistant" };
type ToolCallBlock = TuiAssistantBlock & { readonly kind: "tool_call" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (json === undefined) return "[unserializable]";
    return capOutput(json);
  } catch {
    return "[unserializable]";
  }
}

/** Find the index of the last assistant message. Returns -1 if none. */
function findLastAssistantIdx(messages: readonly TuiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === "assistant") return i;
  }
  return -1;
}

/** Get the last assistant message, cast to mutable. */
function lastAssistant(state: Draft): AssistantMessage | undefined {
  const idx = findLastAssistantIdx(state.messages);
  if (idx < 0) return undefined;
  return state.messages[idx] as AssistantMessage;
}

/** Find a tool_call block index by callId within an assistant's blocks. */
function findToolBlockIdx(blocks: readonly TuiAssistantBlock[], callId: string): number {
  return blocks.findIndex((b) => b.kind === "tool_call" && b.callId === callId);
}

/**
 * Close (stop streaming) any active assistant message.
 * Marks any in-flight tool_call blocks as "error" (they won't get tool_call_end).
 */
function finalizeAssistant(state: Draft): void {
  const msg = lastAssistant(state) as AssistantMessage | undefined;
  if (!msg) return;

  // Count running tools being finalized and decrement counter
  let finalized = 0;
  for (const block of msg.blocks) {
    if (block.kind === "tool_call" && block.status === "running") {
      (block as ToolCallBlock & { status: string }).status = "error";
      finalized++;
    }
  }
  (state as { runningToolCount: number }).runningToolCount -= finalized;

  (msg as AssistantMessage & { streaming: boolean }).streaming = false;
}

/** Close (stop streaming) any active assistant without marking tools as error. */
function closeActiveAssistant(state: Draft): void {
  const msg = lastAssistant(state);
  if (!msg?.streaming) return;
  (msg as AssistantMessage & { streaming: boolean }).streaming = false;
}

/**
 * Apply hysteresis compaction. When triggered, inserts a compaction divider.
 */
function maybeCompact(state: Draft): void {
  if (state.messages.length >= COMPACT_THRESHOLD) {
    const excess = state.messages.length - MAX_MESSAGES;
    (state.messages as TuiMessage[]).splice(0, excess);
    // Insert compaction divider (Decision 4.2)
    (state.messages as TuiMessage[]).unshift({
      kind: "system",
      id: `compaction-${Date.now()}`,
      text: "--- Earlier messages compacted ---",
    });
  }
}

/**
 * Ensure there is a streaming assistant message to write deltas into.
 * Returns the assistant message (creating one if needed).
 */
function ensureAssistant(state: Draft): AssistantMessage {
  const existing = lastAssistant(state);
  if (existing?.streaming) return existing;

  const implicit: TuiMessage = {
    kind: "assistant",
    id: `assistant-implicit-${state.messages.length}`,
    blocks: [],
    streaming: true,
  };
  (state.messages as TuiMessage[]).push(implicit);
  maybeCompact(state);
  return state.messages[state.messages.length - 1] as AssistantMessage;
}

/**
 * Append a streaming delta to the last block of the given kind,
 * or create a new block if the last block is a different kind.
 */
function appendDelta(state: Draft, delta: string, blockKind: "text" | "thinking"): void {
  if (delta === "") return;

  const msg = ensureAssistant(state);
  const blocks = msg.blocks as TuiAssistantBlock[];
  const lastBlock = blocks.at(-1);

  if (lastBlock?.kind === blockKind) {
    (lastBlock as { text: string }).text += delta;
  } else {
    blocks.push({ kind: blockKind, text: delta });
  }
}

// ---------------------------------------------------------------------------
// Engine event mutations
// ---------------------------------------------------------------------------

function mutateEngineEvent(state: Draft, event: EngineEvent): void {
  switch (event.kind) {
    // ----- Turn lifecycle -----
    case "turn_start": {
      finalizeAssistant(state);
      const newMsg: TuiMessage = {
        kind: "assistant",
        id: `assistant-${event.turnIndex}`,
        blocks: [],
        streaming: true,
      };
      (state.messages as TuiMessage[]).push(newMsg);
      maybeCompact(state);
      (state as { agentStatus: string }).agentStatus = "processing";
      break;
    }

    case "turn_end": {
      closeActiveAssistant(state);
      (state as { agentStatus: string }).agentStatus = "idle";
      break;
    }

    case "done": {
      finalizeAssistant(state);
      const m = event.output.metrics;
      const prev = state.cumulativeMetrics;
      const metrics: CumulativeMetrics = {
        totalTokens: prev.totalTokens + m.totalTokens,
        inputTokens: prev.inputTokens + m.inputTokens,
        outputTokens: prev.outputTokens + m.outputTokens,
        turns: m.turns > 0 ? prev.turns + 1 : prev.turns,
        engineTurns: (prev.engineTurns ?? prev.turns) + m.turns,
        costUsd: m.costUsd !== undefined ? (prev.costUsd ?? 0) + m.costUsd : prev.costUsd,
      };
      (state as { cumulativeMetrics: CumulativeMetrics }).cumulativeMetrics = metrics;
      (state as { agentStatus: string }).agentStatus = "idle";
      break;
    }

    // ----- Text accumulation -----
    case "text_delta":
      appendDelta(state, event.delta, "text");
      break;

    case "thinking_delta":
      appendDelta(state, event.delta, "thinking");
      break;

    // ----- Tool call lifecycle -----
    case "tool_call_start": {
      const msg = ensureAssistant(state);
      const callId = event.callId as string;
      const blocks = msg.blocks as TuiAssistantBlock[];
      const existingIdx = findToolBlockIdx(blocks, callId);

      const initialArgs =
        event.args !== undefined ? capOutput(JSON.stringify(event.args)) : undefined;

      const newBlock: TuiAssistantBlock = {
        kind: "tool_call",
        callId,
        toolName: event.toolName,
        status: "running",
        ...(initialArgs !== undefined ? { args: initialArgs } : {}),
      };

      if (existingIdx >= 0) {
        blocks[existingIdx] = newBlock;
      } else {
        blocks.push(newBlock);
        (state as { runningToolCount: number }).runningToolCount++;
      }
      break;
    }

    case "tool_call_delta": {
      const msg = lastAssistant(state);
      if (!msg) break;
      const callId = event.callId as string;
      const blockIdx = findToolBlockIdx(msg.blocks, callId);
      if (blockIdx < 0) break;

      const block = msg.blocks[blockIdx] as ToolCallBlock & { args?: string };
      block.args = capOutput((block.args ?? "") + event.delta);
      break;
    }

    case "tool_call_end": {
      const msg = lastAssistant(state);
      if (!msg) break;
      const callId = event.callId as string;
      const blockIdx = findToolBlockIdx(msg.blocks, callId);
      if (blockIdx < 0) break;

      const block = msg.blocks[blockIdx] as ToolCallBlock & {
        status: string;
        result?: string;
      };
      block.status = "complete";
      block.result = capResult(event.result);
      (state as { runningToolCount: number }).runningToolCount--;
      break;
    }

    // ----- Plan/progress events -----
    case "plan_update": {
      const planTasks: PlanTask[] = event.tasks.map((t) => ({
        id: t.id as string,
        subject: t.subject,
        status: t.status as string,
        ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
        ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy as string } : {}),
      }));
      (state as { planTasks: readonly PlanTask[] | null }).planTasks = planTasks;
      break;
    }

    case "task_progress": {
      const taskId = event.taskId as string;
      const newStatus = event.status as string;
      const blockedBy = event.blockedBy !== undefined ? (event.blockedBy as string) : undefined;

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
        (state as { planTasks: PlanTask[] }).planTasks = [buildTask()];
        break;
      }
      const tasks = state.planTasks as PlanTask[];
      const idx = tasks.findIndex((t) => t.id === taskId);
      if (idx < 0) {
        tasks.push(buildTask());
      } else {
        const existing = tasks[idx];
        tasks[idx] = buildTask(existing?.blockedBy);
      }
      break;
    }

    // ----- Events the TUI ignores -----
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
    case "agent_spawned":
    case "agent_status_changed":
      break;
  }
}

// ---------------------------------------------------------------------------
// Top-level mutation dispatcher
// ---------------------------------------------------------------------------

/** Apply an action to the draft state (called inside produce()). */
export function mutate(state: Draft, action: TuiAction): void {
  switch (action.kind) {
    case "engine_event":
      mutateEngineEvent(state, action.event);
      break;

    case "add_user_message": {
      const newMsg: TuiMessage = {
        kind: "user",
        id: action.id,
        blocks: action.blocks,
      };
      (state.messages as TuiMessage[]).push(newMsg);
      maybeCompact(state);
      break;
    }

    case "set_view":
      if (action.view !== state.activeView) {
        (state as { activeView: string }).activeView = action.view;
      }
      break;

    case "set_modal":
      (state as { modal: typeof action.modal }).modal = action.modal;
      break;

    case "set_connection_status":
      if (action.status !== state.connectionStatus) {
        (state as { connectionStatus: string }).connectionStatus = action.status;
      }
      break;

    case "set_layout":
      if (action.tier !== state.layoutTier) {
        (state as { layoutTier: string }).layoutTier = action.tier;
      }
      break;

    case "set_zoom":
      if (action.level !== state.zoomLevel) {
        (state as { zoomLevel: number }).zoomLevel = action.level;
      }
      break;

    case "add_error": {
      const errorBlock: TuiAssistantBlock = {
        kind: "error",
        code: action.code,
        message: action.message,
      };
      const active = lastAssistant(state);
      if (active?.streaming) {
        finalizeAssistant(state);
        const found = lastAssistant(state);
        if (found) {
          (found.blocks as TuiAssistantBlock[]).push(errorBlock);
          (found as AssistantMessage & { streaming: boolean }).streaming = false;
          (state as { agentStatus: string }).agentStatus = "error";
          break;
        }
      }
      const implicit: TuiMessage = {
        kind: "assistant",
        id: `assistant-error-${state.messages.length}`,
        blocks: [errorBlock],
        streaming: false,
      };
      (state.messages as TuiMessage[]).push(implicit);
      maybeCompact(state);
      break;
    }

    case "clear_messages":
      (state as { messages: TuiMessage[] }).messages = [];
      (state as { agentStatus: string }).agentStatus = "idle";
      (state as { planTasks: null }).planTasks = null;
      (state as { runningToolCount: number }).runningToolCount = 0;
      break;

    case "permission_response": {
      if (
        state.modal?.kind !== "permission-prompt" ||
        state.modal.prompt.requestId !== action.requestId
      ) {
        break;
      }
      (state as { modal: null }).modal = null;
      break;
    }

    case "set_session_info":
      (state as { sessionInfo: typeof state.sessionInfo }).sessionInfo = {
        modelName: action.modelName,
        provider: action.provider,
        sessionName: action.sessionName,
      };
      break;

    case "set_session_list": {
      const sorted = [...action.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      (state as { sessions: readonly SessionSummary[] }).sessions = sorted.slice(0, MAX_SESSIONS);
      break;
    }

    case "set_slash_query":
      if (action.query !== state.slashQuery) {
        (state as { slashQuery: string | null }).slashQuery = action.query;
      }
      break;

    case "toggle_tools_expanded":
      (state as { toolsExpanded: boolean }).toolsExpanded = !state.toolsExpanded;
      break;

    case "load_history": {
      if (action.messages.length === 0) break;
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
      }
      if (historical.length === 0) break;
      (state as { messages: TuiMessage[] }).messages = [...historical, ...state.messages];
      maybeCompact(state);
      break;
    }
  }
}
