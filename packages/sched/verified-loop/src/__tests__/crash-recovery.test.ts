import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPRD } from "../prd-store.js";
import type { EngineEvent, EngineInput, PRDFile, RunIterationFn } from "../types.js";
import { createVerifiedLoop } from "../verified-loop.js";

// Use let — justified: per-test tmpdir reassigned in beforeEach
let tmpDir: string;
let prdPath: string;
let markerPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "verified-loop-crash-"));
  prdPath = join(tmpDir, "prd.json");
  markerPath = join(tmpDir, "marker");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const EMPTY_ITERABLE: AsyncIterable<EngineEvent> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};

function emptyRunner(): RunIterationFn {
  return (_input: EngineInput): AsyncIterable<EngineEvent> => EMPTY_ITERABLE;
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("crash recovery", () => {
  test("PRD state survives SIGKILL between iterations and a fresh loop resumes correctly", async () => {
    const initial: PRDFile = {
      items: [
        { id: "a", description: "Task A", done: false },
        { id: "b", description: "Task B", done: false },
        { id: "c", description: "Task C", done: false },
      ],
    };
    await Bun.write(prdPath, JSON.stringify(initial, null, 2));

    // Spawn the child driver. It runs a slow verify (1s) so we can SIGKILL it
    // after iteration 1 completes (marker.1 appears) but before iteration 2's
    // gate finishes.
    const driverPath = join(import.meta.dir, "crash-driver.ts");
    const child = Bun.spawn(["bun", driverPath, prdPath, markerPath, "1500"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Wait until iteration 1's gate has been entered (marker.1 written).
      const marker1Seen = await waitForFile(`${markerPath}.1`, 5_000);
      expect(marker1Seen).toBe(true);

      // Wait until iteration 2's gate has been entered (proves iter 1 did mark "a" done).
      const marker2Seen = await waitForFile(`${markerPath}.2`, 5_000);
      expect(marker2Seen).toBe(true);

      // Kill the child while iteration 2's gate is still sleeping.
      child.kill("SIGKILL");
      await child.exited;
    } finally {
      // Defensive — kill if still alive.
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }

    // Inspect PRD on disk: "a" should be done (atomically written), "b" and "c" still pending.
    const afterCrash = await readPRD(prdPath);
    expect(afterCrash.ok).toBe(true);
    if (afterCrash.ok) {
      const byId = Object.fromEntries(afterCrash.value.items.map((i) => [i.id, i]));
      expect(byId.a?.done).toBe(true);
      expect(byId.a?.verifiedAt).toBeDefined();
      expect(byId.b?.done).toBe(false);
      expect(byId.c?.done).toBe(false);
    }

    // Fresh loop in-process — should pick up where the child left off.
    const loop = createVerifiedLoop({
      prdPath,
      runIteration: emptyRunner(),
      verify: async () => ({ passed: true }),
      iterationPrompt: (ctx) => `resume: ${ctx.currentItem?.id}`,
    });
    const result = await loop.run();

    expect([...result.completed].sort()).toEqual(["a", "b", "c"]);
    expect(result.iterations).toBe(2); // only b and c remained
    expect(result.iterationRecords.map((r) => r.itemId)).toEqual(["b", "c"]);
  }, 30_000);

  test("PRD never observed in partial-write state during a crash window", async () => {
    // Hammer markDone-equivalent path: spawn many sequential markDone calls and
    // assert the file is always parseable (write-temp-rename atomicity).
    const initial: PRDFile = {
      items: Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        description: `Task ${i}`,
        done: false,
      })),
    };
    await Bun.write(prdPath, JSON.stringify(initial, null, 2));

    const loop = createVerifiedLoop({
      prdPath,
      runIteration: emptyRunner(),
      verify: async () => ({ passed: true }),
      iterationPrompt: (ctx) => `${ctx.currentItem?.id}`,
      maxIterations: 20,
    });

    // While the loop runs, repeatedly read the file and assert it always parses.
    // Use let — justified: terminator flag for poll loop
    let stop = false;
    const poller = (async () => {
      // Use let — justified: counter for parseable reads
      let parseCount = 0;
      while (!stop) {
        const raw = await Bun.file(prdPath).text();
        // A partially-written file would throw here.
        const parsed = JSON.parse(raw) as PRDFile;
        expect(Array.isArray(parsed.items)).toBe(true);
        parseCount++;
      }
      return parseCount;
    })();

    await loop.run();
    stop = true;
    const reads = await poller;

    expect(reads).toBeGreaterThan(0);
    const final = await readPRD(prdPath);
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.value.items.every((i) => i.done)).toBe(true);
    }
  }, 30_000);
});
