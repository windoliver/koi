/**
 * Engine adapter contract — swappable agent loop.
 */

import type { JsonObject } from "./common.js";
import type { CorrelationIds } from "./correlation.js";
import type { AgentId, ProcessState, ToolCallId, ToolDescriptor } from "./ecs.js";
import type { ContentBlock, InboundMessage } from "./message.js";
import type {
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
} from "./middleware.js";
import type { SpawnRequest } from "./spawn.js";
import type { TaskItemId, TaskStatus } from "./task-board.js";

export type EngineStopReason = "completed" | "max_turns" | "interrupted" | "error";

/**
 * Outcome of agent termination — success, error, or interrupted.
 * Used by L2 consumers (e.g., workspace cleanup) to distinguish
 * normal completion from failure without depending on L1 internals.
 */
export type TerminationOutcome = "success" | "error" | "interrupted";

/**
 * Maps an engine stop reason to a termination outcome.
 * Pure function — no side effects, no dependencies.
 *
 * - "completed" → "success" (clean task completion)
 * - "max_turns" → "success" (turn budget is a capacity constraint, not an error;
 *   use cleanupPolicy "never" to inspect workspaces after budget-exceeded runs)
 * - "error" → "error"
 * - "interrupted" → "interrupted"
 */
export function mapStopReasonToOutcome(reason: EngineStopReason): TerminationOutcome {
  switch (reason) {
    case "completed":
    case "max_turns":
      return "success";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}

/**
 * Typed abort reasons for discriminating _why_ a signal fired.
 * Passed as the `reason` argument to `AbortController.abort(reason)`.
 * Consumers can inspect `signal.reason` to choose behavior
 * (e.g., save checkpoint on user_cancel, retry on timeout, discard on shutdown).
 */
export type AbortReason = "user_cancel" | "timeout" | "token_limit" | "shutdown";

export interface EngineMetrics {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly durationMs: number;
  /** Estimated total cost in USD for the engine run, when available. */
  readonly costUsd?: number | undefined;
}

export interface EngineOutput {
  readonly content: readonly ContentBlock[];
  readonly stopReason: EngineStopReason;
  readonly metrics: EngineMetrics;
  readonly metadata?: JsonObject;
}

export interface EngineState {
  readonly engineId: string;
  readonly data: unknown;
}

export interface ComposedCallHandlers {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly modelStream?: (request: ModelRequest) => AsyncIterable<ModelChunk>;
  readonly toolCall: (request: ToolRequest) => Promise<ToolResponse>;
  readonly tools: readonly ToolDescriptor[];
}

export interface EngineInputBase {
  readonly callHandlers?: ComposedCallHandlers;
  readonly signal?: AbortSignal | undefined;
  readonly correlationIds?: CorrelationIds | undefined;
  /**
   * Override DEFAULT_MAX_STOP_RETRIES for this run.
   * Raise when using @koi/outcome-evaluator with maxIterations > 3.
   * Must be >= the outcome-evaluator's maxIterations.
   */
  readonly maxStopRetries?: number | undefined;
}

export type EngineInput =
  | ({ readonly kind: "text"; readonly text: string } & EngineInputBase)
  | ({ readonly kind: "messages"; readonly messages: readonly InboundMessage[] } & EngineInputBase)
  | ({ readonly kind: "resume"; readonly state: EngineState } & EngineInputBase);

export type EngineEvent =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | {
      readonly kind: "tool_call_start";
      readonly toolName: string;
      readonly callId: ToolCallId;
      readonly args?: JsonObject;
    }
  | { readonly kind: "tool_call_delta"; readonly callId: ToolCallId; readonly delta: string }
  | {
      readonly kind: "tool_call_end";
      readonly callId: ToolCallId;
      readonly result: unknown;
    }
  | {
      /**
       * Emitted by the turn-runner AFTER a tool finishes executing.
       * `output` is the raw ToolResponse.output — not the AccumulatedToolCall
       * that tool_call_end carries. This is the data that should be displayed
       * in the TUI as the tool's result.
       */
      readonly kind: "tool_result";
      readonly callId: ToolCallId;
      readonly output: unknown;
    }
  | { readonly kind: "turn_start"; readonly turnIndex: number }
  | { readonly kind: "turn_end"; readonly turnIndex: number; readonly stopBlocked?: true }
  | { readonly kind: "done"; readonly output: EngineOutput }
  | { readonly kind: "custom"; readonly type: string; readonly data: unknown }
  | {
      readonly kind: "discovery:miss";
      readonly resolverSource: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "spawn_requested";
      readonly request: SpawnRequest;
      readonly childAgentId: AgentId;
    }
  | {
      readonly kind: "agent_spawned";
      readonly agentId: AgentId;
      readonly agentName: string;
      readonly parentAgentId?: AgentId | undefined;
    }
  | {
      readonly kind: "agent_status_changed";
      readonly agentId: AgentId;
      readonly agentName: string;
      readonly status: ProcessState;
      readonly previousStatus?: ProcessState | undefined;
    }
  | {
      /**
       * Emitted by the permission escalation layer whenever a PermissionRequest
       * is resolved. Observable by middleware for audit/telemetry — no separate
       * audit side-channel needed.
       *
       * "approved" includes the granted (possibly narrowed) set.
       * "rejected" and "expired" include a reason for structured failure handling.
       */
      readonly kind: "permission_attempt";
      readonly agentId: AgentId;
      readonly requestId: string;
      readonly requestedGrants: readonly string[];
      readonly decision: "approved" | "rejected" | "expired";
      readonly grantedGrants?: readonly string[] | undefined;
      readonly reason?: string | undefined;
    }
  | {
      /** Full snapshot of the task board — emitted on structural changes. */
      readonly kind: "plan_update";
      readonly agentId: AgentId;
      readonly tasks: readonly {
        readonly id: TaskItemId;
        readonly subject: string;
        readonly status: TaskStatus;
        readonly assignedTo?: AgentId | undefined;
        readonly activeForm?: string | undefined;
        readonly blockedBy?: TaskItemId | undefined;
        readonly dependencies: readonly TaskItemId[];
      }[];
      readonly timestamp: number;
    }
  | {
      /** Individual task state transition — emitted on every task mutation. */
      readonly kind: "task_progress";
      readonly agentId: AgentId;
      readonly taskId: TaskItemId;
      readonly subject: string;
      readonly previousStatus: TaskStatus;
      readonly status: TaskStatus;
      readonly activeForm?: string | undefined;
      readonly detail?: string | undefined;
      /** First incomplete dependency blocking this task (for unreachable events). */
      readonly blockedBy?: TaskItemId | undefined;
      readonly timestamp: number;
    };

// ---------------------------------------------------------------------------
// Engine capabilities
// ---------------------------------------------------------------------------

/**
 * Declares which content block types an engine adapter can natively handle.
 * Used by `mapContentBlocksForEngine()` to gracefully downgrade unsupported
 * block types to text instead of silently dropping them.
 */
export interface EngineCapabilities {
  readonly text: boolean;
  readonly images: boolean;
  readonly files: boolean;
  readonly audio: boolean;
}

// ---------------------------------------------------------------------------
// Content block downgrade for engines
// ---------------------------------------------------------------------------

/**
 * Downgrade a single content block for an engine that lacks native support.
 * Returns the block unchanged if the engine supports its kind.
 */
function downgradeForEngine(block: ContentBlock, capabilities: EngineCapabilities): ContentBlock {
  switch (block.kind) {
    case "image":
      if (!capabilities.images) {
        return { kind: "text", text: `[Image: ${block.alt ?? block.url}]` };
      }
      return block;
    case "file":
      if (!capabilities.files) {
        return { kind: "text", text: `[File: ${block.name ?? block.url}]` };
      }
      return block;
    case "text":
    case "button":
    case "custom":
      return block;
    default: {
      // Exhaustive check — future block kinds will cause a compile error here
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/**
 * Map content blocks for engine consumption, downgrading unsupported block
 * types to text descriptions. Returns the same array reference when all
 * content capabilities are supported (fast path).
 *
 * Pure function — no side effects, returns new array or same reference.
 */
export function mapContentBlocksForEngine(
  blocks: readonly ContentBlock[],
  capabilities: EngineCapabilities,
): readonly ContentBlock[] {
  // Fast path: return same reference if all content capabilities are true
  if (capabilities.images && capabilities.files) {
    return blocks;
  }
  return blocks.map((block) => downgradeForEngine(block, capabilities));
}

export interface EngineAdapter {
  readonly engineId: string;
  readonly capabilities: EngineCapabilities;
  /**
   * Raw function pointers for model/tool calls. When provided, the engine
   * wraps these with the middleware chain and passes the composed handlers
   * back via `EngineInput.callHandlers`. The adapter invokes them at
   * defined points (like a protocol handler calling NF_HOOK()).
   *
   * Non-cooperating adapters (without terminals) work unchanged —
   * they just don't get per-call middleware interposition.
   */
  readonly terminals?: {
    readonly modelCall: ModelHandler;
    readonly modelStream?: ModelStreamHandler;
    readonly toolCall?: ToolHandler;
  };
  /**
   * The sole required method. Returns an async iterable of engine events.
   * Backpressure is handled naturally via `for await` consumption —
   * the consumer controls iteration speed. Implementations should use
   * AsyncGenerator for built-in backpressure support.
   */
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly saveState?: () => Promise<EngineState>;
  /**
   * Restore adapter state from a previously saved snapshot.
   *
   * @remarks Adapters MUST validate the shape of `state.data` before use.
   * `EngineState.data` is typed as `unknown` to maintain adapter opacity —
   * corrupt or tampered state must produce a typed KoiError (code: "VALIDATION"),
   * never an unhandled runtime crash. Use schema validation (e.g., Zod) or
   * manual type narrowing inside this method.
   */
  readonly loadState?: (state: EngineState) => Promise<void>;
  /**
   * Inject a message into the running engine loop (Decision 3C).
   * Used by the inbox steer mode to deliver high-priority messages
   * mid-turn. Adapters that don't support injection simply omit this.
   * When absent, steer-mode items degrade to followup.
   */
  readonly inject?: (message: InboundMessage) => void | Promise<void>;
  readonly dispose?: () => Promise<void>;
}
