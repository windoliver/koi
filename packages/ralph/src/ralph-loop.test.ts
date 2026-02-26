import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearnings } from "./learnings.js";
import { createRalphLoop } from "./ralph-loop.js";
import type {
  EngineEvent,
  EngineInput,
  GateContext,
  IterationRecord,
  PRDFile,
  RalphConfig,
  RunIterationFn,
  VerificationFn,
  VerificationResult,
} from "./types.js";

let tmpDir: string;
let prdPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-loop-"));
  prdPath = join(tmpDir, "prd.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const EMPTY_ASYNC_ITERABLE: AsyncIterable<EngineEvent> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};

/** Mock iteration runner that yields no events. */
function mockRunner(): RunIterationFn {
  return (_input: EngineInput): AsyncIterable<EngineEvent> => EMPTY_ASYNC_ITERABLE;
}

/** Mock iteration runner that throws on specified iterations. */
function throwingRunner(failOnIteration: number): RunIterationFn {
  // Use let — justified: mutable call counter
  let callCount = 0;
  return (_input: EngineInput): AsyncIterable<EngineEvent> => {
    callCount++;
    if (callCount === failOnIteration) {
      throw new Error("Iteration failed");
    }
    return EMPTY_ASYNC_ITERABLE;
  };
}

/** Always-pass gate. */
function passGate(): VerificationFn {
  return async (_ctx: GateContext): Promise<VerificationResult> => ({
    passed: true,
  });
}

/** Always-fail gate. */
function failGate(): VerificationFn {
  return async (_ctx: GateContext): Promise<VerificationResult> => ({
    passed: false,
    details: "Gate check failed",
  });
}

function writePrd(items: PRDFile): Promise<number> {
  return Bun.write(prdPath, JSON.stringify(items, null, 2));
}

function makeConfig(overrides?: Partial<RalphConfig>): RalphConfig {
  return {
    runIteration: mockRunner(),
    prdPath,
    verify: passGate(),
    iterationPrompt: (ctx) => `Iteration ${ctx.iteration}: work on ${ctx.currentItem?.id}`,
    workingDir: tmpDir,
    ...overrides,
  };
}

describe("createRalphLoop", () => {
  test("throws on missing prdPath", () => {
    expect(() =>
      createRalphLoop({
        ...makeConfig(),
        prdPath: "",
      }),
    ).toThrow("prdPath");
  });

  test("throws on missing runIteration", () => {
    expect(() =>
      createRalphLoop({
        ...makeConfig(),
        runIteration: undefined as unknown as RunIterationFn,
      }),
    ).toThrow("runIteration");
  });

  test("throws on missing verify", () => {
    expect(() =>
      createRalphLoop({
        ...makeConfig(),
        verify: undefined as unknown as VerificationFn,
      }),
    ).toThrow("verify");
  });

  test("throws on missing iterationPrompt", () => {
    expect(() =>
      createRalphLoop({
        ...makeConfig(),
        iterationPrompt: undefined as unknown as RalphConfig["iterationPrompt"],
      }),
    ).toThrow("iterationPrompt");
  });
});

describe("RalphLoop.run", () => {
  test("completes all PRD items", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
        { id: "c", description: "Task C", done: false },
      ],
    });

    const loop = createRalphLoop(makeConfig());
    const result = await loop.run();

    expect(result.iterations).toBe(3);
    expect(result.completed).toEqual(["a", "b", "c"]);
    expect(result.remaining).toEqual([]);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.iterationRecords).toHaveLength(3);
  });

  test("stops at maxIterations", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createRalphLoop(
      makeConfig({
        maxIterations: 1,
        verify: failGate(),
      }),
    );
    const result = await loop.run();

    expect(result.iterations).toBe(1);
    expect(result.remaining).toContain("a");
    expect(result.remaining).toContain("b");
  });

  test("stop() exits after current iteration", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createRalphLoop(
      makeConfig({
        verify: async (_ctx) => {
          // Stop after first iteration passes
          loop.stop();
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
    // Should have run 1 iteration (a completed), then stopped before b
    expect(result.iterations).toBe(1);
    expect(result.completed).toContain("a");
  });

  test("handles iteration error and continues", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createRalphLoop(
      makeConfig({
        runIteration: throwingRunner(1), // fails on first call
      }),
    );
    const result = await loop.run();

    // First iteration errored but gate still passed → item marked done
    expect(result.iterationRecords[0]?.error).toBe("Iteration failed");
    expect(result.iterations).toBe(2);
  });

  test("handles gate error and continues", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    // Use let — justified: mutable call counter for gate behavior change
    let gateCalls = 0;
    const loop = createRalphLoop(
      makeConfig({
        maxIterations: 2,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            throw new Error("Gate crashed");
          }
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    // First iteration: gate error → item not marked done
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    // Second iteration: gate passes → item marked done
    expect(result.iterations).toBe(2);
    expect(result.completed).toContain("a");
  });

  test("returns immediately if all items already done", async () => {
    await writePrd({
      items: [{ id: "a", description: "Done", done: true, verifiedAt: "2024-01-01T00:00:00.000Z" }],
    });

    const loop = createRalphLoop(makeConfig());
    const result = await loop.run();

    expect(result.iterations).toBe(0);
    expect(result.completed).toEqual(["a"]);
    expect(result.remaining).toEqual([]);
  });

  test("returns 0 iterations if PRD file missing", async () => {
    const loop = createRalphLoop(makeConfig({ prdPath: join(tmpDir, "missing.json") }));
    const result = await loop.run();

    expect(result.iterations).toBe(0);
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  test("per-iteration records have timing data", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    const loop = createRalphLoop(makeConfig());
    const result = await loop.run();

    expect(result.iterationRecords).toHaveLength(1);
    const record = result.iterationRecords[0];
    expect(record?.iteration).toBe(1);
    expect(record?.itemId).toBe("a");
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.gateResult.passed).toBe(true);
    expect(record?.error).toBeUndefined();
  });

  test("records learnings to file", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    const loop = createRalphLoop(makeConfig());
    await loop.run();

    const learnings = await readLearnings(join(tmpDir, "learnings.json"));
    expect(learnings).toHaveLength(1);
    expect(learnings[0]?.itemId).toBe("a");
    expect(learnings[0]?.iteration).toBe(1);
  });

  test("gate with itemsCompleted marks specific items", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
        { id: "c", description: "Task C", done: false },
      ],
    });

    // Use let — justified: mutable call counter for gate behavior change
    let gateCalls = 0;
    const loop = createRalphLoop(
      makeConfig({
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            // First iteration marks a+b via itemsCompleted
            return { passed: true, itemsCompleted: ["a", "b"] };
          }
          // Second iteration: no itemsCompleted → marks current item (c)
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    // First iteration: gate marks a+b as done
    // Second iteration: only c remains, gate passes → marks current (c)
    expect([...result.completed].sort()).toEqual(["a", "b", "c"]);
  });

  test("external AbortSignal stops the loop", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const controller = new AbortController();
    const loop = createRalphLoop(
      makeConfig({
        signal: controller.signal,
        verify: async (_ctx) => {
          // Abort after first iteration
          controller.abort("test abort");
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
    expect(result.iterations).toBe(1);
    expect(result.completed).toContain("a");
  });

  test("already-aborted signal runs 0 iterations", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    const controller = new AbortController();
    controller.abort("pre-aborted");

    const loop = createRalphLoop(makeConfig({ signal: controller.signal }));
    const result = await loop.run();
    expect(result.iterations).toBe(0);
  });

  test("iteration timeout records error and continues", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    // Use let — justified: mutable call counter
    let calls = 0;
    const loop = createRalphLoop(
      makeConfig({
        iterationTimeoutMs: 50,
        maxIterations: 2,
        runIteration: (_input: EngineInput): AsyncIterable<EngineEvent> => {
          calls++;
          if (calls === 1) {
            // First call: hang until aborted
            return {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise((resolve) => {
                    setTimeout(() => resolve({ done: true, value: undefined }), 5_000);
                  }),
              }),
            };
          }
          return EMPTY_ASYNC_ITERABLE;
        },
      }),
    );

    const result = await loop.run();
    // First iteration should have timed out (recorded as error)
    expect(result.iterationRecords[0]?.error).toBeDefined();
    expect(result.iterations).toBe(2);
  }, 10_000);

  test("onIteration callback fires after each iteration", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const observed: IterationRecord[] = [];
    const loop = createRalphLoop(
      makeConfig({
        onIteration: (record) => {
          observed.push(record);
        },
      }),
    );

    await loop.run();

    expect(observed).toHaveLength(2);
    expect(observed[0]?.iteration).toBe(1);
    expect(observed[0]?.itemId).toBe("a");
    expect(observed[1]?.iteration).toBe(2);
    expect(observed[1]?.itemId).toBe("b");
  });

  test("skips item after maxConsecutiveFailures", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    // Use let — justified: mutable counter to pass gate after item "a" is skipped
    let gateCalls = 0;
    const loop = createRalphLoop(
      makeConfig({
        maxConsecutiveFailures: 2,
        maxIterations: 10,
        verify: async (_ctx) => {
          gateCalls++;
          // Fail first 2 calls (item "a" fails twice → skipped)
          // Then pass (item "b")
          if (gateCalls <= 2) {
            return { passed: false, details: "Still failing" };
          }
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    expect(result.skipped).toContain("a");
    expect(result.completed).toContain("b");
    expect(result.remaining).toEqual([]);
  });

  test("resets consecutive failure count on success", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    // Use let — justified: mutable counter for alternating gate behavior
    let gateCalls = 0;
    const loop = createRalphLoop(
      makeConfig({
        maxConsecutiveFailures: 3,
        maxIterations: 5,
        verify: async (_ctx) => {
          gateCalls++;
          // Fail, fail, pass → count resets, item completes
          if (gateCalls <= 2) {
            return { passed: false, details: "Not yet" };
          }
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    // Item should be completed (not skipped) — only 2 consecutive failures before success
    expect(result.completed).toContain("a");
    expect(result.skipped).toEqual([]);
  });

  test("returns immediately if all items already skipped", async () => {
    await writePrd({
      items: [{ id: "a", description: "Skipped", done: false, skipped: true }],
    });

    const loop = createRalphLoop(makeConfig());
    const result = await loop.run();

    expect(result.iterations).toBe(0);
    expect(result.skipped).toEqual(["a"]);
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  test("gate receives full iteration history and learnings", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const capturedContexts: Array<{
      readonly iterationRecords: number;
      readonly learnings: number;
      readonly remainingCount: number;
      readonly completedCount: number;
    }> = [];

    const loop = createRalphLoop(
      makeConfig({
        verify: async (ctx) => {
          capturedContexts.push({
            iterationRecords: ctx.iterationRecords.length,
            learnings: ctx.learnings.length,
            remainingCount: ctx.remainingItems.length,
            completedCount: ctx.completedItems.length,
          });
          return { passed: true };
        },
      }),
    );
    await loop.run();

    // First iteration: no history yet, no learnings, 2 remaining, 0 completed
    expect(capturedContexts[0]?.iterationRecords).toBe(0);
    expect(capturedContexts[0]?.learnings).toBe(0);
    expect(capturedContexts[0]?.remainingCount).toBe(2);
    expect(capturedContexts[0]?.completedCount).toBe(0);

    // Second iteration: 1 record, 1 learning, 1 remaining, 1 completed
    expect(capturedContexts[1]?.iterationRecords).toBe(1);
    expect(capturedContexts[1]?.learnings).toBe(1);
    expect(capturedContexts[1]?.remainingCount).toBe(1);
    expect(capturedContexts[1]?.completedCount).toBe(1);
  });

  test("priority ordering: higher priority item processed first", async () => {
    await writePrd({
      items: [
        { id: "low", description: "Low priority", done: false, priority: 10 },
        { id: "high", description: "High priority", done: false, priority: 1 },
      ],
    });

    const loop = createRalphLoop(makeConfig());
    const result = await loop.run();

    // High priority item should be completed first (iteration 1)
    expect(result.iterationRecords[0]?.itemId).toBe("high");
    expect(result.iterationRecords[1]?.itemId).toBe("low");
    expect(result.completed).toContain("high");
    expect(result.completed).toContain("low");
  });

  test("gate timeout records error and continues", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    // Use let — justified: mutable counter for hanging gate
    let gateCalls = 0;
    const loop = createRalphLoop(
      makeConfig({
        gateTimeoutMs: 50,
        maxIterations: 3,
        maxConsecutiveFailures: 2,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            // First call: hang until timeout fires
            return new Promise(() => {}); // never resolves
          }
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
    // First iteration: gate timed out → recorded as failure
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterationRecords[0]?.gateResult.details).toContain("Gate");
    // Subsequent iterations should succeed
    expect(result.completed.length).toBeGreaterThan(0);
  }, 10_000);

  test("stop() aborts a running iteration", async () => {
    await writePrd({
      items: [{ id: "a", description: "Task A", done: false }],
    });

    const loop = createRalphLoop(
      makeConfig({
        maxIterations: 2,
        runIteration: (_input: EngineInput): AsyncIterable<EngineEvent> => {
          // Hang until aborted — stop() should break us out
          return {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                new Promise((resolve) => {
                  setTimeout(() => resolve({ done: true, value: undefined }), 5_000);
                }),
            }),
          };
        },
        verify: passGate(),
      }),
    );

    // Stop after a short delay
    setTimeout(() => loop.stop(), 50);

    const result = await loop.run();
    // Should have been interrupted, not hung for 5 seconds
    expect(result.durationMs).toBeLessThan(3_000);
  }, 10_000);
});
