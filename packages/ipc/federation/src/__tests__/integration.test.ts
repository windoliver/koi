/**
 * Integration test — end-to-end flow using multi-zone harness.
 *
 * 1. Create 3-zone harness
 * 2. Zone A publishes zone_agent_registered event
 * 3. Zone B syncs → event appears in B's log
 * 4. Federation middleware on Zone B routes targetZoneId correctly
 * 5. Disposal cleans up
 */
import { describe, expect, mock, test } from "bun:test";
import type { ToolRequest, ToolResponse } from "@koi/core";
import { zoneId } from "@koi/core";
import { createFederationMiddleware } from "../federation-middleware.js";
import { createSyncEngine } from "../sync-engine.js";
import type { FederationSyncEvent } from "../types.js";
import { createMultiZoneHarness, createTestEvent } from "./harness.js";

describe("federation integration", () => {
  test("end-to-end: publish → sync → middleware routing", async () => {
    // 1. Create 3-zone harness
    const harness = createMultiZoneHarness(["zone-a", "zone-b", "zone-c"]);

    // 2. Zone A publishes a zone_agent_registered event
    const agentEvent: FederationSyncEvent = {
      kind: "zone_agent_registered",
      originZoneId: zoneId("zone-a"),
      sequence: 1,
      vectorClock: { "zone-a": 1 },
      data: { agentId: "agent-1", name: "test-agent" },
      emittedAt: Date.now(),
    };
    harness.publish("zone-a", agentEvent);

    // 3. Zone B syncs → event appears in B's log
    const engineB = createSyncEngine({
      localZoneId: zoneId("zone-b"),
      remoteClients: new Map([["zone-a", harness.getClient("zone-b")]]),
      pollIntervalMs: 100_000,
      minPollIntervalMs: 50,
      maxPollIntervalMs: 200_000,
      snapshotThreshold: 1000,
      clockPruneAfterMs: 86_400_000,
    });

    const receivedEvents: FederationSyncEvent[] = [];
    engineB.onEvent((e) => {
      receivedEvents.push(e);
    });

    await engineB.sync();

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.kind).toBe("zone_agent_registered");
    expect(receivedEvents[0]?.data.agentId).toBe("agent-1");

    const logB = engineB.getEventLog("zone-a");
    expect(logB).toHaveLength(1);

    // 4. Federation middleware on Zone B routes to zone-a
    const mockRemoteRpc = mock(() =>
      Promise.resolve({
        ok: true as const,
        value: { output: "remote-exec-result", metadata: {} } satisfies ToolResponse,
      }),
    );

    const middleware = createFederationMiddleware({
      localZoneId: zoneId("zone-b"),
      remoteClients: new Map([["zone-a", { rpc: mockRemoteRpc as never }]]),
    });

    // Route to zone-a
    const request: ToolRequest = { toolId: "test-tool", input: { x: 1 } };
    const ctx = { metadata: { targetZoneId: "zone-a" } };
    const next = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));

    const result = await middleware.wrapToolCall?.(ctx as never, request, next);
    expect(next).not.toHaveBeenCalled();
    expect(mockRemoteRpc).toHaveBeenCalledTimes(1);
    expect(result?.output).toBe("remote-exec-result");

    // Route to self (zone-b) → passthrough
    const ctxLocal = { metadata: { targetZoneId: "zone-b" } };
    await middleware.wrapToolCall?.(ctxLocal as never, request, next);
    expect(next).toHaveBeenCalledTimes(1);

    // No target zone → passthrough
    const ctxNone = { metadata: {} };
    const next2 = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));
    await middleware.wrapToolCall?.(ctxNone as never, request, next2);
    expect(next2).toHaveBeenCalledTimes(1);

    // 5. Disposal cleans up
    await engineB[Symbol.asyncDispose]();
    expect(engineB.getCursor("zone-a")).toBeUndefined();
  });

  test("multi-zone sync: 3 zones each publishing events", async () => {
    const harness = createMultiZoneHarness(["zone-a", "zone-b", "zone-c"]);

    // Each zone publishes events
    for (let i = 1; i <= 3; i++) {
      harness.publish("zone-a", createTestEvent("zone-a", i));
      harness.publish("zone-b", createTestEvent("zone-b", i));
      harness.publish("zone-c", createTestEvent("zone-c", i));
    }

    // Zone A monitors zone-b and zone-c
    const engineA = createSyncEngine({
      localZoneId: zoneId("zone-a"),
      remoteClients: new Map([
        ["zone-b", harness.getClient("zone-a")],
        ["zone-c", harness.getClient("zone-a")],
      ]),
      pollIntervalMs: 100_000,
      minPollIntervalMs: 50,
      maxPollIntervalMs: 200_000,
      snapshotThreshold: 1000,
      clockPruneAfterMs: 86_400_000,
    });

    await engineA.sync();

    // Should have 3 events from each remote zone
    expect(engineA.getEventLog("zone-b")).toHaveLength(3);
    expect(engineA.getEventLog("zone-c")).toHaveLength(3);
    expect(engineA.getCursor("zone-b")?.lastSequence).toBe(3);
    expect(engineA.getCursor("zone-c")?.lastSequence).toBe(3);

    await engineA[Symbol.asyncDispose]();
  });
});
