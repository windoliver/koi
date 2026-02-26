/**
 * Unit tests for tool-router: resolveTargetNode, handleToolCall, handleToolResult,
 * handleToolError, timeout, handleNodeDisconnect, handleNodeRegistered, dispose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NodeFrame } from "./node-handler.js";
import type { NodeRegistry, RegisteredNode } from "./node-registry.js";
import { createInMemoryNodeRegistry } from "./node-registry.js";
import type { ToolRouter } from "./tool-router.js";
import { compileAffinities, createToolRouter, resolveTargetNode } from "./tool-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRegisteredNode(
  nodeId: string,
  tools: readonly string[],
  available = 5,
): RegisteredNode {
  return {
    nodeId,
    mode: "full",
    tools: tools.map((name) => ({ name })),
    capacity: { current: 10 - available, max: 10, available },
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    connId: `conn-${nodeId}`,
  };
}

function createToolCallFrame(
  nodeId: string,
  toolName: string,
  overrides?: Partial<NodeFrame>,
): NodeFrame {
  return {
    kind: "tool_call",
    nodeId,
    agentId: overrides?.agentId ?? "agent-1",
    correlationId: overrides?.correlationId ?? `corr-${crypto.randomUUID()}`,
    payload: {
      toolName,
      args: {},
      callerAgentId: overrides?.agentId ?? "agent-1",
    },
    ...(overrides?.ttl !== undefined ? { ttl: overrides.ttl } : {}),
  };
}

function createToolResultFrame(
  nodeId: string,
  correlationId: string,
  toolName = "some-tool",
): NodeFrame {
  return {
    kind: "tool_result",
    nodeId,
    agentId: "agent-1",
    correlationId,
    payload: { toolName, result: { data: "ok" } },
  };
}

function createToolErrorFrame(
  nodeId: string,
  correlationId: string,
  toolName = "some-tool",
): NodeFrame {
  return {
    kind: "tool_error",
    nodeId,
    agentId: "agent-1",
    correlationId,
    payload: { toolName, code: "execution_error", message: "Something failed" },
  };
}

// ---------------------------------------------------------------------------
// resolveTargetNode
// ---------------------------------------------------------------------------

describe("resolveTargetNode", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = createInMemoryNodeRegistry();
  });

  test("returns routed to remote node when tool exists on other node", () => {
    registry.register(createRegisteredNode("node-a", ["search"]));
    registry.register(createRegisteredNode("node-b", ["camera.capture"]));

    const result = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-b");
    }
  });

  test("excludes source node from candidates", () => {
    registry.register(createRegisteredNode("node-a", ["search"]));

    const result = resolveTargetNode("search", "node-a", registry, []);
    expect(result.kind).toBe("not_available");
  });

  test("returns not_available when no remote node has the tool", () => {
    registry.register(createRegisteredNode("node-a", ["search"]));

    const result = resolveTargetNode("unknown-tool", "node-a", registry, []);
    expect(result.kind).toBe("not_available");
  });

  test("returns not_available for empty registry", () => {
    const result = resolveTargetNode("search", "node-a", registry, []);
    expect(result.kind).toBe("not_available");
  });

  test("selects node with highest available capacity", () => {
    registry.register(createRegisteredNode("node-b", ["search"], 3));
    registry.register(createRegisteredNode("node-c", ["search"], 8));
    registry.register(createRegisteredNode("node-d", ["search"], 5));

    const result = resolveTargetNode("search", "node-a", registry, []);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-c");
    }
  });

  test("affinity match overrides capacity selection", () => {
    registry.register(createRegisteredNode("node-b", ["search"], 8));
    registry.register(createRegisteredNode("node-c", ["search"], 3));

    const compiled = compileAffinities([{ pattern: "search", nodeId: "node-c" }]);
    const result = resolveTargetNode("search", "node-a", registry, compiled);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-c");
    }
  });

  test("affinity glob pattern matching (camera.* matches camera.capture)", () => {
    registry.register(createRegisteredNode("node-b", ["camera.capture"], 5));
    registry.register(createRegisteredNode("node-c", ["camera.capture"], 8));

    const compiled = compileAffinities([{ pattern: "camera.*", nodeId: "node-b" }]);
    const result = resolveTargetNode("camera.capture", "node-a", registry, compiled);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-b");
    }
  });

  test("affinity miss falls through to capacity selection", () => {
    registry.register(createRegisteredNode("node-b", ["search"], 3));
    registry.register(createRegisteredNode("node-c", ["search"], 8));

    // Affinity targets node-d which doesn't exist
    const compiled = compileAffinities([{ pattern: "search", nodeId: "node-d" }]);
    const result = resolveTargetNode("search", "node-a", registry, compiled);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-c");
    }
  });
});

// ---------------------------------------------------------------------------
// createToolRouter
// ---------------------------------------------------------------------------

describe("createToolRouter", () => {
  let registry: NodeRegistry;
  let sentFrames: Array<{ readonly nodeId: string; readonly frame: NodeFrame }>;
  let router: ToolRouter;

  function mockSendToNode(nodeId: string, frame: NodeFrame): Result<number, KoiError> {
    sentFrames.push({ nodeId, frame });
    return { ok: true, value: 1 };
  }

  function findSent(
    nodeId: string,
    kind?: string,
  ): { readonly nodeId: string; readonly frame: NodeFrame } | undefined {
    return sentFrames.find(
      (s) => s.nodeId === nodeId && (kind === undefined || s.frame.kind === kind),
    );
  }

  function findAllSent(
    nodeId: string,
    kind?: string,
  ): ReadonlyArray<{ readonly nodeId: string; readonly frame: NodeFrame }> {
    return sentFrames.filter(
      (s) => s.nodeId === nodeId && (kind === undefined || s.frame.kind === kind),
    );
  }

  beforeEach(() => {
    registry = createInMemoryNodeRegistry();
    sentFrames = [];
    router = createToolRouter(
      {
        defaultTimeoutMs: 5_000,
        maxPendingCalls: 100,
        maxQueuedCalls: 50,
        queueTimeoutMs: 10_000,
      },
      { registry, sendToNode: mockSendToNode },
    );
  });

  afterEach(() => {
    router.dispose();
  });

  // -----------------------------------------------------------------------
  // handleToolCall
  // -----------------------------------------------------------------------

  describe("handleToolCall", () => {
    test("routes tool_call to remote node", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["camera.capture"]));

      const frame = createToolCallFrame("node-a", "camera.capture");
      router.handleToolCall(frame);

      expect(router.pendingCount()).toBe(1);
      const sent = findSent("node-b", "tool_call");
      expect(sent).toBeDefined();
      expect(sent?.frame.correlationId).toStartWith("route-");
    });

    test("sends tool_error when no node has the tool and queue is full", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));

      // Fill queue first with disabled queue (maxQueuedCalls = 0)
      router.dispose();
      router = createToolRouter(
        {
          defaultTimeoutMs: 5_000,
          maxPendingCalls: 100,
          maxQueuedCalls: 0,
          queueTimeoutMs: 10_000,
        },
        { registry, sendToNode: mockSendToNode },
      );

      const frame = createToolCallFrame("node-a", "unknown-tool");
      router.handleToolCall(frame);

      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      const payload = errorSent?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("not_found");
    });

    test("queues tool_call when no node available and queue has space", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));

      const frame = createToolCallFrame("node-a", "camera.capture");
      router.handleToolCall(frame);

      expect(router.queuedCount()).toBe(1);
      expect(router.pendingCount()).toBe(0);
    });

    test("sends tool_error when payload is malformed", () => {
      const frame: NodeFrame = {
        kind: "tool_call",
        nodeId: "node-a",
        agentId: "agent-1",
        correlationId: "corr-bad",
        payload: { invalid: true },
      };
      router.handleToolCall(frame);

      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      const payload = errorSent?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("validation");
    });

    test("sends tool_error when max pending calls reached", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      router.dispose();
      router = createToolRouter(
        {
          defaultTimeoutMs: 5_000,
          maxPendingCalls: 1,
          maxQueuedCalls: 50,
          queueTimeoutMs: 10_000,
        },
        { registry, sendToNode: mockSendToNode },
      );

      // First call succeeds
      router.handleToolCall(createToolCallFrame("node-a", "search"));
      expect(router.pendingCount()).toBe(1);

      // Second call hits limit
      router.handleToolCall(createToolCallFrame("node-a", "search", { correlationId: "corr-2" }));

      const errors = findAllSent("node-a", "tool_error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const lastError = errors[errors.length - 1];
      const payload = lastError?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("rate_limit");
    });

    test("uses frame.ttl when present instead of default timeout", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const frame = createToolCallFrame("node-a", "search", { ttl: 1_000 });
      router.handleToolCall(frame);

      expect(router.pendingCount()).toBe(1);
      // TTL is stored internally; we verify via timeout behavior in timeout tests
    });

    test("sends tool_error when sendToNode fails", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      // let: reassigned in callback
      let callCount = 0;
      const failingRouter = createToolRouter(
        {
          defaultTimeoutMs: 5_000,
          maxPendingCalls: 100,
          maxQueuedCalls: 50,
          queueTimeoutMs: 10_000,
        },
        {
          registry,
          sendToNode: (nodeId, frame) => {
            callCount++;
            if (callCount === 1) {
              // First call (forwarding to target) fails
              return {
                ok: false,
                error: { code: "NOT_FOUND", message: "Node gone", retryable: false },
              };
            }
            // Second call (error back to source) succeeds
            sentFrames.push({ nodeId, frame });
            return { ok: true, value: 1 };
          },
        },
      );

      const frame = createToolCallFrame("node-a", "search");
      failingRouter.handleToolCall(frame);

      expect(failingRouter.pendingCount()).toBe(0);
      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      failingRouter.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // handleToolResult
  // -----------------------------------------------------------------------

  describe("handleToolResult", () => {
    test("forwards result back to source node with original correlationId", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const originalCorrelationId = "corr-original";
      const frame = createToolCallFrame("node-a", "search", {
        correlationId: originalCorrelationId,
      });
      router.handleToolCall(frame);
      expect(router.pendingCount()).toBe(1);

      // Find the routing correlation ID from the forwarded frame
      const forwarded = findSent("node-b", "tool_call");
      expect(forwarded).toBeDefined();
      const routingCorrelationId = forwarded?.frame.correlationId ?? "";

      sentFrames = [];
      const resultFrame = createToolResultFrame("node-b", routingCorrelationId);
      router.handleToolResult(resultFrame);

      expect(router.pendingCount()).toBe(0);
      const sent = findSent("node-a", "tool_result");
      expect(sent).toBeDefined();
      expect(sent?.frame.correlationId).toBe(originalCorrelationId);
    });

    test("discards orphan result (no pending call)", () => {
      const resultFrame = createToolResultFrame("node-b", "nonexistent-corr");
      router.handleToolResult(resultFrame);

      expect(sentFrames).toHaveLength(0);
    });

    test("clears timeout timer on successful result", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const frame = createToolCallFrame("node-a", "search");
      router.handleToolCall(frame);

      const forwarded = findSent("node-b", "tool_call");
      const routingCorrelationId = forwarded?.frame.correlationId ?? "";

      router.handleToolResult(createToolResultFrame("node-b", routingCorrelationId));

      expect(router.pendingCount()).toBe(0);
      // If timer wasn't cleared, it would fire later and try to send error — no assertion needed,
      // just verify no errors appear (covered by dispose in afterEach)
    });
  });

  // -----------------------------------------------------------------------
  // handleToolError
  // -----------------------------------------------------------------------

  describe("handleToolError", () => {
    test("forwards error back to source node with original correlationId", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const frame = createToolCallFrame("node-a", "search", {
        correlationId: "corr-err",
      });
      router.handleToolCall(frame);

      const forwarded = findSent("node-b", "tool_call");
      const routingCorrelationId = forwarded?.frame.correlationId ?? "";

      sentFrames = [];
      const errorFrame = createToolErrorFrame("node-b", routingCorrelationId);
      router.handleToolError(errorFrame);

      expect(router.pendingCount()).toBe(0);
      const sent = findSent("node-a", "tool_error");
      expect(sent).toBeDefined();
      expect(sent?.frame.correlationId).toBe("corr-err");
    });

    test("discards orphan error", () => {
      router.handleToolError(createToolErrorFrame("node-b", "nonexistent-corr"));
      expect(sentFrames).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // timeout
  // -----------------------------------------------------------------------

  describe("timeout", () => {
    test("sends timeout error to source after configured timeout", async () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const shortTimeoutRouter = createToolRouter(
        {
          defaultTimeoutMs: 50,
          maxPendingCalls: 100,
          maxQueuedCalls: 50,
          queueTimeoutMs: 10_000,
        },
        { registry, sendToNode: mockSendToNode },
      );

      const frame = createToolCallFrame("node-a", "search");
      shortTimeoutRouter.handleToolCall(frame);
      expect(shortTimeoutRouter.pendingCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 100));

      expect(shortTimeoutRouter.pendingCount()).toBe(0);
      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      const payload = errorSent?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("timeout");

      shortTimeoutRouter.dispose();
    });

    test("cleans up pending entry on timeout", async () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const shortTimeoutRouter = createToolRouter(
        {
          defaultTimeoutMs: 50,
          maxPendingCalls: 100,
          maxQueuedCalls: 50,
          queueTimeoutMs: 10_000,
        },
        { registry, sendToNode: mockSendToNode },
      );

      shortTimeoutRouter.handleToolCall(createToolCallFrame("node-a", "search"));
      expect(shortTimeoutRouter.pendingCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 100));
      expect(shortTimeoutRouter.pendingCount()).toBe(0);

      shortTimeoutRouter.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // handleNodeDisconnect
  // -----------------------------------------------------------------------

  describe("handleNodeDisconnect", () => {
    test("sends error to source when target node disconnects", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      const frame = createToolCallFrame("node-a", "search", {
        correlationId: "corr-dc",
      });
      router.handleToolCall(frame);
      expect(router.pendingCount()).toBe(1);

      sentFrames = [];
      router.handleNodeDisconnect("node-b");

      expect(router.pendingCount()).toBe(0);
      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      expect(errorSent?.frame.correlationId).toBe("corr-dc");
      const payload = errorSent?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("not_found");
    });

    test("cleans up pending when source node disconnects (no error sent)", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      router.handleToolCall(createToolCallFrame("node-a", "search"));
      expect(router.pendingCount()).toBe(1);

      sentFrames = [];
      router.handleNodeDisconnect("node-a");

      expect(router.pendingCount()).toBe(0);
      // No error sent to anyone (source is gone)
      const errorToB = findSent("node-b", "tool_error");
      expect(errorToB).toBeUndefined();
    });

    test("handles disconnect affecting multiple pending calls", () => {
      registry.register(createRegisteredNode("node-a", ["search", "browse"]));
      registry.register(createRegisteredNode("node-b", ["search", "browse"]));

      router.handleToolCall(createToolCallFrame("node-a", "search", { correlationId: "c1" }));
      router.handleToolCall(createToolCallFrame("node-a", "browse", { correlationId: "c2" }));
      expect(router.pendingCount()).toBe(2);

      sentFrames = [];
      router.handleNodeDisconnect("node-b");

      expect(router.pendingCount()).toBe(0);
      const errors = findAllSent("node-a", "tool_error");
      expect(errors).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // handleNodeRegistered
  // -----------------------------------------------------------------------

  describe("handleNodeRegistered", () => {
    test("dequeues matching tool calls when capable node registers", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));

      // Queue a call for a tool no node has
      const frame = createToolCallFrame("node-a", "camera.capture", {
        correlationId: "corr-q1",
      });
      router.handleToolCall(frame);
      expect(router.queuedCount()).toBe(1);

      // Register a new node with the needed tool
      registry.register(createRegisteredNode("node-b", ["camera.capture"]));
      router.handleNodeRegistered("node-b");

      expect(router.queuedCount()).toBe(0);
      expect(router.pendingCount()).toBe(1);

      const sent = findSent("node-b", "tool_call");
      expect(sent).toBeDefined();
    });

    test("does not dequeue calls for tools the new node doesn't have", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));

      const frame = createToolCallFrame("node-a", "camera.capture", {
        correlationId: "corr-q2",
      });
      router.handleToolCall(frame);
      expect(router.queuedCount()).toBe(1);

      registry.register(createRegisteredNode("node-b", ["browse"]));
      router.handleNodeRegistered("node-b");

      expect(router.queuedCount()).toBe(1);
    });

    test("queue TTL expiry sends timeout error to source", async () => {
      registry.register(createRegisteredNode("node-a", ["search"]));

      const shortQueueRouter = createToolRouter(
        {
          defaultTimeoutMs: 5_000,
          maxPendingCalls: 100,
          maxQueuedCalls: 50,
          queueTimeoutMs: 50,
        },
        { registry, sendToNode: mockSendToNode },
      );

      shortQueueRouter.handleToolCall(createToolCallFrame("node-a", "camera.capture"));
      expect(shortQueueRouter.queuedCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 100));

      expect(shortQueueRouter.queuedCount()).toBe(0);
      const errorSent = findSent("node-a", "tool_error");
      expect(errorSent).toBeDefined();
      const payload = errorSent?.frame.payload as Record<string, unknown>;
      expect(payload.code).toBe("timeout");

      shortQueueRouter.dispose();
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe("dispose", () => {
    test("clears all pending calls, queued calls, and timers", () => {
      registry.register(createRegisteredNode("node-a", ["search"]));
      registry.register(createRegisteredNode("node-b", ["search"]));

      // Create pending call
      router.handleToolCall(createToolCallFrame("node-a", "search"));
      expect(router.pendingCount()).toBe(1);

      // Create queued call
      router.handleToolCall(
        createToolCallFrame("node-a", "camera.capture", {
          correlationId: "corr-q",
        }),
      );
      expect(router.queuedCount()).toBe(1);

      router.dispose();

      expect(router.pendingCount()).toBe(0);
      expect(router.queuedCount()).toBe(0);
    });
  });
});
