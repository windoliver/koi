/**
 * E2E tests: real Bun.serve WebSocket server + real WebSocket clients acting as nodes.
 * Tests the full wire path: TCP connect → WS upgrade → node:handshake → capabilities →
 * registration → heartbeat → capacity → sendToNode → disconnect → deregistration.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { NodeRegistryEvent } from "../node-registry.js";
import type { BunTransport } from "../transport.js";
import { createBunTransport } from "../transport.js";
import type { ConnectFrame, GatewayFrame, Session } from "../types.js";
import {
  createConnectMessage,
  createNodeCapabilitiesMessage,
  createNodeCapacityMessage,
  createNodeHandshakeMessage,
  createNodeHeartbeatMessage,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a real WebSocket and collect messages. */
function connectWs(port: number): {
  ws: WebSocket;
  messages: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
} {
  const messages: string[] = [];

  // let justified: deferred promise resolve
  let resolveOpened: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpened = r;
  });
  // let justified: deferred promise resolve
  let resolveClosed: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => {
    resolveClosed = r;
  });

  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.addEventListener("open", () => resolveOpened());
  ws.addEventListener("message", (e) => messages.push(String(e.data)));
  ws.addEventListener("close", (e) => resolveClosed({ code: e.code, reason: e.reason }));

  return { ws, messages, opened, closed };
}

/** Wait until the messages array reaches `count` entries. */
async function waitForMessages(
  messages: readonly string[],
  count: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (messages.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} messages (got ${messages.length})`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Wait for a predicate to become true. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Node connections e2e (real WebSocket)", () => {
  let transport: BunTransport;
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.stop();
  });

  test("full node lifecycle: handshake → capabilities → registered → heartbeat → capacity → disconnect → deregistered", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s1", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const events: NodeRegistryEvent[] = [];
    gateway.onNodeEvent((e) => events.push(e));

    // 1. Connect as a node
    const { ws, opened, closed } = connectWs(port);
    await opened;

    // 2. Send node:handshake as first message
    ws.send(createNodeHandshakeMessage("node-e2e-1"));

    // 3. Send node:capabilities
    ws.send(
      createNodeCapabilitiesMessage("node-e2e-1", [
        { name: "code_exec", description: "Execute code" },
        { name: "search", description: "Web search" },
      ]),
    );

    // 4. Wait for registration
    await waitFor(() => gateway.nodeRegistry().size() === 1);

    const node = gateway.nodeRegistry().lookup("node-e2e-1");
    expect(node).toBeDefined();
    expect(node?.nodeId).toBe("node-e2e-1");
    expect(node?.mode).toBe("full");
    expect(node?.tools).toHaveLength(2);

    expect(events.some((e) => e.kind === "registered")).toBe(true);

    // 5. Send heartbeat
    ws.send(createNodeHeartbeatMessage("node-e2e-1"));
    await waitFor(() => events.some((e) => e.kind === "heartbeat"));

    // 6. Send capacity update
    const newCapacity = { current: 3, max: 10, available: 7 };
    ws.send(createNodeCapacityMessage("node-e2e-1", newCapacity));
    await waitFor(() => events.some((e) => e.kind === "capacity_updated"));

    const updated = gateway.nodeRegistry().lookup("node-e2e-1");
    expect(updated?.capacity).toEqual(newCapacity);

    // 7. Disconnect
    ws.close();
    const closeEvt = await closed;
    expect([1000, 1005]).toContain(closeEvt.code); // 1000 = clean close, 1005 = no close frame

    // 8. Node should be deregistered
    await waitFor(() => gateway.nodeRegistry().size() === 0);
    expect(events.some((e) => e.kind === "deregistered")).toBe(true);
  });

  test("sendToNode delivers a frame to a connected node over real WebSocket", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s1", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    // Connect node
    const { ws, messages, opened } = connectWs(port);
    await opened;

    ws.send(createNodeHandshakeMessage("node-recv"));
    ws.send(createNodeCapabilitiesMessage("node-recv", [{ name: "exec" }]));
    await waitFor(() => gateway.nodeRegistry().size() === 1);

    // Wait for registration ack first
    await waitForMessages(messages, 1);

    // Gateway sends a tool_call frame to the node
    const result = gateway.sendToNode("node-recv", {
      kind: "tool_call",
      nodeId: "node-recv",
      agentId: "orchestrator",
      correlationId: "corr-42",
      payload: { tool: "exec", args: { code: "console.log('hi')" } },
    });
    expect(result.ok).toBe(true);

    // Node should receive the tool_call after the ack
    await waitForMessages(messages, 2);

    const received = JSON.parse(messages[1] as string) as {
      kind: string;
      correlationId: string;
      payload: { tool: string };
    };
    expect(received.kind).toBe("tool_call");
    expect(received.correlationId).toBe("corr-42");
    expect(received.payload.tool).toBe("exec");

    ws.close();
  });

  test("mixed client + node on same gateway over real WebSocket", async () => {
    transport = createBunTransport();
    // let justified: counter for unique sessions
    let sessionCounter = 0;
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        sessionCounter++;
        return {
          ok: true as const,
          sessionId: `session-${sessionCounter}`,
          agentId: "agent",
          metadata: {},
        };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const dispatched: GatewayFrame[] = [];
    gateway.onFrame((_session: Session, frame: GatewayFrame) => {
      dispatched.push(frame);
    });

    const nodeEvents: NodeRegistryEvent[] = [];
    gateway.onNodeEvent((e) => nodeEvents.push(e));

    // Client connects
    const client = connectWs(port);
    await client.opened;
    client.ws.send(createConnectMessage("token"));
    await waitForMessages(client.messages, 1); // auth ack

    // Node connects
    const node = connectWs(port);
    await node.opened;
    node.ws.send(createNodeHandshakeMessage("node-mixed"));
    node.ws.send(createNodeCapabilitiesMessage("node-mixed", [{ name: "tool1" }]));
    await waitFor(() => gateway.nodeRegistry().size() === 1);

    // Client sends a request frame
    client.ws.send(
      JSON.stringify({
        kind: "request",
        id: "mixed-req-1",
        seq: 0,
        timestamp: Date.now(),
        payload: { action: "test" },
      }),
    );
    await waitForMessages(client.messages, 2); // request ack

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.id).toBe("mixed-req-1");

    // Node sends heartbeat
    node.ws.send(createNodeHeartbeatMessage("node-mixed"));
    await waitFor(() => nodeEvents.some((e) => e.kind === "heartbeat"));

    // Wait for registration ack on node
    await waitForMessages(node.messages, 1);

    // Gateway sends frame to node
    const sendResult = gateway.sendToNode("node-mixed", {
      kind: "tool_call",
      nodeId: "node-mixed",
      agentId: "agent",
      correlationId: "c1",
      payload: null,
    });
    expect(sendResult.ok).toBe(true);
    await waitForMessages(node.messages, 2);

    // Verify independence — node has 2 messages (ack + tool_call), client has 2
    expect(node.messages).toHaveLength(2);
    expect(client.messages).toHaveLength(2);

    client.ws.close();
    node.ws.close();
  });

  test("multiple nodes with different tools → findByTool returns correct subsets", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    // Connect 3 nodes with overlapping tool sets
    const nodeA = connectWs(port);
    await nodeA.opened;
    nodeA.ws.send(createNodeHandshakeMessage("node-a"));
    nodeA.ws.send(
      createNodeCapabilitiesMessage("node-a", [{ name: "search" }, { name: "code_exec" }]),
    );

    const nodeB = connectWs(port);
    await nodeB.opened;
    nodeB.ws.send(createNodeHandshakeMessage("node-b"));
    nodeB.ws.send(
      createNodeCapabilitiesMessage("node-b", [{ name: "search" }, { name: "browse" }]),
    );

    const nodeC = connectWs(port);
    await nodeC.opened;
    nodeC.ws.send(createNodeHandshakeMessage("node-c"));
    nodeC.ws.send(createNodeCapabilitiesMessage("node-c", [{ name: "code_exec" }]));

    await waitFor(() => gateway.nodeRegistry().size() === 3);

    // Verify tool index
    const searchNodes = gateway.nodeRegistry().findByTool("search");
    expect(searchNodes).toHaveLength(2);
    expect(searchNodes.map((n) => n.nodeId).sort()).toEqual(["node-a", "node-b"]);

    const codeNodes = gateway.nodeRegistry().findByTool("code_exec");
    expect(codeNodes).toHaveLength(2);
    expect(codeNodes.map((n) => n.nodeId).sort()).toEqual(["node-a", "node-c"]);

    // Disconnect node-a → only node-a deregistered
    nodeA.ws.close();
    await waitFor(() => gateway.nodeRegistry().size() === 2);

    expect(gateway.nodeRegistry().lookup("node-a")).toBeUndefined();
    expect(gateway.nodeRegistry().lookup("node-b")).toBeDefined();
    expect(gateway.nodeRegistry().lookup("node-c")).toBeDefined();

    // search now only has node-b
    expect(gateway.nodeRegistry().findByTool("search")).toHaveLength(1);

    nodeB.ws.close();
    nodeC.ws.close();
  });

  test("registration ack sent to node after successful registration", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s1", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const { ws, messages, opened } = connectWs(port);
    await opened;

    ws.send(createNodeHandshakeMessage("node-ack"));
    ws.send(createNodeCapabilitiesMessage("node-ack", [{ name: "tool1" }]));

    await waitFor(() => gateway.nodeRegistry().size() === 1);

    // Node should have received the node:registered ack
    await waitForMessages(messages, 1);
    const ack = JSON.parse(messages[0] as string) as {
      kind: string;
      nodeId: string;
      payload: { registeredAt: number };
    };
    expect(ack.kind).toBe("node:registered");
    expect(ack.nodeId).toBe("node-ack");
    expect(ack.payload.registeredAt).toBeGreaterThan(0);

    ws.close();
  });

  test("node reconnect with same nodeId evicts old connection", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s1", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const events: NodeRegistryEvent[] = [];
    gateway.onNodeEvent((e) => events.push(e));

    // First node connects
    const node1 = connectWs(port);
    await node1.opened;
    node1.ws.send(createNodeHandshakeMessage("node-reconn"));
    node1.ws.send(createNodeCapabilitiesMessage("node-reconn", [{ name: "tool1" }]));
    await waitFor(() => gateway.nodeRegistry().size() === 1);

    // Second node connects with same nodeId → evicts first
    const node2 = connectWs(port);
    await node2.opened;
    node2.ws.send(createNodeHandshakeMessage("node-reconn"));
    node2.ws.send(createNodeCapabilitiesMessage("node-reconn", [{ name: "tool1" }]));

    // Old connection should be closed
    const closeEvt = await node1.closed;
    expect(closeEvt.code).toBe(4014);

    // New node should be registered
    await waitFor(() => {
      const n = gateway.nodeRegistry().lookup("node-reconn");
      return n !== undefined;
    });
    expect(gateway.nodeRegistry().size()).toBe(1);

    // Events: registered, deregistered, registered
    expect(events.filter((e) => e.kind === "registered").length).toBe(2);
    expect(events.filter((e) => e.kind === "deregistered").length).toBe(1);

    node2.ws.close();
  });

  test("stale node evicted after heartbeat timeout", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s1", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway(
      { nodeHeartbeatTimeoutMs: 200, sweepIntervalMs: 50 },
      { transport, auth },
    );
    await gateway.start(0);
    const port = transport.port();

    const events: NodeRegistryEvent[] = [];
    gateway.onNodeEvent((e) => events.push(e));

    const { ws, closed, opened } = connectWs(port);
    await opened;
    ws.send(createNodeHandshakeMessage("node-stale"));
    ws.send(createNodeCapabilitiesMessage("node-stale", [{ name: "tool1" }]));
    await waitFor(() => gateway.nodeRegistry().size() === 1);

    // Don't send heartbeats — wait for eviction
    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4013);

    await waitFor(() => gateway.nodeRegistry().size() === 0);
    expect(events.some((e) => e.kind === "deregistered")).toBe(true);
  });

  test("invalid first message closes WebSocket with 4002", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({}, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    // Send invalid JSON as first message
    const { ws, closed, opened } = connectWs(port);
    await opened;
    ws.send("not json at all {{{");

    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4002);
  });

  test("auth timeout when node never sends first message", async () => {
    transport = createBunTransport();
    const auth = {
      async authenticate(_frame: ConnectFrame) {
        return { ok: true as const, sessionId: "s", agentId: "a", metadata: {} };
      },
      async validate() {
        return true;
      },
    };
    gateway = createGateway({ authTimeoutMs: 200 }, { transport, auth });
    await gateway.start(0);
    const port = transport.port();

    const { ws, closed, opened } = connectWs(port);
    await opened;

    // Don't send anything — wait for timeout
    const closeEvt = await closed;
    expect(closeEvt.code).toBe(4001);
    ws.close();
  });
});
