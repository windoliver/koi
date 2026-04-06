import { describe, expect, test } from "bun:test";
import type { JsonObject, RichTrajectoryStep } from "@koi/core";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif-mapper.js";

// ---------------------------------------------------------------------------
// __rich_error ATIF round-trip (#1501)
// ---------------------------------------------------------------------------

describe("atif-mapper __rich_error round-trip (#1501)", () => {
  function makeStep(overrides: Partial<RichTrajectoryStep> = {}): RichTrajectoryStep {
    return {
      stepIndex: 0,
      timestamp: Date.now(),
      source: "system",
      kind: "model_call",
      identifier: "hook:test",
      outcome: "failure",
      durationMs: 1,
      ...overrides,
    };
  }

  test("error with text round-trips through ATIF", () => {
    const step = makeStep({
      error: { text: "auth token expired" },
      metadata: { type: "hook_execution", hookName: "auth-check" } as JsonObject,
    });

    const atif = mapRichTrajectoryToAtif([step], {
      sessionId: "test-session",
      agentName: "test-agent",
    });
    const restored = mapAtifToRichTrajectory(atif);

    expect(restored[0]?.error?.text).toBe("auth token expired");
    expect(restored[0]?.metadata).toEqual({ type: "hook_execution", hookName: "auth-check" });
  });

  test("truncated error with originalSize round-trips", () => {
    const step = makeStep({
      error: { text: "x".repeat(512), truncated: true, originalSize: 2000 },
    });

    const atif = mapRichTrajectoryToAtif([step], {
      sessionId: "test-session",
      agentName: "test-agent",
    });
    const restored = mapAtifToRichTrajectory(atif);

    expect(restored[0]?.error?.text).toBe("x".repeat(512));
    expect(restored[0]?.error?.truncated).toBe(true);
    expect(restored[0]?.error?.originalSize).toBe(2000);
  });

  test("error with data field round-trips", () => {
    const step = makeStep({
      error: { text: "structured error", data: { code: "EPIPE", errno: -32 } as JsonObject },
    });

    const atif = mapRichTrajectoryToAtif([step], {
      sessionId: "test-session",
      agentName: "test-agent",
    });
    const restored = mapAtifToRichTrajectory(atif);

    expect(restored[0]?.error?.text).toBe("structured error");
    expect(restored[0]?.error?.data).toEqual({ code: "EPIPE", errno: -32 });
  });

  test("user metadata with error key is not confused with __rich_error", () => {
    const step = makeStep({
      outcome: "success",
      metadata: { error: { code: "EPIPE" }, type: "hook_execution" } as JsonObject,
    });

    const atif = mapRichTrajectoryToAtif([step], {
      sessionId: "test-session",
      agentName: "test-agent",
    });
    const restored = mapAtifToRichTrajectory(atif);

    // No step.error should be extracted — the metadata.error is user data, not __rich_error
    expect(restored[0]?.error).toBeUndefined();
    expect((restored[0]?.metadata as JsonObject)?.error).toEqual({ code: "EPIPE" });
  });

  test("step without error preserves metadata unchanged", () => {
    const step = makeStep({
      outcome: "success",
      metadata: { type: "hook_execution", hookName: "observer" } as JsonObject,
    });

    const atif = mapRichTrajectoryToAtif([step], {
      sessionId: "test-session",
      agentName: "test-agent",
    });
    const restored = mapAtifToRichTrajectory(atif);

    expect(restored[0]?.error).toBeUndefined();
    expect(restored[0]?.metadata).toEqual({ type: "hook_execution", hookName: "observer" });
  });
});
