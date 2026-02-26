/**
 * Extracted tool_call handler — standalone pure-ish async function
 * with explicit dependencies for direct unit testing.
 */

import type {
  DelegationScope,
  JsonObject,
  ScopeChecker,
  Tool,
  ToolErrorPayload,
  ToolResultPayload,
} from "@koi/core";
import { isToolCallPayload } from "@koi/core";
import type { LocalResolver } from "./tools/local-resolver.js";
import type { NodeEvent, NodeFrame } from "./types.js";

export { isToolCallPayload };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for tool execution (30 seconds). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Dependency interface — no closures, fully mockable
// ---------------------------------------------------------------------------

/** Explicit dependencies for handleToolCall — no closures. */
export interface ToolCallHandlerDeps {
  readonly nodeId: string;
  readonly permission?:
    | {
        readonly checker: ScopeChecker;
        readonly scope: DelegationScope;
      }
    | undefined;
  readonly resolver: LocalResolver;
  readonly sendOutbound: (frame: NodeFrame) => void;
  readonly emit: (type: NodeEvent["type"], data?: unknown) => void;
  /** Milliseconds before a tool execution is considered timed out. Defaults to DEFAULT_TOOL_CALL_TIMEOUT_MS. */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Handle a tool_call frame: validate -> permission check -> resolve -> execute -> respond. */
export async function handleToolCall(frame: NodeFrame, deps: ToolCallHandlerDeps): Promise<void> {
  // Validate payload with type guard (no `as` cast)
  if (!isToolCallPayload(frame.payload)) {
    deps.emit("agent_crashed", {
      reason: "Malformed tool_call payload",
      agentId: frame.agentId,
      correlationId: frame.correlationId,
    });
    return;
  }

  const { toolName, args, callerAgentId } = frame.payload;

  // Permission check — deny-by-default when no checker configured (fail closed)
  if (deps.permission === undefined) {
    deps.sendOutbound({
      nodeId: deps.nodeId,
      agentId: frame.agentId,
      correlationId: frame.correlationId,
      kind: "tool_error",
      payload: {
        toolName,
        code: "permission_denied",
        message: "No permission checker configured — all tool calls denied by default",
      } satisfies ToolErrorPayload,
    });
    return;
  }

  const allowed = await deps.permission.checker.isAllowed(toolName, deps.permission.scope);
  if (!allowed) {
    deps.sendOutbound({
      nodeId: deps.nodeId,
      agentId: frame.agentId,
      correlationId: frame.correlationId,
      kind: "tool_error",
      payload: {
        toolName,
        code: "permission_denied",
        message: `Tool "${toolName}" denied for caller "${callerAgentId}"`,
      } satisfies ToolErrorPayload,
    });
    return;
  }

  // Resolve tool
  const loadResult = await deps.resolver.load(toolName);
  if (!loadResult.ok) {
    deps.sendOutbound({
      nodeId: deps.nodeId,
      agentId: frame.agentId,
      correlationId: frame.correlationId,
      kind: "tool_error",
      payload: {
        toolName,
        code: "not_found",
        message: `Tool not found: "${toolName}"`,
      } satisfies ToolErrorPayload,
    });
    return;
  }

  // Execute tool with cooperative cancellation via AbortSignal
  const effectiveTimeout = deps.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);

  try {
    const result = await executeWithSignal(loadResult.value, args ?? {}, timeoutSignal);

    deps.sendOutbound({
      nodeId: deps.nodeId,
      agentId: frame.agentId,
      correlationId: frame.correlationId,
      kind: "tool_result",
      payload: {
        toolName,
        result,
      } satisfies ToolResultPayload,
    });
  } catch (e: unknown) {
    // Discriminate timeout from other errors via signal state
    if (timeoutSignal.aborted) {
      deps.emit("agent_crashed", {
        reason: "Tool execution timed out",
        agentId: frame.agentId,
        toolName,
        timeoutMs: effectiveTimeout,
      });
      deps.sendOutbound({
        nodeId: deps.nodeId,
        agentId: frame.agentId,
        correlationId: frame.correlationId,
        kind: "tool_error",
        payload: {
          toolName,
          code: "timeout",
          message: `Tool "${toolName}" timed out after ${String(effectiveTimeout)}ms`,
        } satisfies ToolErrorPayload,
      });
      return;
    }

    // Non-timeout execution error
    deps.emit("agent_crashed", {
      reason: "Tool execution failed",
      agentId: frame.agentId,
      toolName,
      error: e,
    });
    deps.sendOutbound({
      nodeId: deps.nodeId,
      agentId: frame.agentId,
      correlationId: frame.correlationId,
      kind: "tool_error",
      payload: {
        toolName,
        code: "execution_error",
        message: "Tool execution failed",
      } satisfies ToolErrorPayload,
    });
  }
}

// ---------------------------------------------------------------------------
// Signal-aware tool execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a tool with cooperative cancellation + race backstop.
 *
 * 1. Fast-path: throws immediately if signal is already aborted.
 * 2. Cooperative: passes signal to tool.execute() via options bag.
 * 3. Backstop: races against a signal-derived rejection for non-cooperating tools.
 */
export async function executeWithSignal(
  tool: Tool,
  args: JsonObject,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();

  // let justified: assigned inside backstop promise, cleaned up in finally
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      tool.execute(args, { signal }),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
