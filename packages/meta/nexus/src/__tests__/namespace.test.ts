/**
 * Tests for namespace path computation and provisioning.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentId } from "@koi/core";
import { agentId, brickId, nexusPath } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import {
  agentBrickPath,
  agentMemoryPath,
  agentSessionPath,
  agentSnapshotPath,
} from "@koi/nexus-client";
import { computeAgentNamespace, computeGroupNamespace, ensureNamespace } from "../namespace.js";

describe("computeAgentNamespace", () => {
  test("computes all agent-scoped paths from agentId", () => {
    const ns = computeAgentNamespace("agent-123" as AgentId);
    expect(ns.forge).toBe(nexusPath("agents/agent-123/bricks"));
    expect(ns.events).toBe(nexusPath("agents/agent-123/events"));
    expect(ns.session).toBe(nexusPath("agents/agent-123/session"));
    expect(ns.memory).toBe(nexusPath("agents/agent-123/memory/entities"));
    expect(ns.snapshots).toBe(nexusPath("agents/agent-123/snapshots"));
    expect(ns.filesystem).toBe(nexusPath("agents/agent-123/workspace"));
    expect(ns.mailbox).toBe(nexusPath("agents/agent-123/mailbox"));
  });

  test("handles special characters in agentId", () => {
    const ns = computeAgentNamespace("agent:with-chars.v2" as AgentId);
    expect(ns.forge).toBe(nexusPath("agents/agent:with-chars.v2/bricks"));
  });

  test("no leading slashes in any path", () => {
    const ns = computeAgentNamespace("agent-1" as AgentId);
    for (const path of Object.values(ns)) {
      expect((path as string).startsWith("/")).toBe(false);
    }
  });
});

describe("computeAgentNamespace — contract test (paths.ts compatibility)", () => {
  test("namespace basePaths are valid prefixes of paths.ts output", () => {
    const id = agentId("test-1");
    const ns = computeAgentNamespace(id);
    const bid = brickId("brick-1");

    // Forge: ns.forge + '/{brickId}.json' === agentBrickPath
    const bPath = agentBrickPath(id, bid) as string;
    expect(bPath.startsWith(ns.forge as string)).toBe(true);

    // Session: ns.session is prefix of agentSessionPath
    const sPath = agentSessionPath(id) as string;
    expect(sPath.startsWith(ns.session as string)).toBe(true);

    // Memory: ns.memory is prefix of agentMemoryPath
    const mPath = agentMemoryPath(id, "slug") as string;
    expect(mPath.startsWith(ns.memory as string)).toBe(true);

    // Snapshots: ns.snapshots is prefix of agentSnapshotPath
    const snPath = agentSnapshotPath(id, "chain-1", "node-1") as string;
    expect(snPath.startsWith(ns.snapshots as string)).toBe(true);
  });
});

describe("computeAgentNamespace — canonical tree snapshot", () => {
  test("canonical namespace tree", () => {
    const id = agentId("agent-1");
    const ns = computeAgentNamespace(id);

    const tree = [
      `${ns.forge as string}/`,
      `${ns.events as string}/`,
      `${ns.session as string}/`,
      `${ns.memory as string}/`,
      `${ns.snapshots as string}/`,
      `${ns.filesystem as string}/`,
      `${ns.mailbox as string}/`,
    ].join("\n");

    expect(tree).toBe(
      [
        "agents/agent-1/bricks/",
        "agents/agent-1/events/",
        "agents/agent-1/session/",
        "agents/agent-1/memory/entities/",
        "agents/agent-1/snapshots/",
        "agents/agent-1/workspace/",
        "agents/agent-1/mailbox/",
      ].join("\n"),
    );
  });
});

describe("computeGroupNamespace", () => {
  test("computes group-scoped paths from groupId", () => {
    const ns = computeGroupNamespace("group-abc");
    expect(ns.scratchpad).toBe(nexusPath("groups/group-abc/scratch"));
  });

  test("no leading slash", () => {
    const ns = computeGroupNamespace("group-1");
    expect((ns.scratchpad as string).startsWith("/")).toBe(false);
  });
});

describe("ensureNamespace", () => {
  test("calls rpc write for each path", async () => {
    const rpcMock = mock((_method: string, _params: Record<string, unknown>) =>
      Promise.resolve({ ok: true as const, value: null }),
    );
    const client: NexusClient = { rpc: rpcMock as NexusClient["rpc"] };

    await ensureNamespace(client, ["agents/a/events", "agents/a/memory/entities"]);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls[0]).toEqual([
      "write",
      { path: "agents/a/events/.koi", content: "", createDirectories: true },
    ]);
    expect(rpcMock.mock.calls[1]).toEqual([
      "write",
      { path: "agents/a/memory/entities/.koi", content: "", createDirectories: true },
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

    await ensureNamespace(client, ["fail", "succeed"]);

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
