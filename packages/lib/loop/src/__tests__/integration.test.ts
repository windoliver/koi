/**
 * Integration test — real Bun subprocess gate + scripted fake runtime.
 *
 * The fake runtime simulates an agent that "writes a file" on iteration 2,
 * which makes a real `bun` subprocess gate flip from exit 1 to exit 0.
 * This exercises: argv gate spawn path, file I/O side effects, transition
 * from fail → pass, iterationRecord shape, and terminal event emission.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EngineOutput } from "@koi/core";
import { createArgvGate } from "../gates/argv-gate.js";
import { createCompositeGate } from "../gates/composite-gate.js";
import { runUntilPass } from "../run-until-pass.js";
import type { LoopEvent, LoopRuntime } from "../types.js";

function doneEvent(tokens = 0): EngineEvent {
  const output: EngineOutput = {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: tokens,
      inputTokens: 0,
      outputTokens: tokens,
      turns: 1,
      durationMs: 0,
    },
  };
  return { kind: "done", output };
}

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "koi-loop-int-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("integration — real subprocess gate + fake runtime", () => {
  test("converges after runtime writes the expected file", async () => {
    const markerPath = join(workDir, "marker");
    // Ensure a clean start
    await rm(markerPath, { force: true });

    // Real argv gate: exits 0 if marker exists, else 1.
    // Using a small shell-free argv via bun -e.
    const gate = createArgvGate(
      [
        "bun",
        "-e",
        `process.exit(require('node:fs').existsSync(${JSON.stringify(markerPath)}) ? 0 : 1)`,
      ],
      { cwd: workDir, timeoutMs: 5000 },
    );

    let iteration = 0;
    const runtime: LoopRuntime = {
      async *run() {
        iteration += 1;
        if (iteration === 2) {
          // "agent" creates the marker on its second attempt
          await writeFile(markerPath, "done", "utf8");
        }
        yield { kind: "text_delta", delta: `iteration ${iteration}` };
        yield doneEvent(100);
      },
    };

    const events: LoopEvent[] = [];
    const result = await runUntilPass({
      runtime,
      verifier: gate,
      initialPrompt: "create the marker file",
      workingDir: workDir,
      maxIterations: 5,
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe("converged");
    expect(result.iterations).toBe(2);
    expect(iteration).toBe(2);

    // Exactly one terminal event
    const terminals = events.filter((e) => e.kind === "loop.terminal");
    expect(terminals.length).toBe(1);

    // Iteration records carry typed verifier results
    const [rec1, rec2] = result.iterationRecords;
    if (rec1 === undefined || rec2 === undefined) throw new Error("records missing");
    expect(rec1.verifierResult.ok).toBe(false);
    expect(rec2.verifierResult.ok).toBe(true);
    if (rec1.verifierResult.ok) throw new Error("unreachable");
    expect(rec1.verifierResult.reason).toBe("exit_nonzero");
    expect(rec1.verifierResult.exitCode).toBe(1);

    // Cleanup for next test
    await unlink(markerPath).catch(() => {});
  });

  test("composite gate: typecheck-shaped + test-shaped, both pass", async () => {
    const file1 = join(workDir, "step1.marker");
    const file2 = join(workDir, "step2.marker");
    await writeFile(file1, "ok", "utf8");
    await writeFile(file2, "ok", "utf8");

    const gate = createCompositeGate([
      createArgvGate(
        [
          "bun",
          "-e",
          `process.exit(require('node:fs').existsSync(${JSON.stringify(file1)}) ? 0 : 1)`,
        ],
        { timeoutMs: 5000 },
      ),
      createArgvGate(
        [
          "bun",
          "-e",
          `process.exit(require('node:fs').existsSync(${JSON.stringify(file2)}) ? 0 : 1)`,
        ],
        { timeoutMs: 5000 },
      ),
    ]);

    const runtime: LoopRuntime = {
      async *run() {
        yield doneEvent(50);
      },
    };

    const result = await runUntilPass({
      runtime,
      verifier: gate,
      initialPrompt: "noop",
      workingDir: workDir,
      maxIterations: 3,
    });

    expect(result.status).toBe("converged");
    expect(result.iterations).toBe(1);

    await unlink(file1).catch(() => {});
    await unlink(file2).catch(() => {});
  });

  test("composite gate: first fails → second is never spawned", async () => {
    const gate = createCompositeGate([
      createArgvGate(["bun", "-e", "process.exit(1)"], { timeoutMs: 5000 }),
      createArgvGate(["bun", "-e", "throw new Error('should not run')"], { timeoutMs: 5000 }),
    ]);

    const runtime: LoopRuntime = {
      async *run() {
        yield doneEvent(0);
      },
    };

    const result = await runUntilPass({
      runtime,
      verifier: gate,
      initialPrompt: "noop",
      workingDir: workDir,
      maxIterations: 2,
      maxConsecutiveFailures: 100,
    });

    expect(result.status).toBe("exhausted");
    const [rec1, rec2] = result.iterationRecords;
    if (rec1?.verifierResult.ok !== false || rec2?.verifierResult.ok !== false) {
      throw new Error("expected both iterations to fail");
    }
    // First gate failed with exit_nonzero — second gate's "should not run"
    // is never thrown.
    expect(rec1.verifierResult.reason).toBe("exit_nonzero");
    expect(rec2.verifierResult.reason).toBe("exit_nonzero");
  });
});
