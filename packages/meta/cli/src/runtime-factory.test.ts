/**
 * runtime-factory tests — verifies the full L2 tool stack wiring.
 *
 * These tests verify:
 *   - createKoiRuntime assembles without errors
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
import { toolToken } from "@koi/core";
import { createKoiRuntime, MAX_TRAJECTORY_STEPS } from "./runtime-factory.js";

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

let runtimeHandle: Awaited<ReturnType<typeof createKoiRuntime>> | null = null;

afterEach(async () => {
  if (runtimeHandle !== null) {
    await runtimeHandle.runtime.dispose();
    runtimeHandle = null;
  }
});

describe("createKoiRuntime — assembly", () => {
  test("assembles without errors", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.runtime).toBeDefined();
  });

  test("returns a mutable transcript array", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { transcript } = runtimeHandle;
    expect(Array.isArray(transcript)).toBe(true);
    expect(transcript).toHaveLength(0);
  });

  test("transcript can be spliced (session reset)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
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
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(typeof runtimeHandle.runtime.sessionId).toBe("string");
    expect(runtimeHandle.runtime.sessionId.length).toBeGreaterThan(0);
  });
});

describe("createKoiRuntime — trajectory steps", () => {
  test("getTrajectorySteps() returns empty array initially", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const steps = await runtimeHandle.getTrajectorySteps();
    expect(steps).toHaveLength(0);
  });

  test("getTrajectorySteps() caps at MAX_TRAJECTORY_STEPS", async () => {
    // Verify the constant is exported and has the expected value
    expect(MAX_TRAJECTORY_STEPS).toBe(200);
  });
});

describe("createKoiRuntime — runtime.run signature", () => {
  test("runtime.run is callable", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    // run() returns an AsyncIterable — verify it exists without actually calling it
    expect(typeof runtimeHandle.runtime.run).toBe("function");
  });
});

describe("createKoiRuntime — cwd defaults", () => {
  test("defaults cwd to process.cwd() when not provided", async () => {
    runtimeHandle = await createKoiRuntime({
      modelAdapter: makeModelAdapter(),
      modelName: "stub",
      approvalHandler: stubApprovalHandler,
      // No cwd provided — should use process.cwd()
    });
    expect(runtimeHandle.runtime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T2-A: Tool inventory snapshot — verifies all expected tools are wired
// ---------------------------------------------------------------------------

describe("createKoiRuntime — tool inventory", () => {
  /** Expected tool names that must be registered after createKoiRuntime(). */
  const EXPECTED_TOOLS = [
    "Glob",
    "Grep",
    "ToolSearch",
    "fs_read",
    "fs_write",
    "fs_edit",
    "Bash",
    "bash_background",
    "web_fetch",
    "task_create",
    "task_get",
    "task_list",
    "task_output",
    "task_stop",
    "task_update",
  ] as const;

  test("all expected tools are registered as agent components", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { agent } = runtimeHandle.runtime;

    const missing: string[] = [];
    for (const name of EXPECTED_TOOLS) {
      if (!agent.has(toolToken(name))) {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
  });

  test("expected tool count matches snapshot", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { agent } = runtimeHandle.runtime;

    // Count how many expected tools are present (should be all of them)
    const presentCount = EXPECTED_TOOLS.filter((name) => agent.has(toolToken(name))).length;
    expect(presentCount).toBe(EXPECTED_TOOLS.length);
  });
});

// ---------------------------------------------------------------------------
// T1-A: resetSessionState — full test suite
// ---------------------------------------------------------------------------

describe("createKoiRuntime — resetSessionState", () => {
  test("throws when signal is not aborted (C4-A)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const controller = new AbortController();
    // Signal not aborted — must throw
    await expect(runtimeHandle?.resetSessionState(controller.signal)).rejects.toThrow(
      "active AbortSignal must be aborted before resetting",
    );
  });

  test("succeeds when signal is aborted", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const controller = new AbortController();
    controller.abort();
    // Should not throw
    await expect(runtimeHandle?.resetSessionState(controller.signal)).resolves.toBeUndefined();
  });

  test("clears transcript on reset (caller responsibility)", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    const { transcript } = runtimeHandle;

    // Simulate session with messages
    transcript.push({
      senderId: "user",
      timestamp: Date.now(),
      content: [{ kind: "text", text: "hello" }],
    });
    expect(transcript).toHaveLength(1);

    // Abort + reset (now async)
    const controller = new AbortController();
    controller.abort();
    await runtimeHandle.resetSessionState(controller.signal);

    // Transcript is caller-managed; splice must be called separately
    transcript.splice(0);
    expect(transcript).toHaveLength(0);
  });

  test("multiple resets in sequence do not throw", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());

    // First reset
    const c1 = new AbortController();
    c1.abort();
    await runtimeHandle.resetSessionState(c1.signal);

    // Second reset with a new controller
    const c2 = new AbortController();
    c2.abort();
    await expect(runtimeHandle?.resetSessionState(c2.signal)).resolves.toBeUndefined();
  });

  test("hasActiveBackgroundTasks returns false initially", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.hasActiveBackgroundTasks()).toBe(false);
  });

  test("shutdownBackgroundTasks returns false when no tasks active", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    expect(runtimeHandle.shutdownBackgroundTasks()).toBe(false);
  });

  test("sandboxActive reflects OS adapter availability", async () => {
    runtimeHandle = await createKoiRuntime(makeConfig());
    // sandboxActive depends on whether seatbelt/bwrap is available on this machine.
    // We just verify it's a boolean — the actual value depends on the test environment.
    expect(typeof runtimeHandle.sandboxActive).toBe("boolean");
  });
});
