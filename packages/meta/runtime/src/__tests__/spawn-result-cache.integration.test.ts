/**
 * Integration: RuntimeHandle.spawnResultCache wired through createSpawnTools
 * (#1709). Proves the runtime's wired cache reaches the L2 agent_spawn tool
 * and dedupes retries end-to-end. Also covers cross-runtime cache sharing
 * and survival across runtime.dispose() — the two corner cases not exercised
 * by the unit tests in @koi/spawn-tools.
 */
import { describe, expect, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, SpawnFn, SpawnRequest, Tool } from "@koi/core";
import { createSpawnTools } from "@koi/spawn-tools";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createRuntime } from "../create-runtime.js";

interface ToolWithExecute {
  readonly execute: (
    args: Record<string, unknown>,
  ) => Promise<{ ok: true; output: string; deduplicated?: boolean } | { ok: false; error: string }>;
}

async function makeTool(
  resultCache: ReturnType<typeof createRuntime>["spawnResultCache"],
  spawnFn: SpawnFn,
): Promise<ToolWithExecute> {
  const board = (await createManagedTaskBoard({
    store: createMemoryTaskBoardStore(),
  })) as ManagedTaskBoard;
  const tools = createSpawnTools({
    spawnFn,
    board,
    agentId: "parent-agent" as AgentId,
    signal: new AbortController().signal,
    resultCache,
  });
  const tool = (tools as Tool[])[0];
  if (tool === undefined) throw new Error("expected agent_spawn tool");
  return tool as unknown as ToolWithExecute;
}

describe("RuntimeHandle.spawnResultCache integration (#1709)", () => {
  test("default cache from runtime dedupes repeat calls through agent_spawn", async () => {
    const runtime = createRuntime();
    const calls: SpawnRequest[] = [];
    let n = 0;
    const spawnFn: SpawnFn = async (req) => {
      calls.push(req);
      n += 1;
      return { ok: true, output: `spawn-${n}` };
    };
    const tool = await makeTool(runtime.spawnResultCache, spawnFn);

    const args = {
      agent_name: "researcher",
      description: "Investigate",
      context: { task_id: "T-1" },
    };
    const first = await tool.execute(args);
    const second = await tool.execute(args);

    expect(first).toEqual({ ok: true, output: "spawn-1" });
    expect(second).toEqual({ ok: true, output: "spawn-1", deduplicated: true });
    expect(calls).toHaveLength(1);

    await runtime.dispose();
  });

  test("explicit cache shared across two runtimes — second runtime hits first runtime's cached output", async () => {
    // Pass a single cache instance to two runtimes; cross-process retry-dedup
    // works through the shared cache.
    const runtimeA = createRuntime();
    const sharedCache = runtimeA.spawnResultCache;
    const runtimeB = createRuntime({ spawnResultCache: sharedCache });

    const calls: SpawnRequest[] = [];
    let n = 0;
    const spawnFn: SpawnFn = async (req) => {
      calls.push(req);
      n += 1;
      return { ok: true, output: `spawn-${n}` };
    };
    const toolA = await makeTool(runtimeA.spawnResultCache, spawnFn);
    const toolB = await makeTool(runtimeB.spawnResultCache, spawnFn);

    const args = {
      agent_name: "researcher",
      description: "X",
      context: { task_id: "shared-1" },
    };
    const a = await toolA.execute(args);
    const b = await toolB.execute(args);

    expect(a).toMatchObject({ ok: true, output: "spawn-1" });
    expect(b).toMatchObject({ ok: true, output: "spawn-1", deduplicated: true });
    expect(calls).toHaveLength(1);

    await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
  });

  test("cache survives runtime.dispose() — entries persist if the cache instance is held externally", async () => {
    // The cache is a plain in-memory LRU; dispose() teardown is unrelated to
    // its lifetime. Callers holding the reference can keep using cached
    // entries after the producing runtime is gone.
    const cache = createRuntime().spawnResultCache;
    const runtime1 = createRuntime({ spawnResultCache: cache });

    const calls: SpawnRequest[] = [];
    const spawnFn: SpawnFn = async (req) => {
      calls.push(req);
      return { ok: true, output: "first-output" };
    };
    const tool1 = await makeTool(runtime1.spawnResultCache, spawnFn);

    const args = {
      agent_name: "researcher",
      description: "X",
      context: { task_id: "survives-dispose" },
    };
    await tool1.execute(args);
    expect(cache.size()).toBe(1);
    await runtime1.dispose();

    // Cache still holds the entry after dispose.
    expect(cache.size()).toBe(1);

    // Reuse the cache in a fresh runtime — no second spawnFn call.
    const runtime2 = createRuntime({ spawnResultCache: cache });
    const tool2 = await makeTool(runtime2.spawnResultCache, spawnFn);
    const second = await tool2.execute(args);
    expect(second).toMatchObject({
      ok: true,
      output: "first-output",
      deduplicated: true,
    });
    expect(calls).toHaveLength(1);

    await runtime2.dispose();
  });

  test("each runtime gets its own default cache — no accidental cross-runtime dedup", async () => {
    const runtimeA = createRuntime();
    const runtimeB = createRuntime();
    expect(runtimeA.spawnResultCache).not.toBe(runtimeB.spawnResultCache);

    const calls: SpawnRequest[] = [];
    let n = 0;
    const spawnFn: SpawnFn = async (req) => {
      calls.push(req);
      n += 1;
      return { ok: true, output: `spawn-${n}` };
    };
    const toolA = await makeTool(runtimeA.spawnResultCache, spawnFn);
    const toolB = await makeTool(runtimeB.spawnResultCache, spawnFn);

    const args = {
      agent_name: "researcher",
      description: "X",
      context: { task_id: "iso-1" },
    };
    await toolA.execute(args);
    await toolB.execute(args);
    // Two separate caches — both runtimes invoke spawnFn fresh.
    expect(calls).toHaveLength(2);

    await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
  });
});
