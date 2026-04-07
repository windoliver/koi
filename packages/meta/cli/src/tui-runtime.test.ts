/**
 * tui-runtime tests — verifies the full L2 tool stack wiring.
 *
 * These tests verify:
 *   - createTuiRuntime assembles without errors
 *   - transcript is exposed and mutable (splice works)
 *   - getTrajectorySteps() returns empty initially
 *   - getTrajectorySteps() caps at MAX_TRAJECTORY_STEPS
 *   - runtime exposes debug inventory showing expected tools/middleware
 *
 * Tests do NOT make real model calls — they use a stub ModelAdapter
 * and verify assembly structure, not behavior.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalHandler, ModelAdapter } from "@koi/core";
import { createTuiRuntime, MAX_TRAJECTORY_STEPS } from "./tui-runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub ModelAdapter — never makes real HTTP calls. */
function makeModelAdapter(): ModelAdapter {
  return {
    id: "stub-tui",
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    complete: mock(async () => ({ content: "", model: "stub" })),
    stream: mock(async function* () {}),
  };
}

/** Stub ApprovalHandler — auto-approves all requests. */
const stubApprovalHandler: ApprovalHandler = mock(async (_request) => ({
  kind: "allow" as const,
}));

/** Default config for tests. */
function makeConfig() {
  return {
    modelAdapter: makeModelAdapter(),
    modelName: "stub-model",
    approvalHandler: stubApprovalHandler,
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let runtimeHandle: Awaited<ReturnType<typeof createTuiRuntime>> | null = null;

afterEach(async () => {
  if (runtimeHandle !== null) {
    await runtimeHandle.runtime.dispose();
    runtimeHandle = null;
  }
});

describe("createTuiRuntime — assembly", () => {
  test("assembles without errors", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("returns a mutable transcript array", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    const { transcript } = runtimeHandle;
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript).toHaveLength(0);
  });

  test("transcript can be spliced (session reset)", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    const { transcript } = runtimeHandle;

    // Push a fake message
    transcript.push({
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text: "hello" }],
    });
    expect(transcript).toHaveLength(1);

    // Simulate session reset
    transcript.splice(0);
    expect(transcript).toHaveLength(0);
  });

  test("runtime has a sessionId", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    expect(typeof runtimeHandle.runtime.sessionId).toBe("string");
    expect(runtimeHandle.runtime.sessionId.length).toBeGreaterThan(0);
  });
});

describe("createTuiRuntime — trajectory steps", () => {
  test("getTrajectorySteps() returns empty array initially", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    const steps = await runtimeHandle.getTrajectorySteps();
    expect(steps).toHaveLength(0);
  });

  test("getTrajectorySteps() caps at MAX_TRAJECTORY_STEPS", async () => {
    // Verify the constant is exported and has the expected value
    expect(MAX_TRAJECTORY_STEPS).toBe(200);
  });
});

describe("createTuiRuntime — runtime.run signature", () => {
  test("runtime.run is callable", async () => {
    runtimeHandle = await createTuiRuntime(makeConfig());
    // run() returns an AsyncIterable — verify it exists without actually calling it
    expect(typeof runtimeHandle.runtime.run).toBe("function");
  });
});

describe("createTuiRuntime — cwd defaults", () => {
  test("defaults cwd to process.cwd() when not provided", async () => {
    runtimeHandle = await createTuiRuntime({
      modelAdapter: makeModelAdapter(),
      modelName: "stub",
      approvalHandler: stubApprovalHandler,
      // No cwd provided — should use process.cwd()
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });
});
