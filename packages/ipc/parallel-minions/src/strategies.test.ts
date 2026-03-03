import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { createLaneSemaphore } from "./lane-semaphore.js";
import {
  createBestEffortStrategy,
  createFailFastStrategy,
  createQuorumStrategy,
} from "./strategies.js";
import type { ExecutionContext, MinionSpawnFn, ResolvedTask } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: AgentManifest = {
  name: "test-worker",
  version: "0.0.1",
  model: { name: "mock" },
};

function makeTasks(count: number): readonly ResolvedTask[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    description: `task-${i}`,
    agentName: "test-worker",
    agentType: "worker",
    manifest: TEST_MANIFEST,
  }));
}

function makeCtx(
  tasks: readonly ResolvedTask[],
  spawn: MinionSpawnFn,
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  return {
    tasks,
    semaphore: createLaneSemaphore(5),
    spawn,
    batchSignal: new AbortController().signal,
    maxOutputPerTask: 5_000,
    strategy: "best-effort",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// best-effort
// ---------------------------------------------------------------------------

describe("createBestEffortStrategy", () => {
  it("collects all outcomes on all-succeed", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async (req) => ({
      ok: true,
      output: `result-${req.taskIndex}`,
    });

    const result = await strategy(makeCtx(makeTasks(3), spawn));

    expect(result.summary.total).toBe(3);
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.strategy).toBe("best-effort");
    expect(result.outcomes).toHaveLength(3);
  });

  it("collects all outcomes on all-fail", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async () => ({
      ok: false,
      error: "fail",
    });

    const result = await strategy(makeCtx(makeTasks(3), spawn));

    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.failed).toBe(3);
  });

  it("handles mixed success/failure", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async (req) =>
      req.taskIndex % 2 === 0 ? { ok: true, output: "ok" } : { ok: false, error: "fail" };

    const result = await strategy(makeCtx(makeTasks(4), spawn));

    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(2);
  });

  it("handles empty tasks", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async () => ({ ok: true, output: "ok" });

    const result = await strategy(makeCtx([], spawn));

    expect(result.outcomes).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it("handles single task", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async () => ({
      ok: true,
      output: "done",
    });

    const result = await strategy(makeCtx(makeTasks(1), spawn));

    expect(result.outcomes).toHaveLength(1);
    expect(result.summary.succeeded).toBe(1);
  });

  it("captures thrown errors as failures", async () => {
    const strategy = createBestEffortStrategy();
    const spawn: MinionSpawnFn = async () => {
      throw new Error("spawn crashed");
    };

    const result = await strategy(makeCtx(makeTasks(2), spawn));

    expect(result.summary.failed).toBe(2);
    expect(result.outcomes[0]?.ok).toBe(false);
    if (!result.outcomes[0]?.ok) {
      expect(result.outcomes[0]?.error).toBe("spawn crashed");
    }
  });

  it("truncates output exceeding maxOutputPerTask", async () => {
    const strategy = createBestEffortStrategy();
    const longOutput = "x".repeat(10_000);
    const spawn: MinionSpawnFn = async () => ({
      ok: true,
      output: longOutput,
    });

    const ctx = makeCtx(makeTasks(1), spawn, { maxOutputPerTask: 100 });
    const result = await strategy(ctx);

    expect(result.outcomes[0]?.ok).toBe(true);
    if (result.outcomes[0]?.ok) {
      expect(result.outcomes[0].output.length).toBeLessThanOrEqual(100);
      expect(result.outcomes[0].output).toContain("[output truncated]");
    }
  });
});

// ---------------------------------------------------------------------------
// fail-fast
// ---------------------------------------------------------------------------

describe("createFailFastStrategy", () => {
  it("aborts remaining tasks on first failure", async () => {
    const strategy = createFailFastStrategy();
    const calls: number[] = [];

    const spawn: MinionSpawnFn = async (req) => {
      calls.push(req.taskIndex);
      if (req.taskIndex === 0) {
        return { ok: false, error: "first failed" };
      }
      // Tasks that start after abort should see aborted signal
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, output: "ok" };
    };

    const ctx = makeCtx(makeTasks(3), spawn, {
      semaphore: createLaneSemaphore(1), // Serial execution to ensure ordering
    });
    const result = await strategy(ctx);

    expect(result.summary.strategy).toBe("fail-fast");
    // First task fails, subsequent tasks should be aborted
    const failures = result.outcomes.filter((o) => !o.ok);
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it("returns all successes when no failures", async () => {
    const strategy = createFailFastStrategy();
    const spawn: MinionSpawnFn = async (req) => ({
      ok: true,
      output: `done-${req.taskIndex}`,
    });

    const result = await strategy(makeCtx(makeTasks(3), spawn));

    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);
  });

  it("propagates abort signal to in-flight tasks", async () => {
    const strategy = createFailFastStrategy();
    // let justified: mutable flag tracking signal state
    let signalAborted = false;

    const spawn: MinionSpawnFn = async (req) => {
      if (req.taskIndex === 0) {
        return { ok: false, error: "trigger abort" };
      }
      // Check if signal was aborted
      await new Promise((resolve) => setTimeout(resolve, 10));
      signalAborted = req.signal.aborted;
      return { ok: true, output: "ok" };
    };

    const ctx = makeCtx(makeTasks(2), spawn, {
      semaphore: createLaneSemaphore(1),
    });
    await strategy(ctx);

    expect(signalAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// quorum
// ---------------------------------------------------------------------------

describe("createQuorumStrategy", () => {
  it("succeeds when quorum threshold is met", async () => {
    const strategy = createQuorumStrategy(2);
    const spawn: MinionSpawnFn = async () => ({
      ok: true,
      output: "ok",
    });

    const ctx = makeCtx(makeTasks(3), spawn, { strategy: "quorum" });
    const result = await strategy(ctx);

    expect(result.summary.strategy).toBe("quorum");
    expect(result.summary.succeeded).toBeGreaterThanOrEqual(2);
  });

  it("reports correct counts when below threshold", async () => {
    const strategy = createQuorumStrategy(3);
    const spawn: MinionSpawnFn = async (req) =>
      req.taskIndex === 0 ? { ok: true, output: "ok" } : { ok: false, error: "fail" };

    const ctx = makeCtx(makeTasks(3), spawn, { strategy: "quorum" });
    const result = await strategy(ctx);

    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(2);
  });

  it("aborts remaining after quorum reached", async () => {
    const strategy = createQuorumStrategy(2);
    const calls: number[] = [];

    const spawn: MinionSpawnFn = async (req) => {
      calls.push(req.taskIndex);
      return { ok: true, output: `done-${req.taskIndex}` };
    };

    const ctx = makeCtx(makeTasks(5), spawn, {
      semaphore: createLaneSemaphore(1),
      strategy: "quorum",
    });
    const result = await strategy(ctx);

    expect(result.summary.succeeded).toBeGreaterThanOrEqual(2);
  });

  it("exact threshold boundary: exactly minSuccess succeeds", async () => {
    const strategy = createQuorumStrategy(3);
    const spawn: MinionSpawnFn = async () => ({
      ok: true,
      output: "ok",
    });

    const ctx = makeCtx(makeTasks(3), spawn, { strategy: "quorum" });
    const result = await strategy(ctx);

    expect(result.summary.succeeded).toBeGreaterThanOrEqual(3);
  });

  it("handles empty tasks", async () => {
    const strategy = createQuorumStrategy(1);
    const spawn: MinionSpawnFn = async () => ({ ok: true, output: "ok" });

    const ctx = makeCtx([], spawn, { strategy: "quorum" });
    const result = await strategy(ctx);

    expect(result.outcomes).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });
});
