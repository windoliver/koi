import { describe, expect, test } from "bun:test";
import type { BackendDescriptor, KoiError } from "@koi/core";
import { buildDecision } from "./decision.js";
import type { MatchRejection } from "./match.js";

function descriptor(name: string, state: BackendDescriptor["state"] = "ready"): BackendDescriptor {
  return {
    name,
    version: "0.0.0",
    state,
    capabilities: { supports: new Set(["exec"]), priority: 0 },
  };
}

const sampleError: KoiError = {
  code: "EXTERNAL",
  message: "boom",
  retryable: false,
};

describe("buildDecision", () => {
  test("happy path: single attempt, no rejections", () => {
    const decision = buildDecision({
      selected: descriptor("local"),
      attempts: [{ adapter: "local", state: "ready", ok: true }],
      rejected: [],
    });
    expect(decision.selected.name).toBe("local");
    expect(decision.attempts).toHaveLength(1);
    expect(decision.attempts[0]?.ok).toBe(true);
    expect(decision.rejected).toEqual([]);
  });

  test("includes failed attempts before the successful one (fallback chain)", () => {
    const decision = buildDecision({
      selected: descriptor("docker"),
      attempts: [
        { adapter: "local", state: "ready", ok: false, error: sampleError },
        { adapter: "docker", state: "ready", ok: true },
      ],
      rejected: [],
    });
    expect(decision.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(decision.attempts[0]?.error).toEqual(sampleError);
  });

  test("includes capability rejections that never reached create()", () => {
    const rejections: readonly MatchRejection[] = [
      { adapter: "local", reason: "missing-capabilities", missing: ["gpu"] },
    ];
    const decision = buildDecision({
      selected: descriptor("docker"),
      attempts: [{ adapter: "docker", state: "ready", ok: true }],
      rejected: rejections,
    });
    expect(decision.rejected).toHaveLength(1);
    expect(decision.rejected[0]?.reason).toBe("missing-capabilities");
  });

  test("decision is fully readonly — frozen objects don't accept mutation", () => {
    const decision = buildDecision({
      selected: descriptor("local"),
      attempts: [{ adapter: "local", state: "ready", ok: true }],
      rejected: [],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.attempts)).toBe(true);
    expect(Object.isFrozen(decision.rejected)).toBe(true);
  });
});
