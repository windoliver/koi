/**
 * Integration tests for node connections through the gateway.
 *
 * Verifies: registration flow, heartbeat, capacity updates,
 * deregistration on disconnect, multi-node, mixed clients/nodes,
 * error paths, and sendToNode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { NodeRegistryEvent } from "../node-registry.js";
import type { MockTransport } from "./test-utils.js";
import {
  createConnectMessage,
  createMockTransport,
  createNodeCapabilitiesMessage,
  createNodeCapacityMessage,
  createNodeHandshakeMessage,
  createNodeHeartbeatMessage,
  createNodeToolsUpdatedMessage,
  createTestAuthenticator,
  storeHas,
  waitForCondition,
} from "./test-utils.js";

describe("Node connections", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(async () => {
    transport = createMockTransport();
    gateway = createGateway({}, { transport, auth: createTestAuthenticator() });
    await gateway.start(0);
  });

  afterEach(async () => {
    await gateway.stop();
  });

  // -----------------------------------------------------------------------
  // Registration flow
  // -----------------------------------------------------------------------

  describe("registration flow", () => {
    test("node connects with handshake + capabilities → registered in NodeRegistry", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();

      // First message: node:handshake
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      // Second message: node:capabilities
      transport.simulateMessage(
        conn.id,
        createNodeCapabilitiesMessage("node-1", [
          { name: "code_exec", description: "Execute code" },
        ]),
      );

      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      const node = gateway.nodeRegistry().lookup("node-1");
      expect(node).toBeDefined();
      expect(node?.nodeId).toBe("node-1");
      expect(node?.mode).toBe("full");
      expect(node?.tools).toHaveLength(1);
      expect(node?.tools[0]?.name).toBe("code_exec");
      expect(node?.connId).toBe(conn.id);

      // Should have emitted "registered" event
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("registered");
      if (events[0]?.kind === "registered") {
        expect(events[0].node.nodeId).toBe("node-1");
      }
    });

    test("registry.size() increments on registration", async () => {
      expect(gateway.nodeRegistry().size()).toBe(0);

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));

      await waitForCondition(() => gateway.nodeRegistry().size() === 1);
      expect(gateway.nodeRegistry().size()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  describe("heartbeat", () => {
    test("node sends heartbeat → lastHeartbeat updated in registry", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      const beforeHb = gateway.nodeRegistry().lookup("node-1")?.lastHeartbeat ?? 0;

      // Small delay so timestamp differs
      await new Promise((r) => setTimeout(r, 15));

      transport.simulateMessage(conn.id, createNodeHeartbeatMessage("node-1"));
      await waitForCondition(() => events.some((e) => e.kind === "heartbeat"));

      const afterHb = gateway.nodeRegistry().lookup("node-1")?.lastHeartbeat ?? 0;
      expect(afterHb).toBeGreaterThanOrEqual(beforeHb);

      const hbEvent = events.find((e) => e.kind === "heartbeat");
      expect(hbEvent).toBeDefined();
      if (hbEvent?.kind === "heartbeat") {
        expect(hbEvent.nodeId).toBe("node-1");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Capacity update
  // -----------------------------------------------------------------------

  describe("capacity update", () => {
    test("node sends capacity → capacity updated in registry", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      const newCapacity = { current: 5, max: 10, available: 5 };
      transport.simulateMessage(conn.id, createNodeCapacityMessage("node-1", newCapacity));
      await waitForCondition(() => events.some((e) => e.kind === "capacity_updated"));

      const node = gateway.nodeRegistry().lookup("node-1");
      expect(node?.capacity).toEqual(newCapacity);

      const capEvent = events.find((e) => e.kind === "capacity_updated");
      expect(capEvent).toBeDefined();
      if (capEvent?.kind === "capacity_updated") {
        expect(capEvent.nodeId).toBe("node-1");
        expect(capEvent.capacity).toEqual(newCapacity);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Deregistration on disconnect
  // -----------------------------------------------------------------------

  describe("deregistration", () => {
    test("node disconnects → deregistered from NodeRegistry", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      transport.simulateClose(conn.id);

      expect(gateway.nodeRegistry().size()).toBe(0);
      expect(gateway.nodeRegistry().lookup("node-1")).toBeUndefined();

      const deregEvent = events.find((e) => e.kind === "deregistered");
      expect(deregEvent).toBeDefined();
      if (deregEvent?.kind === "deregistered") {
        expect(deregEvent.nodeId).toBe("node-1");
      }
    });

    test("disconnect during pending handshake (before capabilities) cleans up", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      // Close before sending capabilities
      transport.simulateClose(conn.id);

      // Node should not be registered (never completed capabilities)
      expect(gateway.nodeRegistry().size()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-node
  // -----------------------------------------------------------------------

  describe("multi-node", () => {
    test("3 nodes with different tools → findByTool returns correct subsets", async () => {
      const conn1 = transport.simulateOpen();
      transport.simulateMessage(conn1.id, createNodeHandshakeMessage("node-a"));
      transport.simulateMessage(
        conn1.id,
        createNodeCapabilitiesMessage("node-a", [{ name: "search" }, { name: "code_exec" }]),
      );

      const conn2 = transport.simulateOpen();
      transport.simulateMessage(conn2.id, createNodeHandshakeMessage("node-b"));
      transport.simulateMessage(
        conn2.id,
        createNodeCapabilitiesMessage("node-b", [{ name: "search" }, { name: "browse" }]),
      );

      const conn3 = transport.simulateOpen();
      transport.simulateMessage(conn3.id, createNodeHandshakeMessage("node-c"));
      transport.simulateMessage(
        conn3.id,
        createNodeCapabilitiesMessage("node-c", [{ name: "code_exec" }]),
      );

      await waitForCondition(() => gateway.nodeRegistry().size() === 3);

      const searchNodes = gateway.nodeRegistry().findByTool("search");
      expect(searchNodes).toHaveLength(2);
      expect(searchNodes.map((n) => n.nodeId).sort()).toEqual(["node-a", "node-b"]);

      const codeNodes = gateway.nodeRegistry().findByTool("code_exec");
      expect(codeNodes).toHaveLength(2);
      expect(codeNodes.map((n) => n.nodeId).sort()).toEqual(["node-a", "node-c"]);

      const browseNodes = gateway.nodeRegistry().findByTool("browse");
      expect(browseNodes).toHaveLength(1);
      expect(browseNodes[0]?.nodeId).toBe("node-b");
    });

    test("node A disconnects → only A deregistered, others unaffected", async () => {
      const conn1 = transport.simulateOpen();
      transport.simulateMessage(conn1.id, createNodeHandshakeMessage("node-a"));
      transport.simulateMessage(conn1.id, createNodeCapabilitiesMessage("node-a"));

      const conn2 = transport.simulateOpen();
      transport.simulateMessage(conn2.id, createNodeHandshakeMessage("node-b"));
      transport.simulateMessage(conn2.id, createNodeCapabilitiesMessage("node-b"));

      await waitForCondition(() => gateway.nodeRegistry().size() === 2);

      transport.simulateClose(conn1.id);

      expect(gateway.nodeRegistry().size()).toBe(1);
      expect(gateway.nodeRegistry().lookup("node-a")).toBeUndefined();
      expect(gateway.nodeRegistry().lookup("node-b")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Mixed clients and nodes
  // -----------------------------------------------------------------------

  describe("mixed clients and nodes", () => {
    test("client and node connect on same gateway → both work independently", async () => {
      const auth = createTestAuthenticator({
        ok: true,
        sessionId: "s1",
        agentId: "agent-1",
        metadata: {},
      });
      await gateway.stop();
      gateway = createGateway({}, { transport, auth });
      await gateway.start(0);

      const receivedFrames: unknown[] = [];
      gateway.onFrame((_session, frame) => receivedFrames.push(frame));

      const nodeEvents: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => nodeEvents.push(e));

      // Client connects
      const clientConn = transport.simulateOpen();
      transport.simulateMessage(clientConn.id, createConnectMessage("valid-token"));
      await waitForCondition(() => storeHas(gateway.sessions(), "s1"));

      // Node connects
      const nodeConn = transport.simulateOpen();
      transport.simulateMessage(nodeConn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(nodeConn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Client sends a frame → dispatched via onFrame
      const clientFrame = JSON.stringify({
        kind: "request",
        id: "req-1",
        seq: 0,
        timestamp: Date.now(),
        payload: { action: "hello" },
      });
      transport.simulateMessage(clientConn.id, clientFrame);
      await waitForCondition(() => receivedFrames.length >= 1);
      expect(receivedFrames).toHaveLength(1);

      // Node sends heartbeat → handled by node handler
      transport.simulateMessage(nodeConn.id, createNodeHeartbeatMessage("node-1"));
      await waitForCondition(() => nodeEvents.some((e) => e.kind === "heartbeat"));

      // Neither interferes with the other
      expect(gateway.nodeRegistry().size()).toBe(1);
      expect(receivedFrames).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Error paths
  // -----------------------------------------------------------------------

  describe("error paths", () => {
    test("invalid JSON on first message → close with 4002", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, "not valid json {{{");

      await waitForCondition(() => conn.closed);
      expect(conn.closeCode).toBe(4002);
    });

    test("unknown kind on first message → close with 4002", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, JSON.stringify({ kind: "bogus_unknown" }));

      await waitForCondition(() => conn.closed);
      expect(conn.closeCode).toBe(4002);
    });

    test("missing nodeId in handshake → close with error", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(
        conn.id,
        JSON.stringify({
          kind: "node:handshake",
          nodeId: "",
          agentId: "",
          correlationId: "c1",
          payload: {
            nodeId: "",
            version: "1.0.0",
            capacity: { current: 0, max: 10, available: 10 },
          },
        }),
      );

      await waitForCondition(() => conn.closed);
      expect(conn.closed).toBe(true);
    });

    test("node:capabilities without prior handshake → close with error", async () => {
      const conn = transport.simulateOpen();
      // Send capabilities directly as first message (preceded by kind router recognizing node:capabilities)
      transport.simulateMessage(
        conn.id,
        JSON.stringify({
          kind: "node:capabilities",
          nodeId: "node-orphan",
          agentId: "",
          correlationId: "c1",
          payload: { nodeType: "full", tools: [] },
        }),
      );

      await waitForCondition(() => conn.closed);
      expect(conn.closed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Registration ack
  // -----------------------------------------------------------------------

  describe("registration ack", () => {
    test("node receives node:registered ack after successful registration", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));

      const capsCorrelationId = crypto.randomUUID();
      transport.simulateMessage(
        conn.id,
        JSON.stringify({
          kind: "node:capabilities",
          nodeId: "node-1",
          agentId: "",
          correlationId: capsCorrelationId,
          payload: { nodeType: "full", tools: [{ name: "search" }] },
        }),
      );

      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Find the node:registered ack in sent messages
      const ackMsg = conn.sent.find((msg) => {
        const parsed = JSON.parse(msg);
        return parsed.kind === "node:registered";
      });
      expect(ackMsg).toBeDefined();

      const ack = JSON.parse(ackMsg as string);
      expect(ack.kind).toBe("node:registered");
      expect(ack.nodeId).toBe("node-1");
      expect(ack.correlationId).toBe(capsCorrelationId);
      expect(ack.payload.registeredAt).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Node reconnect (eviction)
  // -----------------------------------------------------------------------

  describe("reconnect eviction", () => {
    test("duplicate nodeId reconnects → old connection evicted, new one registers", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      // First node connects
      const conn1 = transport.simulateOpen();
      transport.simulateMessage(conn1.id, createNodeHandshakeMessage("node-dup"));
      transport.simulateMessage(conn1.id, createNodeCapabilitiesMessage("node-dup"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Second node connects with same nodeId → evicts first
      const conn2 = transport.simulateOpen();
      transport.simulateMessage(conn2.id, createNodeHandshakeMessage("node-dup"));
      transport.simulateMessage(conn2.id, createNodeCapabilitiesMessage("node-dup"));

      await waitForCondition(() => {
        const node = gateway.nodeRegistry().lookup("node-dup");
        return node !== undefined && node.connId === conn2.id;
      });

      // Old connection should be closed with 4014
      expect(conn1.closed).toBe(true);
      expect(conn1.closeCode).toBe(4014);

      // New connection should be the registered one
      expect(conn2.closed).toBe(false);
      expect(gateway.nodeRegistry().size()).toBe(1);
      expect(gateway.nodeRegistry().lookup("node-dup")?.connId).toBe(conn2.id);

      // Events: registered, deregistered, registered
      expect(events.filter((e) => e.kind === "registered")).toHaveLength(2);
      expect(events.filter((e) => e.kind === "deregistered")).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Stale node sweep
  // -----------------------------------------------------------------------

  describe("stale node sweep", () => {
    test("node without heartbeat is evicted after threshold", async () => {
      await gateway.stop();
      transport = createMockTransport();
      gateway = createGateway(
        { nodeHeartbeatTimeoutMs: 100, sweepIntervalMs: 50 },
        { transport, auth: createTestAuthenticator() },
      );
      await gateway.start(0);

      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-stale"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-stale"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Don't send heartbeats — wait for sweep to evict
      await waitForCondition(() => gateway.nodeRegistry().size() === 0, 3000);

      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4013);
      expect(events.some((e) => e.kind === "deregistered")).toBe(true);
    });

    test("node sending heartbeats stays alive through sweeps", async () => {
      await gateway.stop();
      transport = createMockTransport();
      gateway = createGateway(
        { nodeHeartbeatTimeoutMs: 200, sweepIntervalMs: 50 },
        { transport, auth: createTestAuthenticator() },
      );
      await gateway.start(0);

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-alive"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-alive"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Send heartbeats to keep alive through several sweep cycles
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 80));
        transport.simulateMessage(conn.id, createNodeHeartbeatMessage("node-alive"));
      }

      // Node should still be registered
      expect(gateway.nodeRegistry().size()).toBe(1);
      expect(conn.closed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // node:tools_updated
  // -----------------------------------------------------------------------

  describe("node:tools_updated", () => {
    test("adds tools to registered node", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(
        conn.id,
        createNodeCapabilitiesMessage("node-1", [{ name: "search" }]),
      );
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      transport.simulateMessage(
        conn.id,
        createNodeToolsUpdatedMessage("node-1", [{ name: "camera.capture" }]),
      );

      await waitForCondition(() => events.some((e) => e.kind === "tools_added"));

      const node = gateway.nodeRegistry().lookup("node-1");
      expect(node?.tools).toHaveLength(2);
      expect(node?.tools.map((t) => t.name).sort()).toEqual(["camera.capture", "search"]);
      expect(gateway.nodeRegistry().findByTool("camera.capture")).toHaveLength(1);

      const addedEvent = events.find((e) => e.kind === "tools_added");
      expect(addedEvent).toBeDefined();
      if (addedEvent?.kind === "tools_added") {
        expect(addedEvent.nodeId).toBe("node-1");
        expect(addedEvent.tools).toHaveLength(1);
        expect(addedEvent.tools[0]?.name).toBe("camera.capture");
      }
    });

    test("removes tools from registered node", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(
        conn.id,
        createNodeCapabilitiesMessage("node-1", [{ name: "search" }, { name: "browse" }]),
      );
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      transport.simulateMessage(conn.id, createNodeToolsUpdatedMessage("node-1", [], ["browse"]));

      await waitForCondition(() => events.some((e) => e.kind === "tools_removed"));

      const node = gateway.nodeRegistry().lookup("node-1");
      expect(node?.tools).toHaveLength(1);
      expect(node?.tools[0]?.name).toBe("search");
      expect(gateway.nodeRegistry().findByTool("browse")).toHaveLength(0);
    });

    test("with mixed add/remove", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(
        conn.id,
        createNodeCapabilitiesMessage("node-1", [{ name: "search" }, { name: "browse" }]),
      );
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      transport.simulateMessage(
        conn.id,
        createNodeToolsUpdatedMessage("node-1", [{ name: "camera.capture" }], ["browse"]),
      );

      await waitForCondition(() => events.some((e) => e.kind === "tools_added"));

      const node = gateway.nodeRegistry().lookup("node-1");
      expect(node?.tools.map((t) => t.name).sort()).toEqual(["camera.capture", "search"]);
    });

    test("before registration is rejected", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      // Send tools_updated before capabilities (still in pending handshake)
      transport.simulateMessage(
        conn.id,
        createNodeToolsUpdatedMessage("node-1", [{ name: "camera.capture" }]),
      );

      await waitForCondition(() => conn.closed);
      expect(conn.closed).toBe(true);
      expect(conn.closeCode).toBe(4002);
    });

    test("with invalid payload is silently handled", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      // Send invalid tools_updated payload (added is not an array)
      transport.simulateMessage(
        conn.id,
        JSON.stringify({
          kind: "node:tools_updated",
          nodeId: "node-1",
          agentId: "",
          correlationId: crypto.randomUUID(),
          payload: { added: "not-an-array" },
        }),
      );

      // Should not crash or disconnect — just swallow the error
      await new Promise((r) => setTimeout(r, 50));
      expect(conn.closed).toBe(false);
      expect(gateway.nodeRegistry().size()).toBe(1);
    });

    test("emits tools_added and tools_removed events", async () => {
      const events: NodeRegistryEvent[] = [];
      gateway.onNodeEvent((e) => events.push(e));

      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(
        conn.id,
        createNodeCapabilitiesMessage("node-1", [{ name: "search" }]),
      );
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      transport.simulateMessage(
        conn.id,
        createNodeToolsUpdatedMessage("node-1", [{ name: "camera.capture" }], ["search"]),
      );

      await waitForCondition(
        () =>
          events.some((e) => e.kind === "tools_added") &&
          events.some((e) => e.kind === "tools_removed"),
      );

      const addedEvent = events.find((e) => e.kind === "tools_added");
      const removedEvent = events.find((e) => e.kind === "tools_removed");
      expect(addedEvent).toBeDefined();
      expect(removedEvent).toBeDefined();
      if (addedEvent?.kind === "tools_added") {
        expect(addedEvent.tools[0]?.name).toBe("camera.capture");
      }
      if (removedEvent?.kind === "tools_removed") {
        expect(removedEvent.toolNames).toEqual(["search"]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // sendToNode
  // -----------------------------------------------------------------------

  describe("sendToNode", () => {
    test("sends frame to connected node", async () => {
      const conn = transport.simulateOpen();
      transport.simulateMessage(conn.id, createNodeHandshakeMessage("node-1"));
      transport.simulateMessage(conn.id, createNodeCapabilitiesMessage("node-1"));
      await waitForCondition(() => gateway.nodeRegistry().size() === 1);

      const frame = {
        kind: "tool_call" as const,
        nodeId: "node-1",
        agentId: "agent-1",
        correlationId: "corr-1",
        payload: { tool: "search", args: { query: "hello" } },
      };

      const result = gateway.sendToNode("node-1", frame);
      expect(result.ok).toBe(true);

      // The node connection should have received the message
      expect(conn.sent.length).toBeGreaterThan(0);
      const lastSent = conn.sent[conn.sent.length - 1];
      expect(lastSent).toBeDefined();
      const parsed = JSON.parse(lastSent as string);
      expect(parsed.kind).toBe("tool_call");
      expect(parsed.correlationId).toBe("corr-1");
    });

    test("returns NOT_FOUND for unknown nodeId", () => {
      const result = gateway.sendToNode("nonexistent", {
        kind: "tool_call",
        nodeId: "nonexistent",
        agentId: "agent-1",
        correlationId: "corr-1",
        payload: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
