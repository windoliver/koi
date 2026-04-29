import { describe, expect, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, SpawnFn, SpawnRequest } from "@koi/core";
import { createSpawnTools } from "./create-spawn-tools.js";

describe("createSpawnTools", () => {
  test("provisions a default SpawnResultCache when none is supplied", async () => {
    const calls: SpawnRequest[] = [];
    const fn: SpawnFn = async (request) => {
      calls.push(request);
      return { ok: true, output: `n=${calls.length}` };
    };
    const [agentSpawn] = createSpawnTools({
      spawnFn: fn,
      board: {} as ManagedTaskBoard,
      agentId: "parent" as AgentId,
      signal: AbortSignal.timeout(5_000),
    });
    expect(agentSpawn).toBeDefined();

    const args = {
      agent_name: "researcher",
      description: "X",
      context: { task_id: "T-1" },
    };
    const first = await agentSpawn?.execute(args);
    const second = await agentSpawn?.execute(args);

    expect(first).toEqual({ ok: true, output: "n=1" });
    expect(second).toEqual({ ok: true, output: "n=1", deduplicated: true });
    expect(calls).toHaveLength(1);
  });

  test("respects an explicit resultCache from the caller (sharing across factories)", async () => {
    const fn: SpawnFn = async () => ({ ok: true, output: "shared" });
    const { createSpawnResultCache } = await import("./spawn-result-cache.js");
    const sharedCache = createSpawnResultCache();
    const [first] = createSpawnTools({
      spawnFn: fn,
      board: {} as ManagedTaskBoard,
      agentId: "parent" as AgentId,
      signal: AbortSignal.timeout(5_000),
      resultCache: sharedCache,
    });
    const [second] = createSpawnTools({
      spawnFn: fn,
      board: {} as ManagedTaskBoard,
      agentId: "parent" as AgentId,
      signal: AbortSignal.timeout(5_000),
      resultCache: sharedCache,
    });

    const args = {
      agent_name: "researcher",
      description: "X",
      context: { task_id: "T-1" },
    };
    const a = await first?.execute(args);
    const b = await second?.execute(args);
    expect(a).toEqual({ ok: true, output: "shared" });
    // Second factory shares the cache, so its call dedups.
    expect(b).toEqual({ ok: true, output: "shared", deduplicated: true });
  });
});
