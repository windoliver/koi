import { describe, expect, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, SpawnFn, SpawnRequest } from "@koi/core";
import { createSpawnResultCache } from "./spawn-result-cache.js";
import { createAgentSpawnTool } from "./tools/agent-spawn.js";

describe("agent_spawn", () => {
  test("forwards structured context to spawnFn", async () => {
    const requests: SpawnRequest[] = [];
    const spawnFn: SpawnFn = async (request) => {
      requests.push(request);
      return { ok: true, output: "child output" };
    };

    const tool = createAgentSpawnTool({
      spawnFn,
      board: {} as ManagedTaskBoard,
      agentId: "parent-agent" as AgentId,
      signal: AbortSignal.timeout(5_000),
    });

    const result = await tool.execute({
      agent_name: "researcher",
      description: "Investigate the failure",
      context: {
        taskId: "TASK-123",
        files: ["src/index.ts"],
      },
    });

    expect(result).toEqual({ ok: true, output: "child output" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.description).toContain("Investigate the failure");
    expect(requests[0]?.description).toContain("Structured context:");
    expect(requests[0]?.description).toContain('"taskId": "TASK-123"');
    expect(requests[0]?.context).toEqual({
      taskId: "TASK-123",
      files: ["src/index.ts"],
    });
  });

  describe("idempotent delivery (#1709)", () => {
    function makeSpawnFn(): { fn: SpawnFn; calls: SpawnRequest[] } {
      const calls: SpawnRequest[] = [];
      let n = 0;
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        n += 1;
        return { ok: true, output: `output-${n}` };
      };
      return { fn, calls };
    }

    test("repeated call with same task_id returns cached output without re-invoking spawnFn", async () => {
      const { fn, calls } = makeSpawnFn();
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      const args = {
        agent_name: "researcher",
        description: "Investigate",
        context: { task_id: "T-1" },
      };

      const first = await tool.execute(args);
      const second = await tool.execute(args);

      expect(first).toEqual({ ok: true, output: "output-1" });
      expect(second).toEqual({ ok: true, output: "output-1", deduplicated: true });
      expect(calls).toHaveLength(1);
    });

    test("different task_ids do not collide", async () => {
      const { fn, calls } = makeSpawnFn();
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      await tool.execute({
        agent_name: "researcher",
        description: "A",
        context: { task_id: "T-1" },
      });
      await tool.execute({
        agent_name: "researcher",
        description: "B",
        context: { task_id: "T-2" },
      });

      expect(calls).toHaveLength(2);
    });

    test("missing task_id disables dedup — every call spawns fresh", async () => {
      const { fn, calls } = makeSpawnFn();
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      await tool.execute({ agent_name: "researcher", description: "A" });
      await tool.execute({ agent_name: "researcher", description: "A" });

      expect(calls).toHaveLength(2);
    });

    test("failed spawn is not cached — next call retries", async () => {
      const calls: SpawnRequest[] = [];
      let attempt = 0;
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, error: { code: "EXTERNAL", message: "boom", retryable: true } };
        }
        return { ok: true, output: "second-time-charm" };
      };

      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      const args = {
        agent_name: "researcher",
        description: "Investigate",
        context: { task_id: "T-9" },
      };
      const first = await tool.execute(args);
      const second = await tool.execute(args);

      expect(first).toEqual({ ok: false, error: "boom" });
      expect(second).toEqual({ ok: true, output: "second-time-charm" });
      expect(calls).toHaveLength(2);
    });

    test("concurrent calls with same task_id both spawn (cache only seals after settle)", async () => {
      // Documents current behavior: cache is populated on settle, so two
      // simultaneous in-flight calls both invoke spawnFn. Dedup catches
      // *retries* (sequential), not concurrent races. A future enhancement
      // could add an in-flight Promise map if concurrent dedup is needed.
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        await Promise.resolve();
        return { ok: true, output: `n-${calls.length}` };
      };

      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      const args = {
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-7" },
      };
      const [a, b] = await Promise.all([tool.execute(args), tool.execute(args)]);

      expect(calls).toHaveLength(2);
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      // After both settle, a third sequential retry returns the cached value.
      const c = await tool.execute(args);
      expect(c).toMatchObject({ ok: true, deduplicated: true });
      expect(calls).toHaveLength(2);
    });

    test("without resultCache, every call spawns (legacy behavior)", async () => {
      const { fn, calls } = makeSpawnFn();
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
      });

      const args = {
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1" },
      };
      await tool.execute(args);
      await tool.execute(args);
      expect(calls).toHaveLength(2);
    });
  });
});
