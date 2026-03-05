/**
 * Tests for namespace path computation and provisioning.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { computeAgentNamespace, computeGroupNamespace, ensureNamespace } from "../namespace.js";

describe("computeAgentNamespace", () => {
  test("computes all agent-scoped paths from agentId", () => {
    const ns = computeAgentNamespace("agent-123" as AgentId);
    expect(ns.forge).toBe("/agents/agent-123/forge/bricks");
    expect(ns.events).toBe("/agents/agent-123/events");
    expect(ns.session).toBe("/agents/agent-123/sessions");
    expect(ns.memory).toBe("/agents/agent-123/memory");
    expect(ns.snapshots).toBe("/agents/agent-123/snapshots");
    expect(ns.filesystem).toBe("/agents/agent-123/workspace");
    expect(ns.mailbox).toBe("/agents/agent-123/mailbox");
  });

  test("handles special characters in agentId", () => {
    const ns = computeAgentNamespace("agent:with-chars.v2" as AgentId);
    expect(ns.forge).toBe("/agents/agent:with-chars.v2/forge/bricks");
  });
});

describe("computeGroupNamespace", () => {
  test("computes group-scoped paths from groupId", () => {
    const ns = computeGroupNamespace("group-abc");
    expect(ns.scratchpad).toBe("/groups/group-abc/scratch");
  });
});

describe("ensureNamespace", () => {
  test("calls rpc write for each path", async () => {
    const rpcMock = mock((_method: string, _params: Record<string, unknown>) =>
      Promise.resolve({ ok: true as const, value: null }),
    );
    const client: NexusClient = { rpc: rpcMock as NexusClient["rpc"] };

    await ensureNamespace(client, ["/agents/a/events", "/agents/a/memory"]);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls[0]).toEqual([
      "write",
      { path: "/agents/a/events/.koi", content: "", createDirectories: true },
    ]);
    expect(rpcMock.mock.calls[1]).toEqual([
      "write",
      { path: "/agents/a/memory/.koi", content: "", createDirectories: true },
    ]);
  });

  test("continues when individual writes fail", async () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const rpcMock = mock(() => Promise.resolve({ ok: true as const, value: null }))
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockImplementationOnce(() => Promise.resolve({ ok: true as const, value: null }));
    const client: NexusClient = { rpc: rpcMock as NexusClient["rpc"] };

    await ensureNamespace(client, ["/fail", "/succeed"]);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    console.warn = originalWarn;
  });

  test("handles empty paths array", async () => {
    const rpcMock = mock(() => Promise.resolve({ ok: true as const, value: null }));
    const client: NexusClient = { rpc: rpcMock as NexusClient["rpc"] };

    await ensureNamespace(client, []);

    expect(rpcMock).toHaveBeenCalledTimes(0);
  });
});
