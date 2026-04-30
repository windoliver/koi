import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompositeGate, createFileGate, createTestGate } from "./gates.js";
import type { GateContext, VerificationFn } from "./types.js";

// Use let — justified: per-test tmpdir reassigned in beforeEach
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "verified-loop-gates-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides?: Partial<GateContext>): GateContext {
  return {
    iteration: 1,
    currentItem: undefined,
    workingDir: tmpDir,
    iterationRecords: [],
    learnings: [],
    remainingItems: [],
    completedItems: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("createTestGate", () => {
  test("passes on exit code 0", async () => {
    const gate = createTestGate(["true"]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
  });

  test("fails on exit code 1", async () => {
    const gate = createTestGate(["false"]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
    expect(result.details).toContain("exit");
  });

  test("handles timeout", async () => {
    const gate = createTestGate(["sleep", "10"], { timeoutMs: 100 });
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
  }, 5_000);

  test("handles spawn failure for nonexistent command", async () => {
    const gate = createTestGate(["__nonexistent_command_verified_loop_test__"]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
    expect(result.details).toBeDefined();
  });

  test("uses custom cwd", async () => {
    const gate = createTestGate(["pwd"], { cwd: tmpDir });
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
  });
});

describe("createFileGate", () => {
  test("passes on string match", async () => {
    const filePath = join(tmpDir, "output.txt");
    await Bun.write(filePath, "hello world");
    const gate = createFileGate(filePath, "hello");
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
  });

  test("fails when string not found", async () => {
    const filePath = join(tmpDir, "output.txt");
    await Bun.write(filePath, "hello world");
    const gate = createFileGate(filePath, "goodbye");
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
  });

  test("passes on regex match", async () => {
    const filePath = join(tmpDir, "output.txt");
    await Bun.write(filePath, "version: 2.3.1");
    const gate = createFileGate(filePath, /version:\s*\d+\.\d+\.\d+/);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
  });

  test("fails on missing file", async () => {
    const gate = createFileGate(join(tmpDir, "missing.txt"), "anything");
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
    expect(result.details).toContain("not found");
  });
});

describe("createTestGate pipe handling", () => {
  test("does not deadlock when child writes a large amount to stdout", async () => {
    // Regression: previously stdout was piped but never drained, so a child
    // emitting more than the OS pipe buffer (typically 64KB) would block on
    // write before exiting, hanging the gate until timeoutMs killed it.
    // 1MB to stdout + exit 0 must succeed quickly.
    const gate = createTestGate(["bash", "-c", "yes hello | head -c 1048576; exit 0"], {
      timeoutMs: 3_000,
    });
    const start = performance.now();
    const result = await gate(makeCtx());
    const elapsed = performance.now() - start;
    expect(result.passed).toBe(true);
    expect(elapsed).toBeLessThan(2_500);
  }, 5_000);
});

describe("createTestGate signal handling", () => {
  test("returns immediately when ctx.signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    const gate = createTestGate(["sleep", "10"]);
    const start = performance.now();
    const result = await gate(makeCtx({ signal: controller.signal }));
    const elapsed = performance.now() - start;
    expect(result.passed).toBe(false);
    expect(result.details).toContain("aborted before start");
    expect(elapsed).toBeLessThan(100);
  });

  test("kills the spawned process when ctx.signal aborts mid-run", async () => {
    const controller = new AbortController();
    const gate = createTestGate(["sleep", "10"]);
    setTimeout(() => controller.abort("test abort"), 50);
    const start = performance.now();
    const result = await gate(makeCtx({ signal: controller.signal }));
    const elapsed = performance.now() - start;
    expect(result.passed).toBe(false);
    expect(elapsed).toBeLessThan(2_000); // not 10s
  }, 5_000);

  test("kills forked descendants of the gate command (process-group kill)", async () => {
    // Regression: a per-PID kill leaves descendants alive after timeout/abort.
    // With detached:true + kill(-pgid), the whole tree must die. Test case is
    // bash that traps TERM, forks sleep, then waits — single-PID kill of bash
    // would leave sleep re-parented and holding stderr open until 30s.
    const controller = new AbortController();
    const gate = createTestGate(["bash", "-c", "trap '' TERM; sleep 30 & wait"]);
    setTimeout(() => controller.abort("force"), 50);
    const start = performance.now();
    const result = await gate(makeCtx({ signal: controller.signal }));
    const elapsed = performance.now() - start;
    expect(result.passed).toBe(false);
    expect(elapsed).toBeLessThan(5_000); // not 30s
  }, 10_000);

  test("escalates to SIGKILL when child ignores SIGTERM", async () => {
    // Regression: a child that ignores or traps the initial termination
    // request would stay alive past proc.kill(); the gate could return
    // before the child died. Two-phase kill (SIGTERM then SIGKILL after a
    // grace) guarantees the process is gone before we advance.
    const controller = new AbortController();
    // Single-process child that ignores SIGTERM; SIGKILL cannot be trapped.
    // (A bash subshell with `trap '' TERM` is not a valid test because bash's
    // child sleep keeps stderr open after bash dies — re-parenting hides our
    // sleep from sigkill until it naturally exits. Any production gate that
    // forks subshells will exhibit similar long-lived descendants. Killing
    // the whole process group is out of scope here.)
    const gate = createTestGate([
      "bun",
      "-e",
      'process.on("SIGTERM", () => {}); await new Promise(() => {})',
    ]);
    setTimeout(() => controller.abort("force"), 50);
    const start = performance.now();
    const result = await gate(makeCtx({ signal: controller.signal }));
    const elapsed = performance.now() - start;
    expect(result.passed).toBe(false);
    // Must die from SIGKILL within (50ms abort + 1s SIGTERM grace + slack).
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});

describe("createCompositeGate", () => {
  test("passes when all sub-gates pass", async () => {
    const filePath = join(tmpDir, "marker.txt");
    await Bun.write(filePath, "DONE");

    const gate = createCompositeGate([createTestGate(["true"]), createFileGate(filePath, "DONE")]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
  });

  test("fails when one sub-gate fails", async () => {
    const gate = createCompositeGate([createTestGate(["true"]), createTestGate(["false"])]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(false);
    expect(result.details).toBeDefined();
  });

  test("collects itemsCompleted from all gates", async () => {
    const gate1: VerificationFn = async () => ({
      passed: true,
      itemsCompleted: ["a"],
    });
    const gate2: VerificationFn = async () => ({
      passed: true,
      itemsCompleted: ["b"],
    });

    const composite = createCompositeGate([gate1, gate2]);
    const result = await composite(makeCtx());
    expect(result.passed).toBe(true);
    expect(result.itemsCompleted).toEqual(["a", "b"]);
  });

  test("dedups itemsCompleted reported by multiple gates", async () => {
    const gate1: VerificationFn = async () => ({ passed: true, itemsCompleted: ["a", "b"] });
    const gate2: VerificationFn = async () => ({ passed: true, itemsCompleted: ["b", "c"] });
    const composite = createCompositeGate([gate1, gate2]);
    const result = await composite(makeCtx());
    expect(result.itemsCompleted).toEqual(["a", "b", "c"]);
  });

  test("returns undefined itemsCompleted when none provided", async () => {
    const gate = createCompositeGate([createTestGate(["true"])]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
    expect(result.itemsCompleted).toBeUndefined();
  });

  test("stops running remaining sub-gates after ctx.signal aborts", async () => {
    const controller = new AbortController();
    const ranAfterAbort: string[] = [];
    const gate1: VerificationFn = async (ctx) => {
      controller.abort("test abort");
      // Signal aborts during this sub-gate; subsequent gates must not run.
      void ctx;
      return { passed: true };
    };
    const gate2: VerificationFn = async () => {
      ranAfterAbort.push("gate2");
      return { passed: true };
    };

    const composite = createCompositeGate([gate1, gate2]);
    const result = await composite(makeCtx({ signal: controller.signal }));

    expect(ranAfterAbort).toEqual([]);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("aborted");
  });
});
