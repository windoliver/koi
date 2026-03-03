import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { executeBatch } from "./executor.js";
import type { MinionSpawnFn, MinionTask, ParallelMinionsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: AgentManifest = {
  name: "test-worker",
  version: "0.0.1",
  model: { name: "mock" },
};

function makeConfig(overrides?: Partial<ParallelMinionsConfig>): ParallelMinionsConfig {
  const spawn: MinionSpawnFn = async (req) => ({
    ok: true,
    output: `result-${req.taskIndex}`,
  });

  return {
    agents: new Map([
      [
        "worker",
        {
          name: "test-worker",
          description: "A test worker",
          manifest: TEST_MANIFEST,
        },
      ],
    ]),
    spawn,
    defaultAgent: "worker",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeBatch", () => {
  it("executes tasks with correct strategy selection", async () => {
    const config = makeConfig();
    const tasks: readonly MinionTask[] = [{ description: "task-0" }, { description: "task-1" }];

    const result = await executeBatch(config, tasks);

    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.strategy).toBe("best-effort");
  });

  it("uses fail-fast strategy when configured", async () => {
    const spawn: MinionSpawnFn = async (req) =>
      req.taskIndex === 0 ? { ok: false, error: "fail" } : { ok: true, output: "ok" };

    const config = makeConfig({ spawn, strategy: "fail-fast" });
    const tasks: readonly MinionTask[] = [{ description: "task-0" }, { description: "task-1" }];

    const result = await executeBatch(config, tasks);
    expect(result.summary.strategy).toBe("fail-fast");
  });

  it("uses quorum strategy when configured", async () => {
    const config = makeConfig({
      strategy: "quorum",
      quorumThreshold: 1,
    });
    const tasks: readonly MinionTask[] = [{ description: "task-0" }, { description: "task-1" }];

    const result = await executeBatch(config, tasks);
    expect(result.summary.strategy).toBe("quorum");
    expect(result.summary.succeeded).toBeGreaterThanOrEqual(1);
  });

  it("resolves default agent when agent_type omitted", async () => {
    const calls: string[] = [];
    const spawn: MinionSpawnFn = async (req) => {
      calls.push(req.agentName);
      return { ok: true, output: "ok" };
    };

    const config = makeConfig({ spawn });
    const tasks: readonly MinionTask[] = [{ description: "use default" }];

    await executeBatch(config, tasks);
    expect(calls).toEqual(["test-worker"]);
  });

  it("resolves explicit agent_type", async () => {
    const secondManifest: AgentManifest = {
      name: "coder",
      version: "0.0.1",
      model: { name: "code-model" },
    };

    const calls: string[] = [];
    const spawn: MinionSpawnFn = async (req) => {
      calls.push(req.agentName);
      return { ok: true, output: "ok" };
    };

    const config = makeConfig({
      spawn,
      agents: new Map([
        ["worker", { name: "test-worker", description: "Worker", manifest: TEST_MANIFEST }],
        ["coder", { name: "coder", description: "Coder", manifest: secondManifest }],
      ]),
    });

    const tasks: readonly MinionTask[] = [{ description: "code something", agent_type: "coder" }];

    await executeBatch(config, tasks);
    expect(calls).toEqual(["coder"]);
  });

  it("returns error for unknown agent_type", async () => {
    const config = makeConfig();
    const tasks: readonly MinionTask[] = [
      { description: "use unknown", agent_type: "nonexistent" },
    ];

    const result = await executeBatch(config, tasks);
    expect(result.summary.failed).toBe(1);
    expect(result.outcomes[0]?.ok).toBe(false);
  });

  it("returns error when no default and agent_type omitted", async () => {
    const config = makeConfig({ defaultAgent: undefined });
    const tasks: readonly MinionTask[] = [{ description: "no agent" }];

    const result = await executeBatch(config, tasks);
    expect(result.summary.failed).toBe(1);
  });

  it("returns immediately for empty task list", async () => {
    const config = makeConfig();
    const result = await executeBatch(config, []);

    expect(result.outcomes).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.failed).toBe(0);
  });

  it("preserves taskIndex correlation under partial failure", async () => {
    const spawn: MinionSpawnFn = async (req) =>
      req.taskIndex === 1 || req.taskIndex === 3
        ? { ok: false, error: `fail-${req.taskIndex}` }
        : { ok: true, output: `ok-${req.taskIndex}` };

    const config = makeConfig({ spawn });
    const tasks: readonly MinionTask[] = Array.from({ length: 5 }, (_, i) => ({
      description: `task-${i}`,
    }));

    const result = await executeBatch(config, tasks);

    // Verify each outcome has the correct taskIndex
    for (const outcome of result.outcomes) {
      if (outcome.taskIndex === 1 || outcome.taskIndex === 3) {
        expect(outcome.ok).toBe(false);
      } else {
        expect(outcome.ok).toBe(true);
      }
    }
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(2);
  });

  it("respects maxConcurrency", async () => {
    // let justified: mutable counter tracking peak concurrency
    let concurrent = 0;
    let peak = 0;

    const spawn: MinionSpawnFn = async () => {
      concurrent += 1;
      if (concurrent > peak) peak = concurrent;
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { ok: true, output: "ok" };
    };

    const config = makeConfig({ spawn, maxConcurrency: 2 });
    const tasks: readonly MinionTask[] = Array.from({ length: 5 }, (_, i) => ({
      description: `task-${i}`,
    }));

    await executeBatch(config, tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("handles spawn throwing (not returning error)", async () => {
    const spawn: MinionSpawnFn = async () => {
      throw new Error("unexpected crash");
    };

    const config = makeConfig({ spawn });
    const tasks: readonly MinionTask[] = [{ description: "will crash" }];

    const result = await executeBatch(config, tasks);
    expect(result.summary.failed).toBe(1);
    const outcome = result.outcomes[0];
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.error).toBe("unexpected crash");
    }
  });

  it("respects per-lane concurrency limits", async () => {
    // let justified: mutable counters tracking per-lane peak concurrency
    let researcherConcurrent = 0;
    let researcherPeak = 0;

    const spawn: MinionSpawnFn = async (req) => {
      if (req.agentName === "researcher") {
        researcherConcurrent += 1;
        if (researcherConcurrent > researcherPeak) researcherPeak = researcherConcurrent;
        await new Promise((resolve) => setTimeout(resolve, 15));
        researcherConcurrent -= 1;
      }
      return { ok: true, output: `done-${req.taskIndex}` };
    };

    const config = makeConfig({
      spawn,
      maxConcurrency: 10,
      agents: new Map([
        ["researcher", { name: "researcher", description: "Researches", manifest: TEST_MANIFEST }],
        ["coder", { name: "coder", description: "Codes", manifest: TEST_MANIFEST }],
      ]),
      defaultAgent: "researcher",
      laneConcurrency: new Map([["researcher", 2]]),
    });

    const tasks: readonly MinionTask[] = [
      { description: "r1", agent_type: "researcher" },
      { description: "r2", agent_type: "researcher" },
      { description: "r3", agent_type: "researcher" },
      { description: "r4", agent_type: "researcher" },
      { description: "c1", agent_type: "coder" },
    ];

    const result = await executeBatch(config, tasks);
    expect(result.summary.succeeded).toBe(5);
    expect(researcherPeak).toBeLessThanOrEqual(2);
  });

  it("handles duplicate agent_type without shared state bleed", async () => {
    const results: string[] = [];
    const spawn: MinionSpawnFn = async (req) => {
      const output = `result-${req.taskIndex}-${req.agentName}`;
      results.push(output);
      return { ok: true, output };
    };

    const config = makeConfig({ spawn });
    const tasks: readonly MinionTask[] = Array.from({ length: 3 }, (_, i) => ({
      description: `research-${i}`,
      agent_type: "worker",
    }));

    const result = await executeBatch(config, tasks);
    expect(result.summary.succeeded).toBe(3);
    // Each task got a distinct result
    expect(new Set(results).size).toBe(3);
  });
});
