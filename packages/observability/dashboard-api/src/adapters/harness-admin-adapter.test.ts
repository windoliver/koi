import { describe, expect, test } from "bun:test";
import type { HarnessAdminClientLike } from "./harness-admin-adapter.js";
import { createHarnessAdminAdapter } from "./harness-admin-adapter.js";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function createMockClient(overrides?: Partial<HarnessAdminClientLike>): HarnessAdminClientLike {
  return {
    status: () => ({
      harnessId: "harness:test",
      phase: "active" as const,
      currentSessionSeq: 3,
      metrics: {
        totalSessions: 3,
        totalTurns: 42,
        totalInputTokens: 10_000,
        totalOutputTokens: 5_000,
        completedTaskCount: 7,
        pendingTaskCount: 3,
        elapsedMs: 60_000,
      },
      startedAt: 1000,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHarnessAdminAdapter", () => {
  test("getStatus maps core harness status to dashboard format", async () => {
    const adapter = createHarnessAdminAdapter(createMockClient());
    const status = await adapter.views.getStatus();

    expect(status.phase).toBe("running"); // active → running
    expect(status.sessionCount).toBe(3);
    expect(status.taskProgress.completed).toBe(7);
    expect(status.taskProgress.total).toBe(10); // 7 + 3
    expect(status.tokenUsage.used).toBe(15_000); // 10k + 5k
    expect(status.startedAt).toBe(1000);
  });

  test("maps idle phase correctly", async () => {
    const adapter = createHarnessAdminAdapter(
      createMockClient({
        status: () => ({
          harnessId: "harness:test",
          phase: "idle" as const,
          currentSessionSeq: 0,
          metrics: {
            totalSessions: 0,
            totalTurns: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            completedTaskCount: 0,
            pendingTaskCount: 0,
            elapsedMs: 0,
          },
        }),
      }),
    );
    const status = await adapter.views.getStatus();
    expect(status.phase).toBe("idle");
  });

  test("maps suspended phase to paused", async () => {
    const adapter = createHarnessAdminAdapter(
      createMockClient({
        status: () => ({
          harnessId: "harness:test",
          phase: "suspended" as const,
          currentSessionSeq: 1,
          metrics: {
            totalSessions: 1,
            totalTurns: 5,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            completedTaskCount: 0,
            pendingTaskCount: 0,
            elapsedMs: 0,
          },
        }),
      }),
    );
    const status = await adapter.views.getStatus();
    expect(status.phase).toBe("paused");
  });

  test("maps completed and failed phases", async () => {
    const mkClient = (phase: "completed" | "failed"): HarnessAdminClientLike =>
      createMockClient({
        status: () => ({
          harnessId: "harness:test",
          phase,
          currentSessionSeq: 1,
          metrics: {
            totalSessions: 1,
            totalTurns: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            completedTaskCount: 0,
            pendingTaskCount: 0,
            elapsedMs: 0,
          },
        }),
      });
    const completedStatus = await createHarnessAdminAdapter(
      mkClient("completed"),
    ).views.getStatus();
    expect(completedStatus.phase).toBe("completed");
    const failedStatus = await createHarnessAdminAdapter(mkClient("failed")).views.getStatus();
    expect(failedStatus.phase).toBe("failed");
  });

  test("getCheckpoints returns empty when client lacks listCheckpoints", async () => {
    const adapter = createHarnessAdminAdapter(createMockClient());
    const checkpoints = await adapter.views.getCheckpoints();
    expect(checkpoints).toHaveLength(0);
  });

  test("getCheckpoints maps snapshots when available", async () => {
    const client = {
      ...createMockClient(),
      listCheckpoints: () => [
        { harnessId: "harness:test", phase: "active", sessionSeq: 1, checkpointedAt: 5000 },
        { harnessId: "harness:test", phase: "active", sessionSeq: 2, checkpointedAt: 10000 },
      ],
    };
    const adapter = createHarnessAdminAdapter(client);
    const checkpoints = await adapter.views.getCheckpoints();

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.id).toBe("harness:test:1");
    expect(checkpoints[0]?.type).toBe("hard");
    expect(checkpoints[0]?.createdAt).toBe(5000);
    expect(checkpoints[1]?.sessionId).toBe("2");
  });

  test("pauseHarness delegates to client.pause", async () => {
    // let justified: tracks whether pause was called
    let pauseCalled = false;
    const adapter = createHarnessAdminAdapter(
      createMockClient({
        pause: () => {
          pauseCalled = true;
        },
      }),
    );
    const result = await adapter.commands.pauseHarness();
    expect(result.ok).toBe(true);
    expect(pauseCalled).toBe(true);
  });

  test("pauseHarness returns error when not supported", async () => {
    const adapter = createHarnessAdminAdapter(createMockClient());
    const result = await adapter.commands.pauseHarness();
    expect(result.ok).toBe(false);
  });

  test("resumeHarness delegates to client.resume", async () => {
    // let justified: tracks whether resume was called
    let resumeCalled = false;
    const adapter = createHarnessAdminAdapter(
      createMockClient({
        resume: () => {
          resumeCalled = true;
        },
      }),
    );
    const result = await adapter.commands.resumeHarness();
    expect(result.ok).toBe(true);
    expect(resumeCalled).toBe(true);
  });

  test("resumeHarness returns error when not supported", async () => {
    const adapter = createHarnessAdminAdapter(createMockClient());
    const result = await adapter.commands.resumeHarness();
    expect(result.ok).toBe(false);
  });
});
