import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRun, EvalSummary } from "../types.js";
import { createFsEvalStore } from "./fs-store.js";

function makeSummary(): EvalSummary {
  return {
    taskCount: 1,
    trialCount: 2,
    passRate: 0.5,
    passAtK: 1,
    passToTheK: 0.25,
    meanScore: 0.75,
    latencyP50Ms: 100,
    latencyP95Ms: 200,
    totalCostUsd: 0.01,
    byTask: [
      {
        taskId: "t1",
        taskName: "Test",
        passRate: 0.5,
        passAtK: 1,
        passToTheK: 0.25,
        meanScore: 0.75,
        trials: 2,
      },
    ],
  };
}

function makeRun(id: string, name: string): EvalRun {
  return {
    id,
    name,
    timestamp: new Date().toISOString(),
    config: {
      name,
      concurrency: 5,
      timeoutMs: 60_000,
      passThreshold: 0.5,
      taskCount: 1,
    },
    trials: [],
    summary: makeSummary(),
  };
}

// let justified: tracks temp dir for cleanup
let tempDir: string;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("createFsEvalStore", () => {
  test("save and load cycle", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });
    const run = makeRun("run-001", "my-eval");

    await store.save(run);
    const loaded = await store.load("run-001");

    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe("run-001");
    expect(loaded?.name).toBe("my-eval");
    expect(loaded?.summary.passRate).toBe(0.5);
  });

  test("returns undefined for non-existent run", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });

    const loaded = await store.load("non-existent");
    expect(loaded).toBeUndefined();
  });

  test("latest returns most recent run", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });

    const run1 = makeRun("run-001", "my-eval");
    const run2 = makeRun("run-002", "my-eval");

    await store.save(run1);
    await store.save(run2);

    const latest = await store.latest("my-eval");
    expect(latest?.id).toBe("run-002");
  });

  test("latest returns undefined when no runs exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });

    const latest = await store.latest("non-existent");
    expect(latest).toBeUndefined();
  });

  test("list returns all run summaries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });

    await store.save(makeRun("run-001", "my-eval"));
    await store.save(makeRun("run-002", "my-eval"));

    const list = await store.list("my-eval");
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id).sort()).toEqual(["run-001", "run-002"]);
  });

  test("list returns empty array for non-existent eval", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const store = createFsEvalStore({ baseDir: tempDir });

    const list = await store.list("non-existent");
    expect(list).toEqual([]);
  });

  test("save creates directories recursively", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-eval-test-"));
    const deepDir = join(tempDir, "deep", "nested");
    const store = createFsEvalStore({ baseDir: deepDir });

    const run = makeRun("run-001", "my-eval");
    await store.save(run);

    const loaded = await store.load("run-001");
    expect(loaded?.id).toBe("run-001");
  });
});
