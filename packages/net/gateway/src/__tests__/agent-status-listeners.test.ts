/**
 * Unit tests for agent status listener error isolation and idempotent unsubscribe
 * in createNodeConnectionHandler.
 */

import { describe, expect, mock, test } from "bun:test";
import { createNodeConnectionHandler } from "../node-connection.js";
import type { AgentStatusEntry } from "../node-handler.js";
import { createInMemoryNodeRegistry } from "../node-registry.js";
import type { TransportConnection } from "../transport.js";

function createTestHandler(): ReturnType<typeof createNodeConnectionHandler> {
  const registry = createInMemoryNodeRegistry();
  const emitNodeEvent = mock(() => {});
  const onEvict = mock((_connId: string) => {});
  return createNodeConnectionHandler(registry, emitNodeEvent, onEvict);
}

function createFakeConnection(id: string): TransportConnection {
  return {
    id,
    send: mock(() => 1),
    close: mock(() => {}),
    remoteAddress: "127.0.0.1",
  };
}

function handshakeAndRegister(
  handler: ReturnType<typeof createNodeConnectionHandler>,
  nodeId: string,
): TransportConnection {
  const conn = createFakeConnection(`conn-${nodeId}`);

  handler.handleFirstMessage(
    conn,
    JSON.stringify({
      kind: "node:handshake",
      nodeId,
      agentId: "",
      correlationId: "hs-1",
      payload: { nodeId, version: "1.0.0", capacity: { current: 0, max: 10, available: 10 } },
    }),
  );

  handler.handleMessage(
    conn,
    JSON.stringify({
      kind: "node:capabilities",
      nodeId,
      agentId: "",
      correlationId: "caps-1",
      payload: { nodeType: "full", tools: [] },
    }),
  );

  return conn;
}

function sendAgentStatus(
  handler: ReturnType<typeof createNodeConnectionHandler>,
  conn: TransportConnection,
  nodeId: string,
  agentId: string,
  state: string,
): void {
  handler.handleMessage(
    conn,
    JSON.stringify({
      kind: "agent:status",
      nodeId,
      agentId: "",
      correlationId: crypto.randomUUID(),
      payload: {
        agents: [{ agentId, state, turnCount: 1, lastActivityMs: Date.now() }],
      },
    }),
  );
}

describe("agent status listener isolation", () => {
  test("throwing listener does not break subsequent listeners", () => {
    const handler = createTestHandler();
    const conn = handshakeAndRegister(handler, "n1");
    const received: string[] = [];

    // First listener throws
    handler.onAgentStatus(() => {
      throw new Error("listener boom");
    });
    // Second listener should still receive events
    handler.onAgentStatus((entry: AgentStatusEntry) => {
      received.push(entry.agentId);
    });

    sendAgentStatus(handler, conn, "n1", "a1", "running");

    expect(received).toEqual(["a1"]);
  });

  test("double unsubscribe is safe (idempotent)", () => {
    const handler = createTestHandler();
    const conn = handshakeAndRegister(handler, "n1");
    const received: string[] = [];

    const unsub = handler.onAgentStatus((entry: AgentStatusEntry) => {
      received.push(entry.agentId);
    });

    // Double unsubscribe should not throw
    unsub();
    unsub();

    sendAgentStatus(handler, conn, "n1", "a1", "running");

    expect(received).toEqual([]);
  });

  test("unsubscribe after clear is safe", () => {
    const handler = createTestHandler();
    const received: string[] = [];

    const unsub = handler.onAgentStatus((entry: AgentStatusEntry) => {
      received.push(entry.agentId);
    });

    handler.clear();
    // Unsubscribe after clear should not throw
    unsub();

    expect(received).toEqual([]);
  });
});
