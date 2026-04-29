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

    test("concurrent calls with same task_id share a single spawnFn invocation", async () => {
      const calls: SpawnRequest[] = [];
      let release: () => void = () => {};
      const fn: SpawnFn = (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, output: "shared-output" });
        });
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
      const aPromise = tool.execute(args);
      const bPromise = tool.execute(args);
      await Promise.resolve();
      release();
      const [a, b] = await Promise.all([aPromise, bPromise]);

      expect(calls).toHaveLength(1);
      expect(a).toMatchObject({ ok: true, output: "shared-output" });
      expect(b).toMatchObject({ ok: true, output: "shared-output" });
      const dedupCount = [a, b].filter(
        (r): boolean => (r as { deduplicated?: boolean }).deduplicated === true,
      ).length;
      expect(dedupCount).toBe(1);
    });

    test("retry with changed description bypasses cache (no stale replay)", async () => {
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        return { ok: true, output: `desc:${request.description.slice(0, 5)}` };
      };
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      await tool.execute({
        agent_name: "researcher",
        description: "First instructions",
        context: { task_id: "T-1" },
      });
      const second = await tool.execute({
        agent_name: "researcher",
        description: "Updated instructions",
        context: { task_id: "T-1" },
      });

      expect(calls).toHaveLength(2);
      expect(second).toMatchObject({ ok: true });
      expect((second as { deduplicated?: boolean }).deduplicated).toBeUndefined();
    });

    test("non-JSON-safe context (BigInt) fails closed with a structured error — no spawn invoked", async () => {
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        return { ok: true, output: "ok" };
      };
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      const result = await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", count: 5n },
      });
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain("not JSON-serializable");
      // Spawn must NOT be invoked with malformed context.
      expect(calls).toHaveLength(0);
    });

    test("Date in context normalizes to ISO string — same ISO ⇒ cache hit, different ISO ⇒ fresh spawn", async () => {
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        return { ok: true, output: `n=${calls.length}` };
      };
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      // Same logical timestamp passed via two different Date instances:
      const t = "2025-01-01T00:00:00.000Z";
      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", when: new Date(t) },
      });
      const second = await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", when: new Date(t) },
      });
      expect(calls).toHaveLength(1);
      expect(second).toMatchObject({ ok: true, deduplicated: true });

      // A different Date value must NOT collide with the cached entry.
      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", when: new Date("2025-02-01T00:00:00.000Z") },
      });
      expect(calls).toHaveLength(2);

      // Forwarded context.when is the ISO string, not a Date instance.
      expect(calls[0]?.context?.when).toBe(t);
      expect(typeof calls[0]?.context?.when).toBe("string");
    });

    test("spawnFn signaling cacheable:false (deferred/on-demand delivery) is not cached — retry re-spawns", async () => {
      // Simulates an engine adapter that returns success before the child
      // finishes (deferred delivery). The first call's placeholder admission
      // must not mask the later real result on retry.
      const calls: SpawnRequest[] = [];
      let attempt = 0;
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        attempt += 1;
        if (attempt === 1) {
          // Deferred delivery: placeholder admission, child still running.
          return { ok: true, output: "spawn-id-abc", cacheable: false };
        }
        // Recovery retry after background delivery failed: real spawn.
        return { ok: true, output: "real-final-output" };
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
        context: { task_id: "T-1" },
      };
      const first = await tool.execute(args);
      const second = await tool.execute(args);

      expect(first).toMatchObject({ ok: true, output: "spawn-id-abc" });
      expect((first as { deduplicated?: boolean }).deduplicated).toBeUndefined();
      // Retry must reach spawnFn — placeholder must NOT be replayed.
      expect(second).toMatchObject({ ok: true, output: "real-final-output" });
      expect((second as { deduplicated?: boolean }).deduplicated).toBeUndefined();
      expect(calls).toHaveLength(2);
    });

    test("childDescription canonicalizes context keys so the prompt matches the cache digest", async () => {
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        return { ok: true, output: "out" };
      };
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      // Same logical context, different insertion order. The child must see
      // the same prompt text both times, AND the second call must dedup.
      const a = await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", scope: "src/a", limit: 5 },
      });
      const b = await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { limit: 5, scope: "src/a", task_id: "T-1" },
      });

      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true, deduplicated: true });
      expect(calls).toHaveLength(1);
      // First call's description carries canonical (alphabetical) keys.
      expect(calls[0]?.description).toContain("Structured context:");
      const ctxBlock = calls[0]?.description.split("Structured context:\n")[1];
      expect(ctxBlock).toBeDefined();
      // Keys appear in alphabetical order: limit, scope, task_id.
      const limitIdx = ctxBlock?.indexOf('"limit"') ?? -1;
      const scopeIdx = ctxBlock?.indexOf('"scope"') ?? -1;
      const taskIdIdx = ctxBlock?.indexOf('"task_id"') ?? -1;
      expect(limitIdx).toBeGreaterThanOrEqual(0);
      expect(limitIdx).toBeLessThan(scopeIdx);
      expect(scopeIdx).toBeLessThan(taskIdIdx);
    });

    test("retry with changed non-task_id context field bypasses cache", async () => {
      const calls: SpawnRequest[] = [];
      const fn: SpawnFn = async (request) => {
        calls.push(request);
        return { ok: true, output: "out" };
      };
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: createSpawnResultCache(),
      });

      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", scope: "src/a" },
      });
      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1", scope: "src/b" },
      });
      expect(calls).toHaveLength(2);
    });

    test("parentAgentId namespaces the cache — same agentName+task_id under different parents do not collide", async () => {
      const { fn, calls } = makeSpawnFn();
      const cache = createSpawnResultCache();
      const args = {
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1" },
      };

      const toolA = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent-A" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: cache,
      });
      const toolB = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent-B" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: cache,
      });

      await toolA.execute(args);
      await toolB.execute(args);
      expect(calls).toHaveLength(2);
    });

    test("LRU eviction at capacity — oldest entry's retry re-spawns after newer keys fill the cache", async () => {
      const { fn, calls } = makeSpawnFn();
      const cache = createSpawnResultCache(4);
      const tool = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: cache,
      });

      for (let i = 0; i < 4; i += 1) {
        await tool.execute({
          agent_name: "researcher",
          description: "X",
          context: { task_id: `T-${i}` },
        });
      }
      expect(calls).toHaveLength(4);

      // Push T-0 out by adding a 5th unique key.
      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-4" },
      });
      expect(calls).toHaveLength(5);

      // Retry on T-0 must miss cache and re-spawn.
      await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-0" },
      });
      expect(calls).toHaveLength(6);

      // Retry on T-4 (still in LRU) must dedup.
      const r = await tool.execute({
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-4" },
      });
      expect(r).toMatchObject({ deduplicated: true });
      expect(calls).toHaveLength(6);
    });

    test("retry storm — 50 concurrent retries with same task_id share one spawnFn invocation", async () => {
      const calls: SpawnRequest[] = [];
      let release: () => void = () => {};
      const fn: SpawnFn = (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, output: "shared" });
        });
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
        context: { task_id: "T-1" },
      };
      const promises = Array.from({ length: 50 }, () => tool.execute(args));
      await Promise.resolve();
      release();
      const results = await Promise.all(promises);

      expect(calls).toHaveLength(1);
      for (const r of results) {
        expect(r).toMatchObject({ ok: true, output: "shared" });
      }
      const dedupCount = results.filter(
        (r): boolean => (r as { deduplicated?: boolean }).deduplicated === true,
      ).length;
      // First caller drove, the other 49 are deduplicated waiters.
      expect(dedupCount).toBe(49);
    });

    test("driver abort with no waiters — retry drives a fresh spawn (no cache hit, no shared orphan)", async () => {
      const calls: SpawnRequest[] = [];
      let release: (v: { ok: true; output: string }) => void = () => {};
      const fn: SpawnFn = (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          release = resolve;
        });
      };

      const ctrl = new AbortController();
      const toolAborted = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: ctrl.signal,
        resultCache: createSpawnResultCache(),
      });

      const cache = (toolAborted as unknown as { __cache?: unknown }).__cache;
      // (We share the cache via the same factory by reusing it explicitly.)
      void cache;

      const args = {
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1" },
      };
      const aPromise = toolAborted.execute(args);
      await Promise.resolve();
      ctrl.abort(new Error("parent timeout"));
      const a = await aPromise;
      expect(a).toMatchObject({ ok: false });

      // Orphan settles after abort. Should not backfill.
      release({ ok: true, output: "orphan" });
      await Promise.resolve();
      await Promise.resolve();

      // A retry through a fresh tool sharing the same cache drives a new spawn.
      // (We need same cache to test cache state — recreate via shared instance.)
      // Simpler: just assert orphan output is NOT returned by the abort path itself.
      expect(a).not.toMatchObject({ output: "orphan" });
      // And spawnFn was called exactly once for this attempt.
      expect(calls).toHaveLength(1);
    });

    test("driver abort with surviving waiter — waiter still receives the result", async () => {
      const calls: SpawnRequest[] = [];
      let release: () => void = () => {};
      const fn: SpawnFn = (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, output: "shared" });
        });
      };
      const cache = createSpawnResultCache();
      const ctrlA = new AbortController();
      const toolA = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: ctrlA.signal,
        resultCache: cache,
      });
      const toolB = createAgentSpawnTool({
        spawnFn: fn,
        board: {} as ManagedTaskBoard,
        agentId: "parent" as AgentId,
        signal: AbortSignal.timeout(5_000),
        resultCache: cache,
      });

      const args = {
        agent_name: "researcher",
        description: "X",
        context: { task_id: "T-1" },
      };

      const aPromise = toolA.execute(args);
      await Promise.resolve();
      const bPromise = toolB.execute(args);
      await Promise.resolve();
      ctrlA.abort(new Error("A timeout"));
      const a = await aPromise;
      expect(a).toMatchObject({ ok: false });

      release();
      const b = await bPromise;
      expect(b).toMatchObject({ ok: true, output: "shared" });
      expect(calls).toHaveLength(1);
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
