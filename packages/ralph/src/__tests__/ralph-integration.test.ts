/**
 * Integration test for the full Ralph Loop.
 *
 * Uses real file I/O, real subprocess gates (via `test -f`),
 * and a mock RunIterationFn that writes marker files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRalphLoop, createTestGate, readLearnings, readPRD } from "../index.js";
import type {
  EngineEvent,
  EngineInput,
  IterationContext,
  PRDFile,
  RunIterationFn,
} from "../types.js";

let tmpDir: string;
let prdPath: string;
let learningsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-integ-"));
  prdPath = join(tmpDir, "prd.json");
  learningsPath = join(tmpDir, "learnings.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const EMPTY_ASYNC_ITERABLE: AsyncIterable<EngineEvent> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};

/**
 * Mock RunIterationFn that writes a marker file for each item.
 * The gate checks for this file to verify the iteration worked.
 */
function createMarkerRunner(dir: string): RunIterationFn {
  return (input: EngineInput): AsyncIterable<EngineEvent> => {
    if (input.kind === "text") {
      const match = /current item: (\S+)/.exec(input.text);
      if (match?.[1]) {
        const markerPath = join(dir, `${match[1]}.done`);
        // Return an async iterable that writes the marker then completes
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await Bun.write(markerPath, "completed");
              return { done: true, value: undefined } as const;
            },
          }),
        };
      }
    }
    return EMPTY_ASYNC_ITERABLE;
  };
}

function makePrompt(ctx: IterationContext): string {
  return [
    `Iteration ${ctx.iteration}/${ctx.totalIterations}`,
    `current item: ${ctx.currentItem?.id ?? "none"}`,
    `remaining: ${ctx.remainingItems.map((i) => i.id).join(", ")}`,
    `completed: ${ctx.completedItems.map((i) => i.id).join(", ")}`,
    `learnings: ${ctx.learnings.length} entries`,
  ].join("\n");
}

describe("Ralph Loop integration", () => {
  test("completes 3-item PRD with real file I/O and subprocess gates", async () => {
    const prd: PRDFile = {
      items: [
        { id: "item-1", description: "First feature", done: false },
        { id: "item-2", description: "Second feature", done: false },
        { id: "item-3", description: "Third feature", done: false },
      ],
    };
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const markersDir = join(tmpDir, "markers");
    await Bun.write(join(markersDir, ".gitkeep"), "");

    // Use let — justified: mutable counter tracking gate calls for dynamic file check
    let gateCallCount = 0;
    const loop = createRalphLoop({
      runIteration: createMarkerRunner(markersDir),
      prdPath,
      learningsPath,
      iterationPrompt: makePrompt,
      workingDir: tmpDir,
      verify: async (ctx) => {
        gateCallCount++;
        // Check that the marker file was created for the current item
        if (!ctx.currentItem) {
          return { passed: false, details: "No current item" };
        }
        const markerPath = join(markersDir, `${ctx.currentItem.id}.done`);
        const gate = createTestGate(["test", "-f", markerPath]);
        return gate(ctx);
      },
    });

    const result = await loop.run();

    // Verify all items completed
    expect(result.iterations).toBe(3);
    expect([...result.completed].sort()).toEqual(["item-1", "item-2", "item-3"]);
    expect(result.remaining).toEqual([]);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify iteration records
    expect(result.iterationRecords).toHaveLength(3);
    for (const record of result.iterationRecords) {
      expect(record.gateResult.passed).toBe(true);
      expect(record.error).toBeUndefined();
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }

    // Verify PRD file was updated
    const finalPrd = await readPRD(prdPath);
    expect(finalPrd.ok).toBe(true);
    if (finalPrd.ok) {
      expect(finalPrd.value.items.every((i) => i.done)).toBe(true);
      for (const item of finalPrd.value.items) {
        expect(item.verifiedAt).toBeDefined();
      }
    }

    // Verify learnings file has entries
    const learnings = await readLearnings(learningsPath);
    expect(learnings).toHaveLength(3);
    expect(learnings[0]?.itemId).toBe("item-1");
    expect(learnings[2]?.itemId).toBe("item-3");

    // Verify gate was called for each item
    expect(gateCallCount).toBe(3);
  });

  test("handles partial completion with failing gate", async () => {
    const prd: PRDFile = {
      items: [
        { id: "pass-1", description: "Will pass", done: false },
        { id: "fail-1", description: "Will fail", done: false },
      ],
    };
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const markersDir = join(tmpDir, "markers2");
    await Bun.write(join(markersDir, ".gitkeep"), "");

    const loop = createRalphLoop({
      runIteration: createMarkerRunner(markersDir),
      prdPath,
      learningsPath,
      iterationPrompt: makePrompt,
      workingDir: tmpDir,
      maxIterations: 3,
      verify: async (ctx) => {
        if (!ctx.currentItem) return { passed: false };
        // Only pass for "pass-1"
        if (ctx.currentItem.id === "pass-1") {
          return { passed: true };
        }
        return { passed: false, details: "Deliberately failed" };
      },
    });

    const result = await loop.run();

    // pass-1 should be completed, fail-1 stays remaining
    expect(result.completed).toContain("pass-1");
    expect(result.remaining).toContain("fail-1");
    expect(result.iterations).toBe(3); // hit maxIterations trying fail-1
  });
});
