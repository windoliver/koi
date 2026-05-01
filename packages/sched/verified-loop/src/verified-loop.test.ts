import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearnings } from "./learnings.js";
import type {
  EngineEvent,
  EngineInput,
  GateContext,
  IterationRecord,
  PRDFile,
  RunIterationFn,
  VerificationFn,
  VerificationResult,
  VerifiedLoopConfig,
} from "./types.js";
import { createVerifiedLoop } from "./verified-loop.js";

// Use let — justified: per-test tmpdir reassigned in beforeEach
let tmpDir: string;
let prdPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "verified-loop-orch-"));
  prdPath = join(tmpDir, "prd.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const EMPTY_ASYNC_ITERABLE: AsyncIterable<EngineEvent> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};

function mockRunner(): RunIterationFn {
  return (_input: EngineInput): AsyncIterable<EngineEvent> => EMPTY_ASYNC_ITERABLE;
}

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

function passGate(): VerificationFn {
  return async (_ctx: GateContext): Promise<VerificationResult> => ({ passed: true });
}

function failGate(): VerificationFn {
  return async (_ctx: GateContext): Promise<VerificationResult> => ({
    passed: false,
    details: "Gate check failed",
  });
}

function writePrd(items: PRDFile): Promise<number> {
  return Bun.write(prdPath, JSON.stringify(items, null, 2));
}

function makeConfig(overrides?: Partial<VerifiedLoopConfig>): VerifiedLoopConfig {
  return {
    runIteration: mockRunner(),
    prdPath,
    verify: passGate(),
    iterationPrompt: (ctx) => `Iteration ${ctx.iteration}: work on ${ctx.currentItem?.id}`,
    workingDir: tmpDir,
    ...overrides,
  };
}

describe("createVerifiedLoop", () => {
  test("throws on missing prdPath", () => {
    expect(() => createVerifiedLoop({ ...makeConfig(), prdPath: "" })).toThrow("prdPath");
  });

  test("throws on missing runIteration", () => {
    expect(() =>
      createVerifiedLoop({
        ...makeConfig(),
        runIteration: undefined as unknown as RunIterationFn,
      }),
    ).toThrow("runIteration");
  });

  test("throws on missing verify", () => {
    expect(() =>
      createVerifiedLoop({
        ...makeConfig(),
        verify: undefined as unknown as VerificationFn,
      }),
    ).toThrow("verify");
  });

  test("throws on missing iterationPrompt", () => {
    expect(() =>
      createVerifiedLoop({
        ...makeConfig(),
        iterationPrompt: undefined as unknown as VerifiedLoopConfig["iterationPrompt"],
      }),
    ).toThrow("iterationPrompt");
  });
});

describe("VerifiedLoop.run", () => {
  test("completes all PRD items", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
        { id: "c", description: "Task C", done: false },
      ],
    });

    const loop = createVerifiedLoop(makeConfig());
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

    const loop = createVerifiedLoop(makeConfig({ maxIterations: 1, verify: failGate() }));
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

    const loop = createVerifiedLoop(
      makeConfig({
        verify: async (_ctx) => {
          loop.stop();
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
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

    const loop = createVerifiedLoop(makeConfig({ runIteration: throwingRunner(1) }));
    const result = await loop.run();

    expect(result.iterationRecords[0]?.error).toBe("Iteration failed");
    expect(result.iterations).toBe(2);
  });

  test("handles gate error and continues", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    // Use let — justified: mutable counter for gate behavior change
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        maxIterations: 2,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) throw new Error("Gate crashed");
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.completed).toContain("a");
  });

  test("returns immediately if all items already done", async () => {
    await writePrd({
      items: [{ id: "a", description: "Done", done: true, verifiedAt: "2024-01-01T00:00:00.000Z" }],
    });

    const loop = createVerifiedLoop(makeConfig());
    const result = await loop.run();

    expect(result.iterations).toBe(0);
    expect(result.completed).toEqual(["a"]);
    expect(result.remaining).toEqual([]);
  });

  test("throws when PRD file is missing", async () => {
    const loop = createVerifiedLoop(makeConfig({ prdPath: join(tmpDir, "missing.json") }));
    await expect(loop.run()).rejects.toThrow(/cannot read PRD/);
  });

  test("throws when PRD file is malformed JSON", async () => {
    await Bun.write(prdPath, "{ not valid json");
    const loop = createVerifiedLoop(makeConfig());
    await expect(loop.run()).rejects.toThrow(/cannot read PRD/);
  });

  test("throws when PRD becomes unreadable mid-loop or before final snapshot", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(
      makeConfig({
        verify: async () => {
          // Corrupt the PRD during the gate. Whichever read hits the
          // corruption first (markDone, mid-loop, or final) must throw —
          // never collapse to a silent zero-work result.
          await Bun.write(prdPath, "{ broken after iteration");
          return { passed: true };
        },
      }),
    );
    await expect(loop.run()).rejects.toThrow(/PRD/);
  });

  test("throws fatally when bumpFailureCount cannot persist (PRD storage error)", async () => {
    // Regression: previously a failed bumpFailureCount() was logged-and-
    // continued, losing the durable skip budget — a permanently failing item
    // could be retried indefinitely. Now PRD storage failures are fatal.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(
      makeConfig({
        verify: async () => {
          // After the gate runs but before bumpFailureCount, corrupt the PRD
          // so the read inside bumpFailureCount throws.
          await Bun.write(prdPath, "{ broken before bump");
          return { passed: false, details: "still failing" };
        },
      }),
    );
    await expect(loop.run()).rejects.toThrow(/failed to persist|PRD/);
  });

  test("learnings write failure does not abort the run after PRD has been mutated", async () => {
    // Regression: appendLearning throwing left run() rejecting AFTER markDone
    // already committed PRD state, producing an inconsistent caller view.
    // Now learnings persistence is best-effort.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    // Force a learnings write failure: pass a learningsPath that points at an
    // existing directory so Bun.write to "<dir>.tmp" then rename fails.
    const dirAsLearnings = join(tmpDir, "learnings-dir");
    await Bun.write(join(dirAsLearnings, "marker.txt"), "x"); // creates the dir

    const loop = createVerifiedLoop(
      makeConfig({
        learningsPath: dirAsLearnings,
      }),
    );
    const result = await loop.run();

    // Run completed successfully despite the broken learnings path.
    expect(result.completed).toContain("a");
    expect(result.iterations).toBe(1);
  });

  test("operator stop does not consume the consecutive-failure budget", async () => {
    // Regression: previously stop() flowed through the catch path as
    // passed:false, which bumped consecutiveFailureCount and could even
    // mark unrelated items skipped after enough operator restarts.
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createVerifiedLoop(
      makeConfig({
        maxConsecutiveFailures: 1,
        verify: async (ctx) => {
          // Stop the loop, then have the gate observe the abort and "fail".
          loop.stop();
          // ctx.signal may already be aborted by the time we get here; check first.
          if (!ctx.signal.aborted) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve());
            });
          }
          return { passed: false, details: "cooperatively cancelled" };
        },
      }),
    );
    await loop.run();

    const after = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    // Item must NOT be skipped just because the operator stopped the loop.
    expect(after.items[0]?.skipped).toBeFalsy();
    expect(after.items[0]?.consecutiveFailureCount ?? 0).toBe(0);
  });

  test("markDone clears prior skipped + consecutiveFailureCount", async () => {
    // Regression: a previously skipped item completed indirectly via
    // itemsCompleted would still appear in `result.skipped`, and stale
    // consecutiveFailureCount would reduce the budget on a reopened item.
    await writePrd({
      items: [
        {
          id: "a",
          description: "Was skipped",
          done: false,
          skipped: true,
          consecutiveFailureCount: 3,
        },
        { id: "b", description: "Current", done: false },
      ],
    });

    const loop = createVerifiedLoop(
      makeConfig({ verify: async () => ({ passed: true, itemsCompleted: ["a"] }) }),
    );
    const result = await loop.run();

    expect(result.completed).toContain("a");
    expect(result.skipped).not.toContain("a"); // no longer in skipped set
    const after = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    const a = after.items.find((i) => i.id === "a");
    expect(a?.done).toBe(true);
    expect(a?.skipped).toBe(false);
    expect(a?.consecutiveFailureCount).toBe(0);
  });

  test("consecutive failure count persists across separate runs", async () => {
    // Regression: previously the failure budget was an in-memory Map, so a
    // process restart reset it and a permanently failing item could never
    // reach maxConsecutiveFailures. Now the count is persisted in the PRD.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    // Run 1: maxConsecutiveFailures = 3, only one iteration before maxIterations.
    const loop1 = createVerifiedLoop(
      makeConfig({
        maxIterations: 1,
        maxConsecutiveFailures: 3,
        verify: failGate(),
      }),
    );
    await loop1.run();

    // Inspect disk: count should be 1, item still active.
    const afterRun1 = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    expect(afterRun1.items[0]?.consecutiveFailureCount).toBe(1);
    expect(afterRun1.items[0]?.skipped).toBeUndefined();

    // Run 2: simulates "process restart". Same threshold, two more iterations.
    // After 2 more failures (total 3), item must be skipped — proving the
    // budget carried across runs.
    const loop2 = createVerifiedLoop(
      makeConfig({
        maxIterations: 5,
        maxConsecutiveFailures: 3,
        verify: failGate(),
      }),
    );
    const result2 = await loop2.run();

    expect(result2.skipped).toContain("a");
    const afterRun2 = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    expect(afterRun2.items[0]?.consecutiveFailureCount).toBeGreaterThanOrEqual(3);
    expect(afterRun2.items[0]?.skipped).toBe(true);
  });

  test("per-iteration records have timing data", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(makeConfig());
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
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(makeConfig());
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

    // Use let — justified: mutable counter for gate behavior change
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) return { passed: true, itemsCompleted: ["a", "b"] };
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

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
    const loop = createVerifiedLoop(
      makeConfig({
        signal: controller.signal,
        verify: async (_ctx) => {
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
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const controller = new AbortController();
    controller.abort("pre-aborted");

    const loop = createVerifiedLoop(makeConfig({ signal: controller.signal }));
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
    const loop = createVerifiedLoop(
      makeConfig({
        iterationTimeoutMs: 50,
        maxIterations: 2,
        runIteration: (_input: EngineInput): AsyncIterable<EngineEvent> => {
          calls++;
          if (calls === 1) {
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
    const loop = createVerifiedLoop(makeConfig({ onIteration: (record) => observed.push(record) }));

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

    // Use let — justified: mutable gate counter
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        maxConsecutiveFailures: 2,
        maxIterations: 10,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls <= 2) return { passed: false, details: "Still failing" };
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
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    // Use let — justified: mutable gate counter
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        maxConsecutiveFailures: 3,
        maxIterations: 5,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls <= 2) return { passed: false, details: "Not yet" };
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    expect(result.completed).toContain("a");
    expect(result.skipped).toEqual([]);
  });

  test("returns immediately if all items already skipped", async () => {
    await writePrd({
      items: [{ id: "a", description: "Skipped", done: false, skipped: true }],
    });

    const loop = createVerifiedLoop(makeConfig());
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

    const loop = createVerifiedLoop(
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

    expect(capturedContexts[0]?.iterationRecords).toBe(0);
    expect(capturedContexts[0]?.learnings).toBe(0);
    expect(capturedContexts[0]?.remainingCount).toBe(2);
    expect(capturedContexts[0]?.completedCount).toBe(0);

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

    const loop = createVerifiedLoop(makeConfig());
    const result = await loop.run();

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

    // Use let — justified: mutable gate counter
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        gateTimeoutMs: 50,
        maxIterations: 3,
        maxConsecutiveFailures: 2,
        verify: async (_ctx) => {
          gateCalls++;
          if (gateCalls === 1) return new Promise(() => {});
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterationRecords[0]?.gateResult.details).toContain("Gate");
    expect(result.completed.length).toBeGreaterThan(0);
  }, 10_000);

  test("stop() aborts a running iteration", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(
      makeConfig({
        maxIterations: 2,
        runIteration: (_input: EngineInput): AsyncIterable<EngineEvent> => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise((resolve) => {
                setTimeout(() => resolve({ done: true, value: undefined }), 5_000);
              }),
          }),
        }),
        verify: passGate(),
      }),
    );

    setTimeout(() => loop.stop(), 50);

    const result = await loop.run();
    expect(result.durationMs).toBeLessThan(3_000);
  }, 10_000);

  test("picks up PRD item added between iterations", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    // Use let — justified: gate counter triggers PRD mutation on iteration 1
    let iter = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        verify: async () => {
          iter++;
          if (iter === 1) {
            const raw = await Bun.file(prdPath).text();
            const prd = JSON.parse(raw) as PRDFile;
            const next: PRDFile = {
              items: [...prd.items, { id: "b", description: "Task B added live", done: false }],
            };
            await Bun.write(prdPath, JSON.stringify(next, null, 2));
          }
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    expect([...result.completed].sort()).toEqual(["a", "b"]);
    expect(result.iterations).toBe(2);
  });

  test("onIteration callback that throws does not kill the loop", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createVerifiedLoop(
      makeConfig({
        onIteration: () => {
          throw new Error("observer bug");
        },
      }),
    );

    const result = await loop.run();
    expect(result.iterations).toBe(2);
    expect([...result.completed].sort()).toEqual(["a", "b"]);
  });

  test("gate timeout aborts ctx.signal, allowing the gate to cancel external work", async () => {
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    // Use let — justified: cooperative gate observes its abort signal
    let firstGateAbortObserved = false;
    let gateCalls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        gateTimeoutMs: 50,
        maxIterations: 3,
        maxConsecutiveFailures: 2,
        verify: async (ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            // Cooperative external worker: yields control while signal pending,
            // resolves only when aborted (proves signal arrived).
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener("abort", () => {
                firstGateAbortObserved = true;
                resolve();
              });
            });
            return { passed: false, details: "cooperatively aborted" };
          }
          return { passed: true };
        },
      }),
    );
    const result = await loop.run();

    expect(firstGateAbortObserved).toBe(true);
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.completed.length).toBeGreaterThan(0);
  }, 5_000);

  test("passing gate with empty itemsCompleted still marks current item done", async () => {
    // Regression: previously a gate returning `passed: true, itemsCompleted: []`
    // (truthy array, empty contents) took the multi-mark branch and marked
    // nothing — leaving the current item pending while learnings logged
    // "Item X completed". Now current.id is always included.
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createVerifiedLoop(
      makeConfig({ verify: async () => ({ passed: true, itemsCompleted: [] }) }),
    );
    const result = await loop.run();
    expect([...result.completed].sort()).toEqual(["a", "b"]);
    expect(result.iterations).toBe(2);
  });

  test("passing gate with only unrelated itemsCompleted still marks current item done", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const loop = createVerifiedLoop(
      makeConfig({ verify: async () => ({ passed: true, itemsCompleted: ["unrelated-id"] }) }),
    );
    const result = await loop.run();
    expect(result.completed).toEqual(["a"]);
    expect(result.iterations).toBe(1);
  });

  test("aborts the run fatally when runIteration's iterator.return() never resolves", async () => {
    // Regression: a runner whose async-iterator return() hangs forever
    // (consumer cleanup bug or non-cooperative adapter) is treated as
    // uncancellable. Continuing to verification or the next iteration
    // while the previous runner may still be mutating the workspace would
    // produce overlapping work and corrupt non-idempotent runners. Better
    // to fail the run loudly than silently advance with a zombie.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const stuckRunner: RunIterationFn = (input: EngineInput): AsyncIterable<EngineEvent> => {
      void input;
      return {
        [Symbol.asyncIterator]: () => ({
          // next() never resolves on its own; iterationTimeoutMs aborts the
          // race, then drainWithAbort enters its finally cleanup path.
          next: () => new Promise(() => {}),
          return: () => new Promise(() => {}), // never resolves
        }),
      };
    };

    const loop = createVerifiedLoop(
      makeConfig({ runIteration: stuckRunner, iterationTimeoutMs: 100 }),
    );
    const start = performance.now();
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    const elapsed = performance.now() - start;
    expect(threw).toBe(true);
    expect(message).toContain("did not settle");
    // 100ms iteration timeout + 5s return budget + slack.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  test("itemsCompleted referencing an unknown id logs warning and completes the known ones", async () => {
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(
      makeConfig({
        verify: async () => ({ passed: true, itemsCompleted: ["a", "ghost"] }),
      }),
    );

    const result = await loop.run();
    expect(result.completed).toEqual(["a"]);
    expect(result.iterations).toBe(1);
  });
});
