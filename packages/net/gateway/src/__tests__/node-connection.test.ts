import { beforeEach, describe, expect, test } from "bun:test";
import type { AdvertisedTool, CapacityReport } from "@koi/core";
import type { Gateway } from "../gateway.js";
import { createGateway } from "../gateway.js";
import type { MockTransport } from "./test-utils.js";
import { createMockTransport, createTestAuthenticator, waitForCondition } from "./test-utils.js";

function nodeFrame(
  kind: string,
  nodeId: string,
  payload: unknown,
  correlationId = `${kind}:1`,
): string {
  return JSON.stringify({
    kind,
    nodeId,
    agentId: "",
    correlationId,
    payload,
  });
}

function handshake(nodeId: string, capacity?: CapacityReport): string {
  return nodeFrame("node:handshake", nodeId, {
    nodeId,
    version: "0.0.0-test",
    capacity: capacity ?? { current: 0, max: 4, available: 4 },
  });
}

function capabilities(
  nodeId: string,
  tools: readonly AdvertisedTool[],
  nodeType: "full" | "thin" = "thin",
): string {
  return nodeFrame("node:capabilities", nodeId, { nodeType, tools });
}

function heartbeat(nodeId: string): string {
  return nodeFrame("node:heartbeat", nodeId, null);
}

function toolsUpdated(
  nodeId: string,
  added: readonly AdvertisedTool[],
  removed: readonly string[],
): string {
  return nodeFrame("node:tools_updated", nodeId, { added, removed });
}

describe("node-gateway capability advertising", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(async () => {
    transport = createMockTransport();
    gateway = createGateway(
      { nodeHeartbeatTimeoutMs: 200, nodeSweepIntervalMs: 10 },
      { transport, auth: createTestAuthenticator() },
    );
    await gateway.start(0);
  });

  test("node handshakes, advertises capabilities, and can be discovered by tool", async () => {
    const events: string[] = [];
    gateway.onNodeEvent((event) => {
      events.push(event.kind);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, handshake("device-1"));
    transport.simulateMessage(conn.id, capabilities("device-1", [{ name: "device.location" }]));

    await waitForCondition(() => gateway.nodeRegistry().size() === 1);

    expect(JSON.parse(conn.sent[0] ?? "{}")).toMatchObject({
      kind: "node:registered",
      nodeId: "device-1",
    });
    expect(gateway.nodeRegistry().lookup("device-1")?.nodeType).toBe("thin");
    expect(gateway.discoverNodeCapabilities("device.location")).toEqual([
      {
        nodeId: "device-1",
        nodeType: "thin",
        tools: [{ name: "device.location" }],
      },
    ]);
    expect(events).toContain("registered");
  });

  test("heartbeat keeps a node online until the stale-node sweep marks it offline", async () => {
    const events: string[] = [];
    gateway.onNodeEvent((event) => {
      events.push(event.kind);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, handshake("device-1"));
    transport.simulateMessage(conn.id, capabilities("device-1", [{ name: "device.location" }]));
    await waitForCondition(() => gateway.nodeRegistry().size() === 1);

    transport.simulateMessage(conn.id, heartbeat("device-1"));
    await waitForCondition(() => events.includes("heartbeat"));
    expect(gateway.nodeRegistry().lookup("device-1")).toBeDefined();

    await waitForCondition(() => gateway.nodeRegistry().lookup("device-1") === undefined, 1000);
    expect(conn.closed).toBe(true);
    expect(events).toContain("offline");
  });

  test("capability change notifications update discovery results", async () => {
    const events: string[] = [];
    gateway.onNodeEvent((event) => {
      events.push(event.kind);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, handshake("device-1"));
    transport.simulateMessage(conn.id, capabilities("device-1", [{ name: "device.location" }]));
    await waitForCondition(() => gateway.discoverNodeCapabilities("device.location").length === 1);

    transport.simulateMessage(
      conn.id,
      toolsUpdated("device-1", [{ name: "device.camera" }], ["device.location"]),
    );

    await waitForCondition(() => events.includes("capabilities_updated"));
    expect(gateway.discoverNodeCapabilities("device.location")).toEqual([]);
    expect(gateway.discoverNodeCapabilities("device.camera")).toHaveLength(1);
  });

  test("gateway can query a connected node for its current capabilities", async () => {
    const events: string[] = [];
    gateway.onNodeEvent((event) => {
      events.push(event.kind);
    });

    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, handshake("device-1"));
    transport.simulateMessage(conn.id, capabilities("device-1", [{ name: "device.location" }]));
    await waitForCondition(() => gateway.discoverNodeCapabilities("device.location").length === 1);

    const query = gateway.queryNodeCapabilities("device-1");

    expect(query.ok).toBe(true);
    expect(JSON.parse(conn.sent.at(-1) ?? "{}")).toMatchObject({
      kind: "node:capabilities_query",
      nodeId: "device-1",
    });

    transport.simulateMessage(
      conn.id,
      capabilities("device-1", [{ name: "device.camera" }], "full"),
    );

    await waitForCondition(
      () => events.filter((kind) => kind === "capabilities_updated").length === 1,
    );
    expect(gateway.discoverNodeCapabilities("device.location")).toEqual([]);
    expect(gateway.discoverNodeCapabilities("device.camera")).toEqual([
      {
        nodeId: "device-1",
        nodeType: "full",
        tools: [{ name: "device.camera" }],
      },
    ]);
    expect(gateway.nodeRegistry().lookup("device-1")?.nodeType).toBe("full");
  });

  test("gateway rejects capability queries before node registration completes", async () => {
    const conn = transport.simulateOpen();
    transport.simulateMessage(conn.id, handshake("device-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const query = gateway.queryNodeCapabilities("device-1");

    expect(query.ok).toBe(false);
    expect(conn.sent).toEqual([]);
  });
});
