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

  test("throws on negative iterationTimeoutMs", () => {
    expect(() => createVerifiedLoop(makeConfig({ iterationTimeoutMs: -1 }))).toThrow(
      "iterationTimeoutMs must be a positive integer",
    );
  });

  test("throws on NaN gateTimeoutMs", () => {
    expect(() => createVerifiedLoop(makeConfig({ gateTimeoutMs: Number.NaN }))).toThrow(
      "gateTimeoutMs must be a positive integer",
    );
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
    // Updated for the runner-failure-skips-verify rule: a runner crash on
    // iteration 1 no longer falsely passes the gate against stale state,
    // so item "a" stays pending. Iteration 2 retries it successfully,
    // iteration 3 completes "b". The error is recorded on iteration 1.
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });

    const loop = createVerifiedLoop(makeConfig({ runIteration: throwingRunner(1) }));
    const result = await loop.run();

    expect(result.iterationRecords[0]?.error).toBe("Iteration failed");
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.completed).toEqual(["a", "b"]);
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

  test("runner failures do not consume the per-item skip budget", async () => {
    // Regression: a runner that throws (engine crash, adapter bug,
    // transient infra outage) sets gateResult.passed:false because the
    // gate never runs against an unverified workspace. Previously the
    // generic !passed branch then bumpFailureCount'd, so N infra
    // failures would mark the item skipped:true even though no
    // verification ever happened. Only true verification failures
    // should accumulate against maxConsecutiveFailures.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const loop = createVerifiedLoop(
      makeConfig({
        maxIterations: 3,
        maxConsecutiveFailures: 1,
        runIteration: (_input: EngineInput): AsyncIterable<EngineEvent> => {
          throw new Error("Adapter exploded");
        },
      }),
    );
    await loop.run();

    const after = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    // Item must NOT be marked skipped — the runner never produced
    // verifiable work, so the budget was not consumed.
    expect(after.items[0]?.skipped).toBeFalsy();
    expect(after.items[0]?.consecutiveFailureCount ?? 0).toBe(0);
    expect(after.items[0]?.done).toBe(false);
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
                // Cooperative cancellation: required by the contract so a
                // timed-out runner can be confirmed stopped before the loop
                // advances. Without this, the loop fails with
                // RunnerStuckError.
                return: async () => ({ done: true, value: undefined }),
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

  test("gate timeout records error and continues (cooperative gate)", async () => {
    // Updated for the gate-quiescence contract: a gate that ignores
    // ctx.signal and never settles after timeout is fatal RunnerStuckError
    // (see "gate-stuck" test below). Cooperative gates that DO honor
    // ctx.signal still let the loop continue past a single timeout.
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
        verify: async (ctx) => {
          gateCalls++;
          if (gateCalls === 1) {
            // Cooperative: settle when ctx.signal aborts.
            return new Promise<VerificationResult>((resolve) => {
              ctx.signal.addEventListener(
                "abort",
                () => resolve({ passed: false, details: "Gate aborted by ctx.signal" }),
                { once: true },
              );
            });
          }
          return { passed: true };
        },
      }),
    );

    const result = await loop.run();
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterationRecords[0]?.gateResult.details).toContain("Gate");
    expect(result.completed.length).toBeGreaterThan(0);
  }, 10_000);

  test("uncooperative gate (ignores ctx.signal) is fatal RunnerStuckError after timeout", async () => {
    // Regression: a gate that times out but keeps running background work
    // would let the loop advance to the next iteration while the previous
    // verify() was still mutating external systems. Now the loop waits a
    // bounded grace for the gate promise to settle; if it doesn't, fatal.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const loop = createVerifiedLoop(
      makeConfig({
        gateTimeoutMs: 50,
        verify: () => new Promise(() => {}), // ignores signal forever
      }),
    );
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toContain("did not quiesce");
  }, 15_000);

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
            // Cooperative cancellation required by the contract.
            return: async () => ({ done: true, value: undefined }),
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

  test("resolves a relative prdPath against workingDir, not process.cwd", async () => {
    // Regression: when both prdPath is relative and workingDir is set,
    // the loop must resolve the PRD against workingDir. Otherwise a
    // process launched from a different cwd would silently read or
    // overwrite an unrelated prd.json.
    const items: PRDFile = { items: [{ id: "a", description: "Task A", done: false }] };
    await Bun.write(join(tmpDir, "nested.json"), JSON.stringify(items, null, 2));
    const loop = createVerifiedLoop({
      ...makeConfig(),
      prdPath: "nested.json", // relative
      workingDir: tmpDir,
    });
    const result = await loop.run();
    expect(result.completed).toEqual(["a"]);
    expect(result.iterations).toBe(1);
  });

  test("does not call iterator.return() after natural EOF (compat with strict adapters)", async () => {
    // Regression: drainWithAbort previously called iterator.return() even
    // after done:true. Many adapter iterators only define meaningful
    // return() behavior for early termination — a post-EOF return() may
    // reject or destructively cleanup. That would fail otherwise-clean
    // runs as RunnerStuckError.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    let returnCalled = false;
    const eofRejectingRunner: RunIterationFn = (input: EngineInput): AsyncIterable<EngineEvent> => {
      void input;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
          return: async () => {
            returnCalled = true;
            throw new Error("post-EOF cleanup not supported");
          },
        }),
      };
    };

    const loop = createVerifiedLoop(makeConfig({ runIteration: eofRejectingRunner }));
    const result = await loop.run();
    expect(returnCalled).toBe(false);
    expect(result.completed).toEqual(["a"]);
  });

  test("does not commit work when the runner throws synchronously", async () => {
    // Regression: a runner that crashes (synchronous throw, adapter
    // exception, early stream failure) recorded iterError but the
    // orchestrator still ran verify() and could mark the item done if
    // the gate passed against stale workspace state. Runner failure must
    // be treated as untrusted iteration result — skip verify, force
    // passed:false. Counts against the per-item failure budget (this is
    // a real failure, not operator-stop).
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    let verifyCalled = false;
    const loop = createVerifiedLoop(
      makeConfig({
        runIteration: throwingRunner(1),
        verify: async () => {
          verifyCalled = true;
          return { passed: true };
        },
        // Cap the loop so a permanently-failing item doesn't loop forever.
        maxIterations: 1,
      }),
    );
    const result = await loop.run();
    expect(verifyCalled).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterationRecords[0]?.error).toBe("Iteration failed");
  });

  test("does not commit work when an iteration is aborted/timed out", async () => {
    // Regression: iterError was recorded but verify() still ran and
    // unconditionally persisted completion when passed:true. A file gate
    // checking stale workspace state could mark the item done despite the
    // runner being cut short. Aborted/timed-out iterations must skip
    // verify entirely and treat the result as a hard failure.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const stuckRunner: RunIterationFn = (input: EngineInput): AsyncIterable<EngineEvent> => {
      void input;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: async () => ({ done: true, value: undefined }),
        }),
      };
    };

    let verifyCalled = false;
    const loop = createVerifiedLoop(
      makeConfig({
        runIteration: stuckRunner,
        iterationTimeoutMs: 100,
        verify: async () => {
          verifyCalled = true;
          // Even if the gate were called, this would falsely report success.
          return { passed: true };
        },
        // Force termination so the test doesn't loop maxIterations × 100ms.
        maxIterations: 1,
      }),
    );
    const result = await loop.run();
    expect(verifyCalled).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
  }, 5_000);

  test("synchronous verify() throw degrades to a failed gate, not a fatal run", async () => {
    // Regression: config.verify(...) was called outside the try block, so
    // a sync throw (missing dep, bad context, local validation) crashed
    // the whole loop with the current item left pending and no failure
    // budget accounting. Now it degrades to a failed gate, just like an
    // async rejection.
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });
    let calls = 0;
    const loop = createVerifiedLoop(
      makeConfig({
        maxConsecutiveFailures: 5,
        verify: ((_ctx: GateContext) => {
          calls++;
          if (calls === 1) throw new Error("verify built incorrectly");
          return Promise.resolve({ passed: true });
        }) as VerificationFn,
      }),
    );
    const result = await loop.run();
    expect(result.iterationRecords[0]?.gateResult.passed).toBe(false);
    expect(result.iterationRecords[0]?.gateResult.details).toContain("verify built incorrectly");
    expect(result.completed).toEqual(["a", "b"]);
  });

  test("createVerifiedLoop rejects maxConsecutiveFailures < 1", () => {
    expect(() => createVerifiedLoop({ ...makeConfig(), maxConsecutiveFailures: 0 })).toThrow(
      /maxConsecutiveFailures/,
    );
    expect(() => createVerifiedLoop({ ...makeConfig(), maxConsecutiveFailures: -3 })).toThrow(
      /maxConsecutiveFailures/,
    );
    expect(() => createVerifiedLoop({ ...makeConfig(), maxConsecutiveFailures: 1.5 })).toThrow(
      /maxConsecutiveFailures/,
    );
    expect(() =>
      createVerifiedLoop({ ...makeConfig(), maxConsecutiveFailures: Number.NaN }),
    ).toThrow(/maxConsecutiveFailures/);
  });

  test("rejects a second run() on the same instance (single-use contract)", async () => {
    // Regression: createVerifiedLoop returned an object with reusable
    // run/stop methods, but state (especially abortController) was
    // shared across calls. Once stop() fired, subsequent run() returned
    // immediately with pending items untouched. Make the contract
    // explicit: each instance is single-use; create a new one to run again.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const loop = createVerifiedLoop(makeConfig());
    await loop.run();
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toContain("already completed");
  });

  test("rejects an overlapping concurrent run() on the same instance", async () => {
    // Regression: two callers could await loop.run() in parallel and
    // both operate on the same PRD with shared cancellation. Single-flight
    // guard rejects the second call immediately.
    await writePrd({
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
      ],
    });
    const loop = createVerifiedLoop(makeConfig());
    const p1 = loop.run();
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    await p1;
    expect(threw).toBe(true);
    expect(message).toContain("already running");
  });

  test("aborts the run fatally when iterator has no return() and is cancelled", async () => {
    // Regression: runIteration is consumer-injected and only typed as
    // AsyncIterable; iterator.return() is optional. Without return(), we
    // have no way to signal a timed-out runner to stop, and can't prove
    // its side effects have finished. Continuing the loop in that state
    // would let the previous runner keep mutating the workspace behind
    // the next iteration. Treat missing return() on early exit as fatal.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const noReturnRunner: RunIterationFn = (input: EngineInput): AsyncIterable<EngineEvent> => {
      void input;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          // Deliberately omit return — iterator protocol allows it.
        }),
      };
    };

    const loop = createVerifiedLoop(
      makeConfig({ runIteration: noReturnRunner, iterationTimeoutMs: 100 }),
    );
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toContain("no return() method");
  }, 5_000);

  test("aborts the run fatally when iterator.return() rejects during cleanup", async () => {
    // Regression: a runner that signals cleanup failure (return() rejects)
    // is just as dangerous as one that hangs — we cannot assume side
    // effects have stopped. Continuing to verification or the next
    // iteration could overlap with stale work. Both paths now throw
    // RunnerStuckError fatally.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });

    const rejectingRunner: RunIterationFn = (input: EngineInput): AsyncIterable<EngineEvent> => {
      void input;
      return {
        [Symbol.asyncIterator]: () => ({
          // next() never resolves — iterationTimeoutMs aborts the drain
          // and triggers the cleanup path. The return() rejection during
          // this early-exit cleanup must be fatal.
          next: () => new Promise(() => {}),
          return: async () => {
            throw new Error("cleanup failed: subprocess unreachable");
          },
        }),
      };
    };

    const loop = createVerifiedLoop(
      makeConfig({ runIteration: rejectingRunner, iterationTimeoutMs: 100 }),
    );
    let threw = false;
    let message: string | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toContain("rejected during cleanup");
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

  test("refuses to start when another live coordinator holds the PRD lock", async () => {
    // Regression: previously two verified-loop processes against the same
    // PRD raced the optimistic CAS and could silently lose updates. The
    // PRD lock now refuses the second runner at run() entry.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    // Simulate a live holder by writing a lock file with this process's
    // own PID (which IS alive) and a fresh acquiredAt timestamp.
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: "test",
        owner: "external",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    try {
      const loop = createVerifiedLoop(makeConfig());
      let threw: Error | undefined;
      try {
        await loop.run();
      } catch (e: unknown) {
        threw = e as Error;
      }
      expect(threw).toBeDefined();
      expect(threw?.message).toContain("CONFLICT");
      expect(threw?.message).toContain("locked by another live coordinator");
    } finally {
      await Bun.file(lockPath)
        .delete()
        .catch(() => undefined);
    }
  });

  test("does NOT break a healthy long-running lock based on age alone", async () => {
    // Regression: an earlier implementation marked any lock older than
    // 30s as stale before checking PID liveness. Default iteration
    // timeout is 10 min and gate is 2 min, so a normal long-running
    // loop would lose exclusivity. Now age is irrelevant — only PID
    // liveness matters.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    // Lock held by an external owner, acquired 1 hour ago, BUT
    // heartbeat is fresh (within the staleness window). The lock must
    // remain held — heartbeat freshness is the source of truth.
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: "test",
        owner: "external-owner",
        acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    try {
      const loop = createVerifiedLoop(makeConfig());
      let threw: Error | undefined;
      try {
        await loop.run();
      } catch (e: unknown) {
        threw = e as Error;
      }
      expect(threw).toBeDefined();
      expect(threw?.message).toContain("CONFLICT");
    } finally {
      await Bun.file(lockPath)
        .delete()
        .catch(() => undefined);
    }
  });

  test("releasePRDLock does not delete a lock owned by another process", async () => {
    // Regression: previously releasePRDLock blindly unlinked the
    // lockfile. If a stale-break ever races a normal exit, coordinator
    // A would delete coordinator B's live lock on A's own teardown.
    // Ownership token must be checked.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    // First runner completes successfully, releasing its lock.
    const loopA = createVerifiedLoop(makeConfig());
    await loopA.run();
    // Now a different external owner takes the lock.
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: "test",
        owner: "external-owner-token",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    try {
      // A second runner attempts to start and fails (lock held).
      const loopB = createVerifiedLoop(makeConfig());
      let threw: Error | undefined;
      try {
        await loopB.run();
      } catch (e: unknown) {
        threw = e as Error;
      }
      expect(threw).toBeDefined();
      // Critical: the external lock must still exist with the correct owner.
      const after = JSON.parse(await Bun.file(lockPath).text()) as { owner: string };
      expect(after.owner).toBe("external-owner-token");
    } finally {
      await Bun.file(lockPath)
        .delete()
        .catch(() => undefined);
    }
  });

  test("does not steal a live lock just because it is unparseable", async () => {
    // Regression: a transient readFile fault, partial read on flaky
    // storage, or zero-byte lock from a write crash would previously
    // be treated as "stale", letting a second coordinator break a
    // potentially-live lock and produce split-brain mutation. Treat
    // unreadable/corrupt as live (CONFLICT) — operator must manually
    // resolve a genuinely corrupt lock.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    await Bun.write(lockPath, "{ this is not valid json");
    try {
      const loop = createVerifiedLoop(makeConfig());
      let threw: Error | undefined;
      try {
        await loop.run();
      } catch (e: unknown) {
        threw = e as Error;
      }
      expect(threw).toBeDefined();
      expect(threw?.message).toContain("CONFLICT");
      // Lock file must still be there — we did NOT steal it.
      const stillThere = await Bun.file(lockPath).exists();
      expect(stillThere).toBe(true);
    } finally {
      await Bun.file(lockPath)
        .delete()
        .catch(() => undefined);
    }
  });

  test("refuses to commit when lock is stolen mid-iteration", async () => {
    // Regression: a coordinator whose lock was stale-broken between
    // iterations could still call markDoneMany / bumpFailureCount for
    // the rest of its current iteration — split-brain mutation. The
    // pre-write ownership check now refuses every PRD mutation if the
    // lock is no longer ours.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    const loop = createVerifiedLoop(
      makeConfig({
        verify: async (_ctx) => {
          // Steal the lock during verify(): unlink and recreate with a
          // different owner token.
          await Bun.file(lockPath)
            .delete()
            .catch(() => undefined);
          await Bun.write(
            lockPath,
            JSON.stringify({
              pid: process.pid,
              host: "thief",
              owner: "thief-token",
              acquiredAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
            }),
          );
          return { passed: true };
        },
      }),
    );
    let threw: Error | undefined;
    try {
      await loop.run();
    } catch (e: unknown) {
      threw = e as Error;
    }
    expect(threw).toBeDefined();
    expect(threw?.message).toContain("no longer owned by this coordinator");
    // PRD must NOT show "a" as done — the stolen-lock coordinator
    // must not have committed.
    const after = JSON.parse(await Bun.file(prdPath).text()) as PRDFile;
    expect(after.items[0]?.done).toBe(false);
    // Cleanup the thief lock.
    await Bun.file(lockPath)
      .delete()
      .catch(() => undefined);
  });

  test("breaks a lock with a stale heartbeat", async () => {
    // Regression: a crashed coordinator leaves its lock file behind
    // with a heartbeat that no live owner is updating. After
    // HEARTBEAT_STALE_MS (15 min) the next runner must be able to
    // take over. Heartbeat-based stale detection is preferred over
    // PID-based because PID can be reused after crash.
    await writePrd({ items: [{ id: "a", description: "Task A", done: false }] });
    const lockPath = `${prdPath}.lock`;
    // Heartbeat from 1 hour ago — well past the 15-min staleness threshold.
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: "test",
        owner: "dead-owner",
        acquiredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );
    const loop = createVerifiedLoop(makeConfig());
    const result = await loop.run();
    expect(result.completed).toContain("a");
    // Lock should be released by the loop's finally block.
    const stillLocked = await Bun.file(lockPath).exists();
    expect(stillLocked).toBe(false);
  });
});
