import { describe, expect, mock, test } from "bun:test";
import { runPhases } from "./phase-runner.js";
import type { PhaseCallbacks, PhaseDefinition } from "./types.js";

function createCallbacks(): PhaseCallbacks & {
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  return {
    get calls() {
      return calls;
    },
    onPhaseStart: (id, label) => {
      calls.push(`start:${id}:${label}`);
    },
    onPhaseProgress: (id, msg) => {
      calls.push(`progress:${id}:${msg}`);
    },
    onPhaseDone: (id) => {
      calls.push(`done:${id}`);
    },
    onPhaseFailed: (id, err) => {
      calls.push(`failed:${id}:${err}`);
    },
  };
}

describe("runPhases", () => {
  test("all phases pass", async () => {
    const phases: readonly PhaseDefinition<null>[] = [
      { id: "a", label: "Phase A", execute: async () => {} },
      { id: "b", label: "Phase B", execute: async () => {} },
    ];
    const cb = createCallbacks();
    const result = await runPhases(phases, null, cb);

    expect(result.ok).toBe(true);
    expect(cb.calls).toEqual(["start:a:Phase A", "done:a", "start:b:Phase B", "done:b"]);
  });

  test("stops on first failure", async () => {
    const phases: readonly PhaseDefinition<null>[] = [
      { id: "a", label: "Phase A", execute: async () => {} },
      {
        id: "b",
        label: "Phase B",
        execute: async () => {
          throw new Error("boom");
        },
      },
      { id: "c", label: "Phase C", execute: async () => {} },
    ];
    const cb = createCallbacks();
    const result = await runPhases(phases, null, cb);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.phase).toBe("b");
      expect(result.error.message).toContain("boom");
    }
    // Phase C should not have started
    expect(cb.calls).toEqual(["start:a:Phase A", "done:a", "start:b:Phase B", "failed:b:boom"]);
  });

  test("calls onProgress during execution", async () => {
    const phases: readonly PhaseDefinition<null>[] = [
      {
        id: "a",
        label: "Phase A",
        execute: async (_ctx, onProgress) => {
          onProgress("step 1");
          onProgress("step 2");
        },
      },
    ];
    const cb = createCallbacks();
    await runPhases(phases, null, cb);

    expect(cb.calls).toEqual([
      "start:a:Phase A",
      "progress:a:step 1",
      "progress:a:step 2",
      "done:a",
    ]);
  });

  test("passes context to phases", async () => {
    const receivedCtx = mock(() => {});
    const phases: readonly PhaseDefinition<{ readonly value: number }>[] = [
      {
        id: "a",
        label: "Phase A",
        execute: async (ctx) => {
          receivedCtx();
          expect(ctx.value).toBe(42);
        },
      },
    ];
    const cb = createCallbacks();
    await runPhases(phases, { value: 42 }, cb);

    expect(receivedCtx).toHaveBeenCalled();
  });

  test("empty phases returns success", async () => {
    const cb = createCallbacks();
    const result = await runPhases([], null, cb);
    expect(result.ok).toBe(true);
    expect(cb.calls).toEqual([]);
  });
});
