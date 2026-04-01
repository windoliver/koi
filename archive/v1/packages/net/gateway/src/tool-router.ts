/**
 * Gateway tool routing — intercepts tool_call frames, resolves target nodes,
 * forwards calls, tracks pending responses, and routes results back.
 *
 * Routing priority:
 * 1. Exclude source node (if tool_call reached gateway, source can't execute it)
 * 2. Affinity match (glob patterns -> preferred node)
 * 3. Highest available capacity
 * 4. Queue with TTL (if no candidates online)
 * 5. Error (queue full or disabled)
 */

import type { KoiError, Result } from "@koi/core";
import { isToolCallPayload } from "@koi/core";
import type { ToolAffinity, ToolRoutingConfig } from "@koi/gateway-types";
import type { NodeFrame } from "./node-handler.js";
import type { NodeRegistry, RegisteredNode } from "./node-registry.js";

// Re-export types for backward compatibility
export type { ToolAffinity, ToolRoutingConfig } from "@koi/gateway-types";

export interface ToolRouter {
  readonly handleToolCall: (frame: NodeFrame) => void;
  readonly handleToolResult: (frame: NodeFrame) => void;
  readonly handleToolError: (frame: NodeFrame) => void;
  readonly handleNodeDisconnect: (nodeId: string) => void;
  readonly handleNodeRegistered: (nodeId: string) => void;
  readonly handleToolsUpdated: (nodeId: string) => void;
  readonly pendingCount: () => number;
  readonly queuedCount: () => number;
  readonly dispose: () => void;
}

export interface ToolRouterDeps {
  readonly registry: NodeRegistry;
  readonly sendToNode: (nodeId: string, frame: NodeFrame) => Result<number, KoiError>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingToolCall {
  readonly sourceNodeId: string;
  readonly sourceAgentId: string;
  readonly correlationId: string;
  readonly toolName: string;
  readonly targetNodeId: string;
  readonly dispatchedAt: number;
  readonly timeoutMs: number;
  readonly timeoutTimer: ReturnType<typeof setTimeout>;
}

interface QueuedToolCall {
  readonly frame: NodeFrame;
  readonly toolName: string;
  readonly sourceNodeId: string;
  readonly queuedAt: number;
  readonly ttlTimer: ReturnType<typeof setTimeout>;
}

export interface CompiledAffinity {
  readonly regex: RegExp;
  readonly nodeId: string;
}

// ---------------------------------------------------------------------------
// Routing resolution result
// ---------------------------------------------------------------------------

export type RouteResult =
  | { readonly kind: "routed"; readonly targetNodeId: string }
  | { readonly kind: "not_available" };

// ---------------------------------------------------------------------------
// Constants (re-exported from @koi/gateway-types)
// ---------------------------------------------------------------------------

export type { ToolRoutingErrorCode } from "@koi/gateway-types";
export {
  DEFAULT_TOOL_ROUTING_CONFIG,
  TOOL_ROUTING_ERROR_CODES,
} from "@koi/gateway-types";

// Import for local use
import { TOOL_ROUTING_ERROR_CODES } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// Glob pattern compilation
// ---------------------------------------------------------------------------

export function compileAffinities(
  affinities: readonly ToolAffinity[],
): readonly CompiledAffinity[] {
  return affinities.map((a) => ({
    regex: compileGlobPattern(a.pattern),
    nodeId: a.nodeId,
  }));
}

function compileGlobPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchAffinity(
  toolName: string,
  compiled: readonly CompiledAffinity[],
): string | undefined {
  for (const a of compiled) {
    if (a.regex.test(toolName)) return a.nodeId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Routing resolution — pure function
// ---------------------------------------------------------------------------

export function resolveTargetNode(
  toolName: string,
  sourceNodeId: string,
  registry: NodeRegistry,
  compiledAffinities: readonly CompiledAffinity[],
): RouteResult {
  const candidates = registry.findByTool(toolName);
  if (candidates.length === 0) return { kind: "not_available" };

  const remote: readonly RegisteredNode[] = candidates.filter((n) => n.nodeId !== sourceNodeId);
  if (remote.length === 0) return { kind: "not_available" };

  // Affinity: check if preferred node is in remote candidates
  const affinityNodeId = matchAffinity(toolName, compiledAffinities);
  if (affinityNodeId !== undefined) {
    const affinityNode = remote.find((n) => n.nodeId === affinityNodeId);
    if (affinityNode !== undefined) {
      return { kind: "routed", targetNodeId: affinityNode.nodeId };
    }
  }

  // Capacity: O(N) scan for highest available — no array allocation
  // let justified: accumulator pattern for max scan
  const first = remote[0];
  if (first === undefined) return { kind: "not_available" };
  let best = first;
  for (let i = 1; i < remote.length; i++) {
    const candidate = remote[i];
    if (candidate !== undefined && candidate.capacity.available > best.capacity.available) {
      best = candidate;
    }
  }
  return { kind: "routed", targetNodeId: best.nodeId };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolRouter(config: ToolRoutingConfig, deps: ToolRouterDeps): ToolRouter {
  const pending = new Map<string, PendingToolCall>();
  const queued = new Map<string, QueuedToolCall>();
  const compiledAffs = compileAffinities(config.affinities ?? []);

  function sendToolError(
    sourceNodeId: string,
    agentId: string,
    correlationId: string,
    toolName: string,
    code: string,
    message: string,
  ): void {
    deps.sendToNode(sourceNodeId, {
      kind: "tool_error",
      nodeId: sourceNodeId,
      agentId,
      correlationId,
      payload: { toolName, code, message },
    });
  }

  function handleTimeout(routingCorrelationId: string): void {
    const entry = pending.get(routingCorrelationId);
    if (entry === undefined) return;
    pending.delete(routingCorrelationId);

    sendToolError(
      entry.sourceNodeId,
      entry.sourceAgentId,
      entry.correlationId,
      entry.toolName,
      TOOL_ROUTING_ERROR_CODES.TIMEOUT,
      `Tool call "${entry.toolName}" timed out after ${String(entry.timeoutMs)}ms`,
    );
  }

  function routeCall(frame: NodeFrame, toolName: string): void {
    const route = resolveTargetNode(toolName, frame.nodeId, deps.registry, compiledAffs);

    if (route.kind === "not_available") {
      if (config.maxQueuedCalls > 0 && queued.size < config.maxQueuedCalls) {
        const queueKey = frame.correlationId;
        const ttlTimer = setTimeout(() => {
          const qEntry = queued.get(queueKey);
          if (qEntry === undefined) return;
          queued.delete(queueKey);
          sendToolError(
            frame.nodeId,
            frame.agentId,
            frame.correlationId,
            toolName,
            TOOL_ROUTING_ERROR_CODES.TIMEOUT,
            `Queued tool call "${toolName}" expired after ${String(config.queueTimeoutMs)}ms`,
          );
        }, config.queueTimeoutMs);

        queued.set(queueKey, {
          frame,
          toolName,
          sourceNodeId: frame.nodeId,
          queuedAt: Date.now(),
          ttlTimer,
        });
        return;
      }

      sendToolError(
        frame.nodeId,
        frame.agentId,
        frame.correlationId,
        toolName,
        TOOL_ROUTING_ERROR_CODES.NOT_FOUND,
        `No node available for tool "${toolName}"`,
      );
      return;
    }

    const routingCorrelationId = `route-${frame.correlationId}-${String(Date.now())}`;
    const timeoutMs = frame.ttl ?? config.defaultTimeoutMs;
    const timeoutTimer = setTimeout(() => handleTimeout(routingCorrelationId), timeoutMs);

    pending.set(routingCorrelationId, {
      sourceNodeId: frame.nodeId,
      sourceAgentId: frame.agentId,
      correlationId: frame.correlationId,
      toolName,
      targetNodeId: route.targetNodeId,
      dispatchedAt: Date.now(),
      timeoutMs,
      timeoutTimer,
    });

    const forwardedFrame: NodeFrame = {
      ...frame,
      nodeId: route.targetNodeId,
      correlationId: routingCorrelationId,
    };

    const sendResult = deps.sendToNode(route.targetNodeId, forwardedFrame);
    if (!sendResult.ok) {
      clearTimeout(timeoutTimer);
      pending.delete(routingCorrelationId);
      sendToolError(
        frame.nodeId,
        frame.agentId,
        frame.correlationId,
        toolName,
        TOOL_ROUTING_ERROR_CODES.NOT_FOUND,
        `Failed to send to target node: ${sendResult.error.message}`,
      );
    }
  }

  function handleToolCall(frame: NodeFrame): void {
    if (!isToolCallPayload(frame.payload)) {
      sendToolError(
        frame.nodeId,
        frame.agentId,
        frame.correlationId,
        "unknown",
        TOOL_ROUTING_ERROR_CODES.VALIDATION,
        "Malformed tool_call payload",
      );
      return;
    }

    if (pending.size >= config.maxPendingCalls) {
      sendToolError(
        frame.nodeId,
        frame.agentId,
        frame.correlationId,
        frame.payload.toolName,
        TOOL_ROUTING_ERROR_CODES.RATE_LIMIT,
        `Max pending tool calls reached (${String(config.maxPendingCalls)})`,
      );
      return;
    }

    routeCall(frame, frame.payload.toolName);
  }

  function handleToolResponse(frame: NodeFrame): void {
    const entry = pending.get(frame.correlationId);
    if (entry === undefined) return;

    clearTimeout(entry.timeoutTimer);
    pending.delete(frame.correlationId);

    deps.sendToNode(entry.sourceNodeId, {
      ...frame,
      nodeId: entry.sourceNodeId,
      correlationId: entry.correlationId,
    });
  }

  function handleNodeDisconnect(nodeId: string): void {
    for (const [routingId, entry] of pending) {
      if (entry.targetNodeId === nodeId) {
        clearTimeout(entry.timeoutTimer);
        pending.delete(routingId);
        sendToolError(
          entry.sourceNodeId,
          entry.sourceAgentId,
          entry.correlationId,
          entry.toolName,
          TOOL_ROUTING_ERROR_CODES.NOT_FOUND,
          `Target node "${nodeId}" disconnected during tool call`,
        );
      } else if (entry.sourceNodeId === nodeId) {
        clearTimeout(entry.timeoutTimer);
        pending.delete(routingId);
      }
    }

    for (const [queueKey, qEntry] of queued) {
      if (qEntry.sourceNodeId === nodeId) {
        clearTimeout(qEntry.ttlTimer);
        queued.delete(queueKey);
      }
    }
  }

  function drainQueueForNode(nodeId: string): void {
    const node = deps.registry.lookup(nodeId);
    if (node === undefined) return;

    const toolNames = new Set(node.tools.map((t) => t.name));

    for (const [queueKey, qEntry] of queued) {
      if (toolNames.has(qEntry.toolName)) {
        clearTimeout(qEntry.ttlTimer);
        queued.delete(queueKey);
        routeCall(qEntry.frame, qEntry.toolName);
      }
    }
  }

  function dispose(): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutTimer);
    }
    pending.clear();
    for (const entry of queued.values()) {
      clearTimeout(entry.ttlTimer);
    }
    queued.clear();
  }

  return {
    handleToolCall,
    handleToolResult: handleToolResponse,
    handleToolError: handleToolResponse,
    handleNodeDisconnect,
    handleNodeRegistered: drainQueueForNode,
    handleToolsUpdated: drainQueueForNode,
    pendingCount: () => pending.size,
    queuedCount: () => queued.size,
    dispose,
  };
}
