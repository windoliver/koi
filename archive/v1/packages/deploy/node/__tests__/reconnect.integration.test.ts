/**
 * Integration tests for WebSocket reconnection behavior.
 *
 * Tests the transport layer's ability to reconnect after:
 * - Server-initiated disconnects (non-clean close)
 * - Clean closes (no retry)
 * - Retry exhaustion
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTransport } from "../src/connection/transport.js";
import type { NodeEvent } from "../src/types.js";
import type { MockGateway } from "./helpers/mock-gateway.js";
import { createMockGateway } from "./helpers/mock-gateway.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reconnection integration", () => {
  let gateway: MockGateway;

  beforeEach(() => {
    gateway = createMockGateway();
  });

  afterEach(() => {
    gateway.close();
  });

  it("connects and sends frames", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 100,
        reconnectMaxDelay: 500,
        reconnectMultiplier: 2,
        reconnectJitter: 0,
        maxRetries: 3,
      },
      {
        interval: 60_000, // Long interval to avoid heartbeat noise
        timeout: 5_000,
      },
    );

    await transport.connect();
    expect(transport.state()).toBe("connected");

    transport.send({
      nodeId: "test-node",
      agentId: "agent-1",
      correlationId: "corr-1",
      kind: "agent:message",
      payload: { text: "hello" },
    });

    await gateway.waitForFrames(1);
    expect(gateway.receivedFrames[0]?.kind).toBe("agent:message");

    await transport.close();
  });

  it("emits connected event on first connect", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 100,
        reconnectMaxDelay: 500,
        reconnectMultiplier: 2,
        reconnectJitter: 0,
        maxRetries: 3,
      },
      {
        interval: 60_000,
        timeout: 5_000,
      },
    );

    const events: NodeEvent[] = [];
    transport.onEvent((e) => events.push(e));

    await transport.connect();
    const types = events.map((e) => e.type);
    expect(types).toContain("connected");

    await transport.close();
  });

  it("receives frames from gateway", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 100,
        reconnectMaxDelay: 500,
        reconnectMultiplier: 2,
        reconnectJitter: 0,
        maxRetries: 3,
      },
      {
        interval: 60_000,
        timeout: 5_000,
      },
    );

    const receivedFrames: unknown[] = [];
    transport.onFrame((frame) => receivedFrames.push(frame));

    await transport.connect();
    await gateway.waitForClients(1);

    // Gateway sends a frame to the node
    gateway.broadcast({
      nodeId: "test-node",
      agentId: "agent-1",
      correlationId: "gw-corr-1",
      kind: "agent:dispatch",
      payload: { task: "do something" },
    });

    // Wait for frame to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedFrames.length).toBeGreaterThanOrEqual(1);

    await transport.close();
  });

  it("attempts reconnection after non-clean disconnect", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 50,
        reconnectMaxDelay: 200,
        reconnectMultiplier: 1.5,
        reconnectJitter: 0,
        maxRetries: 5,
      },
      {
        interval: 60_000,
        timeout: 5_000,
      },
    );

    const events: NodeEvent[] = [];
    transport.onEvent((e) => events.push(e));

    await transport.connect();
    expect(transport.state()).toBe("connected");

    // Force a non-clean disconnect from server side
    gateway.disconnectAll(4000, "test: force disconnect");

    // Wait for reconnection cycle
    await new Promise((r) => setTimeout(r, 300));

    const types = events.map((e) => e.type);
    expect(types).toContain("disconnected");
    expect(types).toContain("reconnecting");

    await transport.close();
  });

  it("does not reconnect on clean close", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 50,
        reconnectMaxDelay: 200,
        reconnectMultiplier: 1.5,
        reconnectJitter: 0,
        maxRetries: 5,
      },
      {
        interval: 60_000,
        timeout: 5_000,
      },
    );

    const events: NodeEvent[] = [];
    transport.onEvent((e) => events.push(e));

    await transport.connect();

    // Clean close from server side (code 1000)
    gateway.disconnectAll(1000, "clean close");

    await new Promise((r) => setTimeout(r, 200));

    const types = events.map((e) => e.type);
    expect(types).toContain("disconnected");
    expect(types).not.toContain("reconnecting");

    await transport.close();
  });

  it("reports closed state after close()", async () => {
    const transport = createTransport(
      "test-node",
      {
        url: gateway.url,
        reconnectBaseDelay: 100,
        reconnectMaxDelay: 500,
        reconnectMultiplier: 2,
        reconnectJitter: 0,
        maxRetries: 3,
      },
      {
        interval: 60_000,
        timeout: 5_000,
      },
    );

    await transport.connect();
    await transport.close();
    expect(transport.state()).toBe("closed");
  });
});
