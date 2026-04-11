import { describe, expect, test } from "bun:test";
import type { Verifier, VerifierContext, VerifierResult } from "../types.js";
import { createCompositeGate } from "./composite-gate.js";

const ctx: VerifierContext = {
  iteration: 1,
  workingDir: "/tmp",
  signal: new AbortController().signal,
};

function stub(result: VerifierResult): Verifier {
  return { check: async () => result };
}

describe("createCompositeGate", () => {
  test("rejects empty gate list", () => {
    expect(() => createCompositeGate([])).toThrow(/at least one/);
  });

  test("passes when all gates pass", async () => {
    const gate = createCompositeGate([stub({ ok: true }), stub({ ok: true })]);
    const result = await gate.check(ctx);
    expect(result.ok).toBe(true);
  });

  test("concatenates details from passing gates", async () => {
    const gate = createCompositeGate([
      stub({ ok: true, details: "step1 ok" }),
      stub({ ok: true, details: "step2 ok" }),
    ]);
    const result = await gate.check(ctx);
    if (!result.ok) throw new Error("unreachable");
    expect(result.details).toBe("step1 ok; step2 ok");
  });

  test("short-circuits on first failure", async () => {
    let secondCalled = false;
    const gate = createCompositeGate([
      stub({ ok: false, reason: "exit_nonzero", details: "first failed", exitCode: 1 }),
      {
        check: async () => {
          secondCalled = true;
          return { ok: true };
        },
      },
    ]);
    const result = await gate.check(ctx);
    expect(secondCalled).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("exit_nonzero");
    expect(result.exitCode).toBe(1);
    expect(result.details).toBe("first failed");
  });

  test("returns aborted if signal fires between gates", async () => {
    const ctrl = new AbortController();
    const gate = createCompositeGate([
      {
        check: async () => {
          ctrl.abort();
          return { ok: true };
        },
      },
      stub({ ok: true }),
    ]);
    const result = await gate.check({ ...ctx, signal: ctrl.signal });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("aborted");
  });
});
