/**
 * Mutation functions for TUI state — direct mutations for SolidJS produce().
 *
 * Each function mutates the draft state in place (called inside produce()).
 * Logic mirrors reduce.ts but uses direct assignment instead of immutable spreads.
 * The pure reducer is kept alongside as a regression safety net (Decision 9A).
 */

import type { EngineEvent } from "@koi/core/engine";
import { convertResumedMessagesToTui } from "./reduce.js";
import type {
  CumulativeMetrics,
  PlanTask,
  SessionInfo,
  SessionSummary,
  SpawnProgress,
  SpawnRecord,
  SpawnStats,
  ToolResultData,
  TuiAction,
  TuiAssistantBlock,
  TuiMessage,
  TuiState,
} from "./types.js";
import {
  COMPACT_THRESHOLD,
  MAX_FINISHED_SPAWNS,
  MAX_MESSAGES,
  MAX_SESSIONS,
  MAX_TOOL_RESULT_BYTES,
} from "./types.js";

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

/** Cap a string to MAX_TOOL_RESULT_BYTES via tail-slice. */
function capOutput(text: string): string {
  return text.length > MAX_TOOL_RESULT_BYTES ? text.slice(-MAX_TOOL_RESULT_BYTES) : text;
}

/**
 * Convert an unknown tool execution output into a ToolResultData for storage.
 * Mirrors reduce.ts capToolResult — see that function for rationale.
 */
function capToolResult(output: unknown): ToolResultData {
  if (output === undefined || output === null) {
    return { value: "", byteSize: 0, truncated: false };
  }
  if (typeof output === "string") {
    if (output.length <= MAX_TOOL_RESULT_BYTES) {
      return { value: output, byteSize: output.length, truncated: false };
    }
    return {
      value: output.slice(-MAX_TOOL_RESULT_BYTES),
      byteSize: output.length,
      truncated: true,
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(output) ?? "[unserializable]";
  } catch {
    serialized = "[unserializable]";
  }
  if (serialized === "[unserializable]" || serialized === undefined) {
    return { value: "[unserializable]", byteSize: 0, truncated: false };
  }
  const byteSize = serialized.length;
  if (byteSize <= MAX_TOOL_RESULT_BYTES) {
    return { value: output, byteSize, truncated: false };
  }
  return { value: serialized.slice(-MAX_TOOL_RESULT_BYTES), byteSize, truncated: true };
}

/**
 * Prepend a finished spawn record to the ring buffer and cap at
 * MAX_FINISHED_SPAWNS. Mirrors appendFinishedSpawn in reduce.ts. Mutates the
 * draft directly since the whole state module runs inside produce().
 */
function recordFinishedSpawn(state: Draft, record: SpawnRecord): void {
  const next = [record, ...state.finishedSpawns];
  const capped = next.length > MAX_FINISHED_SPAWNS ? next.slice(0, MAX_FINISHED_SPAWNS) : next;
  (state as unknown as { finishedSpawns: readonly SpawnRecord[] }).finishedSpawns = capped;
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
 * Apply a partial patch to a tool_call block by callId in the last assistant
 * message. Warns in dev-mode and no-ops if the callId is not found.
 */
function updateToolBlock(state: Draft, callId: string, patch: Partial<ToolCallBlock>): void {
  const msg = lastAssistant(state);
  if (!msg) return;
  const blockIdx = findToolBlockIdx(msg.blocks, callId);
  if (blockIdx < 0) {
    console.warn(`[tui/mutate] no tool_call block found for callId="${callId}"`);
    return;
  }
  const block = msg.blocks[blockIdx] as ToolCallBlock;
  (msg.blocks as TuiAssistantBlock[])[blockIdx] = { ...block, ...patch };
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

/**
 * Deep-unwrap JSON-encoded error messages (#19).
 * Mirrors reduce.ts unwrapErrorMessage — see that function for rationale.
 */
function unwrapErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith('"')) return raw;
  try {
    let decoded: unknown = JSON.parse(trimmed);
    if (typeof decoded === "string") {
      const firstDecode = decoded;
      try {
        decoded = JSON.parse(firstDecode);
      } catch {
        return firstDecode;
      }
    }
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      const obj = decoded as Record<string, unknown>;
      const msg = obj.message ?? obj.error;
      if (typeof msg === "string") return msg;
      if (typeof msg === "object" && msg !== null) {
        const nested = (msg as Record<string, unknown>).message;
        if (typeof nested === "string") return nested;
      }
    }
  } catch {
    /* not JSON */
  }
  return raw;
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
        startedAt: Date.now(),
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
      // tool_call_end fires BEFORE execution (end of argument streaming).
      // Keep the block in "running" — status transitions to "complete" only
      // when tool_result arrives. This prevents long-running tools from
      // showing a misleading green check while still in flight.
      break;
    }

    case "tool_result": {
      // tool_result fires after execution — authoritative completion point.
      // Mark complete, compute duration, store result, decrement running count.
      const msg = lastAssistant(state);
      const blockIdx = msg ? findToolBlockIdx(msg.blocks, event.callId as string) : -1;
      const existingBlock =
        blockIdx >= 0
          ? (msg?.blocks[blockIdx] as ToolCallBlock & { startedAt?: number })
          : undefined;
      const durationMs =
        existingBlock?.startedAt !== undefined ? Date.now() - existingBlock.startedAt : undefined;
      updateToolBlock(state, event.callId as string, {
        status: "complete" as const,
        result: capToolResult(event.output),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      (state as { runningToolCount: number }).runningToolCount = Math.max(
        0,
        state.runningToolCount - 1,
      );
      break;
    }

    // ----- Spawn visualization -----
    case "spawn_requested": {
      const agentId = event.childAgentId as string;
      const msg = ensureAssistant(state);
      const spawnBlock: TuiAssistantBlock = {
        kind: "spawn_call",
        agentId,
        agentName: event.request.agentName,
        description: event.request.description ?? event.request.agentName,
        status: "running",
      };
      (msg.blocks as TuiAssistantBlock[]).push(spawnBlock);
      const progress: SpawnProgress = {
        agentName: event.request.agentName,
        description: event.request.description ?? event.request.agentName,
        startedAt: Date.now(),
      };
      const spawns = new Map(state.activeSpawns);
      spawns.set(agentId, progress);
      (state as unknown as { activeSpawns: Map<string, SpawnProgress> }).activeSpawns = spawns;
      break;
    }

    case "agent_status_changed": {
      const agentId = event.agentId as string;
      const progress = state.activeSpawns.get(agentId);
      if (!progress) break;

      // "terminated" is the only terminal ProcessState
      if (event.status !== "terminated") break;

      const msg = lastAssistant(state);
      if (!msg) break;

      const blockIdx = msg.blocks.findIndex(
        (b) => b.kind === "spawn_call" && b.agentId === agentId,
      );
      if (blockIdx < 0) break;

      const finishedAt = Date.now();
      const durationMs = finishedAt - progress.startedAt;
      const stats: SpawnStats = { turns: 0, toolCalls: 0, durationMs };

      (msg.blocks as TuiAssistantBlock[])[blockIdx] = {
        kind: "spawn_call",
        agentId,
        agentName: progress.agentName,
        description: progress.description,
        status: "complete",
        stats,
      };

      const spawns = new Map(state.activeSpawns);
      spawns.delete(agentId);
      (state as unknown as { activeSpawns: Map<string, SpawnProgress> }).activeSpawns = spawns;
      recordFinishedSpawn(state, {
        agentId,
        agentName: progress.agentName,
        description: progress.description,
        startedAt: progress.startedAt,
        finishedAt,
        durationMs,
        outcome: "complete",
      });
      break;
    }

    case "agent_spawned":
      // spawn_call block already added on spawn_requested. No-op.
      break;

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
        (state as unknown as { planTasks: PlanTask[] }).planTasks = [buildTask()];
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

    // ----- Events the TUI observes but has no rendering for -----
    case "custom":
    case "discovery:miss":
    case "permission_attempt":
      break;

    // Forward-compatibility catch-all
    default:
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
        message: unwrapErrorMessage(action.message),
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

    case "add_info": {
      const infoBlock: TuiAssistantBlock = { kind: "info", message: action.message };
      const implicit: TuiMessage = {
        kind: "assistant",
        id: `assistant-info-${state.messages.length}`,
        blocks: [infoBlock],
        streaming: false,
      };
      (state.messages as TuiMessage[]).push(implicit);
      maybeCompact(state);
      break;
    }

    case "clear_messages":
      (state as unknown as { messages: TuiMessage[] }).messages = [];
      (state as { agentStatus: string }).agentStatus = "idle";
      (state as { planTasks: null }).planTasks = null;
      (state as { runningToolCount: number }).runningToolCount = 0;
      (state as unknown as { expandedToolCallIds: Set<string> }).expandedToolCallIds = new Set();
      (state as unknown as { expandedBodyToolCallIds: Set<string> }).expandedBodyToolCallIds =
        new Set();
      (state as unknown as { activeSpawns: Map<string, SpawnProgress> }).activeSpawns = new Map();
      (state as unknown as { finishedSpawns: readonly SpawnRecord[] }).finishedSpawns = [];
      (state as { retryState: null }).retryState = null;
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

    case "tool_execution_started": {
      // Reset startedAt on the tool-call block with matching callId.
      // Dispatched by the permission bridge after a user approves a
      // permission prompt. Keyed by callId (not toolName) so queued
      // prompts for the same tool cannot cross-reset each other. (#1759)
      const msg = lastAssistant(state);
      if (!msg) break;
      const blockIdx = findToolBlockIdx(msg.blocks, action.callId);
      if (blockIdx < 0) break;
      const block = msg.blocks[blockIdx] as ToolCallBlock;
      if (block.status !== "running") break;
      (block as { startedAt?: number }).startedAt = Date.now();
      break;
    }

    case "set_session_info": {
      (state as { sessionInfo: SessionInfo }).sessionInfo = {
        modelName: action.modelName,
        provider: action.provider,
        sessionName: action.sessionName,
        sessionId: action.sessionId,
      };
      if (action.maxTokens !== undefined) {
        (state as { maxContextTokens: number }).maxContextTokens = action.maxTokens;
      }
      break;
    }

    case "rehydrate_messages": {
      // Mirrors the pure-reducer case in reduce.ts — wholesale
      // replace of the visible message list at TUI startup when
      // `--resume` is set. Filtering/shape conversion is delegated
      // to `convertResumedMessagesToTui` so this path and the pure
      // reducer + `load_history` path all render identical history.
      (state as { messages: readonly TuiMessage[] }).messages = convertResumedMessagesToTui(
        action.messages,
        "resumed",
      );
      break;
    }

    case "set_session_list": {
      const sorted = [...action.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      (state as { sessions: readonly SessionSummary[] }).sessions = sorted.slice(0, MAX_SESSIONS);
      break;
    }

    case "set_spawn_terminal": {
      // Authoritative terminal action — overwrites agent_status_changed record
      // if it arrived first (#1792).
      const progress = state.activeSpawns.get(action.agentId);
      const existingRecord = progress
        ? undefined
        : state.finishedSpawns.find((r) => r.agentId === action.agentId);
      if (!progress && !existingRecord) break;

      const agentName = progress?.agentName ?? existingRecord!.agentName;
      const description = progress?.description ?? existingRecord!.description;
      const startedAt = progress?.startedAt ?? existingRecord!.startedAt;
      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;
      const stats: SpawnStats = { turns: 0, toolCalls: 0, durationMs };

      // Best-effort inline block update — block may no longer be addressable.
      const msg = lastAssistant(state);
      if (msg) {
        const blockIdx = msg.blocks.findIndex(
          (b) => b.kind === "spawn_call" && b.agentId === action.agentId,
        );
        if (blockIdx >= 0) {
          (msg.blocks as TuiAssistantBlock[])[blockIdx] = {
            kind: "spawn_call",
            agentId: action.agentId,
            agentName,
            description,
            status: action.outcome,
            stats,
          };
        }
      }

      if (progress) {
        const spawns = new Map(state.activeSpawns);
        spawns.delete(action.agentId);
        (state as unknown as { activeSpawns: Map<string, SpawnProgress> }).activeSpawns = spawns;
      }

      if (existingRecord) {
        // Overwrite the existing record's outcome in-place.
        const idx = state.finishedSpawns.findIndex((r) => r.agentId === action.agentId);
        if (idx >= 0) {
          const updated = state.finishedSpawns.map((r, i) =>
            i === idx ? { ...r, outcome: action.outcome, finishedAt, durationMs } : r,
          );
          (state as unknown as { finishedSpawns: readonly SpawnRecord[] }).finishedSpawns = updated;
        }
      } else {
        recordFinishedSpawn(state, {
          agentId: action.agentId,
          agentName,
          description,
          startedAt,
          finishedAt,
          durationMs,
          outcome: action.outcome,
        });
      }
      break;
    }

    case "set_slash_query":
      if (action.query !== state.slashQuery) {
        (state as { slashQuery: string | null }).slashQuery = action.query;
      }
      break;

    case "expand_tool": {
      if (!state.expandedToolCallIds.has(action.callId)) {
        const next = new Set(state.expandedToolCallIds);
        next.add(action.callId);
        (state as unknown as { expandedToolCallIds: Set<string> }).expandedToolCallIds = next;
      }
      break;
    }

    case "collapse_tool": {
      if (state.expandedToolCallIds.has(action.callId)) {
        const next = new Set(state.expandedToolCallIds);
        next.delete(action.callId);
        (state as unknown as { expandedToolCallIds: Set<string> }).expandedToolCallIds = next;
      }
      break;
    }

    case "toggle_all_tools_expanded": {
      const allIds: string[] = [];
      for (const msg of state.messages) {
        if (msg.kind === "assistant") {
          for (const block of msg.blocks) {
            if (block.kind === "tool_call") allIds.push(block.callId);
          }
        }
      }
      const anyUnexpanded = allIds.some((id) => !state.expandedToolCallIds.has(id));
      const next = anyUnexpanded ? new Set(allIds) : new Set<string>();
      (state as unknown as { expandedToolCallIds: Set<string> }).expandedToolCallIds = next;
      break;
    }

    case "expand_tool_body": {
      if (!state.expandedBodyToolCallIds.has(action.callId)) {
        const next = new Set(state.expandedBodyToolCallIds);
        next.add(action.callId);
        (state as unknown as { expandedBodyToolCallIds: Set<string> }).expandedBodyToolCallIds =
          next;
      }
      break;
    }

    case "collapse_tool_body": {
      if (state.expandedBodyToolCallIds.has(action.callId)) {
        const next = new Set(state.expandedBodyToolCallIds);
        next.delete(action.callId);
        (state as unknown as { expandedBodyToolCallIds: Set<string> }).expandedBodyToolCallIds =
          next;
      }
      break;
    }

    case "set_retry_state": {
      if (action.countdown === null) {
        (state as { retryState: null }).retryState = null;
      } else {
        (state as { retryState: { countdownSec: number; attempt: number } }).retryState = {
          countdownSec: action.countdown,
          attempt: action.attempt ?? state.retryState?.attempt ?? 1,
        };
      }
      break;
    }

    case "set_agent_context":
      (state as { agentDepth: number }).agentDepth = action.depth;
      (state as { siblingInfo: typeof state.siblingInfo }).siblingInfo = action.siblingInfo ?? null;
      break;

    case "set_at_query":
      if (action.query !== state.atQuery) {
        (state as { atQuery: string | null }).atQuery = action.query;
      }
      break;

    case "set_at_results":
      (state as { atResults: readonly string[] }).atResults = action.results;
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
      (state as unknown as { messages: TuiMessage[] }).messages = [
        ...historical,
        ...state.messages,
      ];
      maybeCompact(state);
      break;
    }
  }
}
