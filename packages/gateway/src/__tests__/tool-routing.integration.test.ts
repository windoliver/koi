/**
 * Integration tests for tool routing through the full gateway.
 *
 * Verifies: end-to-end tool_call routing, error paths, queue dequeuing,
 * affinity, capacity selection, and backward-compatible no-op when disabled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { MockConnection, MockTransport } from "./test-utils.js";
import {
  createMockTransport,
  createNodeCapabilitiesMessage,
  createNodeHandshakeMessage,
  createTestAuthenticator,
  createToolCallFrameMessage,
  createToolErrorFrameMessage,
  createToolResultFrameMessage,
  waitForCondition,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerNode(
  transport: MockTransport,
  nodeId: string,
  tools: readonly { readonly name: string }[],
  capacity?: { readonly current: number; readonly max: number; readonly available: number },
): MockConnection {
  const conn = transport.simulateOpen();
  transport.simulateMessage(
    conn.id,
    createNodeHandshakeMessage(nodeId, capacity ?? { current: 0, max: 10, available: 10 }),
  );
  transport.simulateMessage(conn.id, createNodeCapabilitiesMessage(nodeId, tools));
  return conn;
}

function findSentFrame(conn: MockConnection, kind: string): Record<string, unknown> | undefined {
  for (const msg of conn.sent) {
    const parsed = JSON.parse(msg) as Record<string, unknown>;
    if (parsed.kind === kind) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool routing integration", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(async () => {
    transport = createMockTransport();
    gateway = createGateway({ toolRouting: {} }, { transport, auth: createTestAuthenticator() });
    await gateway.start(0);
  });

  afterEach(async () => {
    await gateway.stop();
  });

  test("tool_call from node-A routed to node-B, result returned to node-A", async () => {
    const connA = registerNode(transport, "node-a", [{ name: "search" }]);
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 2);

    // Node-A sends tool_call for camera.capture
    const correlationId = "test-corr-1";
    transport.simulateMessage(
      connA.id,
      createToolCallFrameMessage(
        "node-a",
        "camera.capture",
        {},
        {
          correlationId,
        },
      ),
    );

    // Node-B should receive the forwarded tool_call
    await waitForCondition(() => findSentFrame(connB, "tool_call") !== undefined);
    const forwarded = findSentFrame(connB, "tool_call");
    expect(forwarded).toBeDefined();
    expect(forwarded?.correlationId).toMatch(/^route-/);
    const routingCorrelationId = forwarded?.correlationId as string;

    // Node-B responds with tool_result
    transport.simulateMessage(
      connB.id,
      createToolResultFrameMessage(
        "node-b",
        "camera.capture",
        { photo: "data:image/..." },
        routingCorrelationId,
      ),
    );

    // Node-A should receive the result with original correlationId
    await waitForCondition(() => findSentFrame(connA, "tool_result") !== undefined);
    const result = findSentFrame(connA, "tool_result");
    expect(result).toBeDefined();
    expect(result?.correlationId).toBe(correlationId);
  });

  test("tool_call for unknown tool — tool_error sent to source", async () => {
    registerNode(transport, "node-a", [{ name: "search" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 1);

    // Disable queue for this test by recreating gateway
    await gateway.stop();
    gateway = createGateway(
      { toolRouting: { maxQueuedCalls: 0 } },
      { transport, auth: createTestAuthenticator() },
    );
    await gateway.start(0);

    const connA2 = registerNode(transport, "node-a2", [{ name: "search" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 1);

    transport.simulateMessage(connA2.id, createToolCallFrameMessage("node-a2", "nonexistent-tool"));

    await waitForCondition(() => findSentFrame(connA2, "tool_error") !== undefined);
    const error = findSentFrame(connA2, "tool_error");
    expect(error).toBeDefined();
    const payload = error?.payload as Record<string, unknown>;
    expect(payload.code).toBe("not_found");
  });

  test("target node disconnects mid-call — error sent to source", async () => {
    const connA = registerNode(transport, "node-a", [{ name: "search" }]);
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 2);

    transport.simulateMessage(
      connA.id,
      createToolCallFrameMessage(
        "node-a",
        "camera.capture",
        {},
        {
          correlationId: "corr-dc",
        },
      ),
    );

    await waitForCondition(() => findSentFrame(connB, "tool_call") !== undefined);

    // Disconnect node-B
    transport.simulateClose(connB.id);

    // Node-A should receive a tool_error
    await waitForCondition(() => findSentFrame(connA, "tool_error") !== undefined);
    const error = findSentFrame(connA, "tool_error");
    expect(error).toBeDefined();
    expect(error?.correlationId).toBe("corr-dc");
  });

  test("tool routing disabled (no config) — tool frames are no-op", async () => {
    await gateway.stop();
    // Create gateway without toolRouting config
    gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
    await gateway.start(0);

    const connA = registerNode(transport, "node-a", [{ name: "search" }]);
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 2);

    transport.simulateMessage(connA.id, createToolCallFrameMessage("node-a", "camera.capture"));

    // Give a moment for any async processing
    await new Promise((r) => setTimeout(r, 50));

    // Node-B should NOT receive any forwarded tool_call
    const forwarded = findSentFrame(connB, "tool_call");
    expect(forwarded).toBeUndefined();

    // Node-A should NOT receive any error (frame was silently dropped as no-op)
    const error = findSentFrame(connA, "tool_error");
    expect(error).toBeUndefined();
  });

  test("multiple nodes with tool — routes to highest capacity", async () => {
    const connA = registerNode(transport, "node-a", [{ name: "code" }]);
    const connB = registerNode(transport, "node-b", [{ name: "search" }], {
      current: 7,
      max: 10,
      available: 3,
    });
    const connC = registerNode(transport, "node-c", [{ name: "search" }], {
      current: 2,
      max: 10,
      available: 8,
    });
    await waitForCondition(() => gateway.nodeRegistry().size() === 3);

    transport.simulateMessage(connA.id, createToolCallFrameMessage("node-a", "search"));

    // Should route to node-c (higher available capacity)
    await waitForCondition(
      () =>
        findSentFrame(connC, "tool_call") !== undefined ||
        findSentFrame(connB, "tool_call") !== undefined,
    );

    const sentC = findSentFrame(connC, "tool_call");
    expect(sentC).toBeDefined();
    const sentB = findSentFrame(connB, "tool_call");
    expect(sentB).toBeUndefined();
  });

  test("queue: tool_call arrives with no capable node, node connects later, call dequeued", async () => {
    const connA = registerNode(transport, "node-a", [{ name: "search" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 1);

    // Send tool_call for a tool no node has
    transport.simulateMessage(
      connA.id,
      createToolCallFrameMessage(
        "node-a",
        "camera.capture",
        {},
        {
          correlationId: "corr-queued",
        },
      ),
    );

    // No error yet — should be queued
    await new Promise((r) => setTimeout(r, 50));
    const errorBefore = findSentFrame(connA, "tool_error");
    expect(errorBefore).toBeUndefined();

    // Register a node with camera.capture
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 2);

    // The queued call should be dequeued and routed to node-b
    await waitForCondition(() => findSentFrame(connB, "tool_call") !== undefined);
    const forwarded = findSentFrame(connB, "tool_call");
    expect(forwarded).toBeDefined();
  });

  test("affinity: tool_call routes to preferred node over higher-capacity alternative", async () => {
    await gateway.stop();
    gateway = createGateway(
      {
        toolRouting: {
          affinities: [{ pattern: "camera.*", nodeId: "node-b" }],
        },
      },
      { transport, auth: createTestAuthenticator() },
    );
    await gateway.start(0);

    const connA = registerNode(transport, "node-a", [{ name: "code" }]);
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }], {
      current: 8,
      max: 10,
      available: 2,
    });
    const connC = registerNode(transport, "node-c", [{ name: "camera.capture" }], {
      current: 1,
      max: 10,
      available: 9,
    });
    await waitForCondition(() => gateway.nodeRegistry().size() === 3);

    transport.simulateMessage(connA.id, createToolCallFrameMessage("node-a", "camera.capture"));

    // Should route to node-b (affinity) despite node-c having higher capacity
    await waitForCondition(
      () =>
        findSentFrame(connB, "tool_call") !== undefined ||
        findSentFrame(connC, "tool_call") !== undefined,
    );

    expect(findSentFrame(connB, "tool_call")).toBeDefined();
    expect(findSentFrame(connC, "tool_call")).toBeUndefined();
  });

  test("tool_error from target forwarded back with original correlationId", async () => {
    const connA = registerNode(transport, "node-a", [{ name: "search" }]);
    const connB = registerNode(transport, "node-b", [{ name: "camera.capture" }]);
    await waitForCondition(() => gateway.nodeRegistry().size() === 2);

    const correlationId = "corr-err-fwd";
    transport.simulateMessage(
      connA.id,
      createToolCallFrameMessage(
        "node-a",
        "camera.capture",
        {},
        {
          correlationId,
        },
      ),
    );

    await waitForCondition(() => findSentFrame(connB, "tool_call") !== undefined);
    const forwarded = findSentFrame(connB, "tool_call");
    const routingCorrelationId = forwarded?.correlationId as string;

    // Node-B sends tool_error
    transport.simulateMessage(
      connB.id,
      createToolErrorFrameMessage(
        "node-b",
        "camera.capture",
        "execution_error",
        "Camera offline",
        routingCorrelationId,
      ),
    );

    // Node-A should receive the error with original correlationId
    await waitForCondition(() => findSentFrame(connA, "tool_error") !== undefined);
    const error = findSentFrame(connA, "tool_error");
    expect(error).toBeDefined();
    expect(error?.correlationId).toBe(correlationId);
  });
});
