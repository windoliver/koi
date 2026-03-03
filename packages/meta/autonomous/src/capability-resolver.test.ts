/**
 * Unit tests for createCapabilityResolver.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentRegistry, HarnessSnapshot, RegistryEntry } from "@koi/core";
import { agentId, harnessId, taskItemId } from "@koi/core";
import { createCapabilityResolver } from "./capability-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCompletedSnapshot(): HarnessSnapshot {
  return {
    harnessId: harnessId("test-harness"),
    phase: "completed",
    sessionSeq: 1,
    taskBoard: {
      items: [],
      results: [{ taskId: taskItemId("t-1"), output: "ok", durationMs: 100 }],
    },
    summaries: [],
    keyArtifacts: [],
    agentId: "agent-a",
    metrics: {
      totalSessions: 1,
      totalTurns: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      completedTaskCount: 1,
      pendingTaskCount: 0,
      elapsedMs: 10000,
    },
    startedAt: 1700000000000,
    checkpointedAt: 1700000010000,
  };
}

function createMockEntry(id: string, capabilities: readonly string[]): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: { capabilities },
    registeredAt: Date.now(),
    priority: 10,
  };
}

function createMockRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
  const placeholder = entries[0] as RegistryEntry | undefined;
  return {
    register: mock(() => placeholder as never),
    deregister: mock(() => true),
    lookup: mock(() => undefined),
    list: mock(async () => entries),
    transition: mock(async () => ({ ok: true, value: placeholder }) as never),
    patch: mock(async () => ({ ok: true, value: placeholder }) as never),
    watch: mock(() => () => {}),
    [Symbol.asyncDispose]: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCapabilityResolver", () => {
  test("returns agentId of first matching candidate", async () => {
    const entries = [
      createMockEntry("deployer-1", ["deployment"]),
      createMockEntry("deployer-2", ["deployment"]),
    ];
    const registry = createMockRegistry(entries);
    const resolver = createCapabilityResolver(registry, "deployment");

    const result = await resolver(createCompletedSnapshot());

    expect(result).toBe(agentId("deployer-1"));
    expect(registry.list).toHaveBeenCalledWith({
      phase: "running",
      capability: "deployment",
    });
  });

  test("throws when no running agent has the capability", async () => {
    const registry = createMockRegistry([]);
    const resolver = createCapabilityResolver(registry, "code-review");

    await expect(resolver(createCompletedSnapshot())).rejects.toThrow(
      'No running agent found with capability "code-review"',
    );
  });
});
