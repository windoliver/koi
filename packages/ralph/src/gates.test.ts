import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompositeGate, createFileGate, createTestGate } from "./gates.js";
import type { GateContext, VerificationFn } from "./types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-gates-"));
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
    const gate = createTestGate(["__nonexistent_command_ralph_test__"]);
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

  test("returns undefined itemsCompleted when none provided", async () => {
    const gate = createCompositeGate([createTestGate(["true"])]);
    const result = await gate(makeCtx());
    expect(result.passed).toBe(true);
    expect(result.itemsCompleted).toBeUndefined();
  });
});
