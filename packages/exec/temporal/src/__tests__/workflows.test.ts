import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_MESSAGE_SIGNAL,
  AGENT_STATE_QUERY,
  AGENT_WORKFLOW_NAME,
  agentWorkflow,
  RETRY_WORKFLOW_NAME,
  retryWorkflow,
  SCHEDULED_TASK_WORKFLOW_NAME,
  scheduledTaskWorkflow,
} from "../workflows/index.js";
import {
  resetRetryWorkflowDepsForTest,
  setRetryWorkflowDepsForTest,
} from "../workflows/retry-workflow.js";
import {
  resetScheduledTaskWorkflowDepsForTest,
  setScheduledTaskWorkflowDepsForTest,
} from "../workflows/scheduled-task-workflow.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..", "..");
const FIXTURE = join(TEST_DIR, "fixtures", "workflows-boundary.ts");
const AMBIENT = join(TEST_DIR, "fixtures", "workflows-boundary.ambient.d.ts");
const ROOT_FIXTURE = join(TEST_DIR, "fixtures", "workflows-root-surface.ts");

function runTypecheckFixture() {
  return spawnSync(
    "bunx",
    [
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--pretty",
      "false",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2022,DOM,ESNext.Disposable",
      "--noImplicitAny",
      "false",
      "--noImplicitReturns",
      "false",
      "--strict",
      "false",
      "--strictNullChecks",
      "false",
      FIXTURE,
      AMBIENT,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    },
  );
}

function runRootSurfaceTypecheckFixture() {
  return spawnSync(
    "bunx",
    [
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--pretty",
      "false",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2022,DOM,ESNext.Disposable",
      "--noImplicitAny",
      "false",
      "--noImplicitReturns",
      "false",
      "--strict",
      "false",
      "--strictNullChecks",
      "false",
      ROOT_FIXTURE,
      AMBIENT,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    },
  );
}

describe("temporal workflow public surface", () => {
  test("exports Koi-owned workflow type names through the package boundary", () => {
    const result = runTypecheckFixture();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);

  test("exports workflow values through the package root", () => {
    const result = runRootSurfaceTypecheckFixture();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("workflow module surface", () => {
  test("exports stable workflow names and signal names", () => {
    expect(AGENT_MESSAGE_SIGNAL).toBe("agent.message");
    expect(AGENT_STATE_QUERY).toBe("agent.state");
    expect(AGENT_WORKFLOW_NAME).toBe("agentWorkflow");
    expect(SCHEDULED_TASK_WORKFLOW_NAME).toBe("scheduledTaskWorkflow");
    expect(RETRY_WORKFLOW_NAME).toBe("retryWorkflow");
  });

  test("executes workflow entry points", async () => {
    const config = {
      agentId: "agent-1" as never,
      sessionId: "session-1" as never,
      stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
    };

    await expect(agentWorkflow(config)).resolves.toBeUndefined();

    setScheduledTaskWorkflowDepsForTest({
      dispatchToAgent: async () => undefined,
      startAgentExecution: async () => "wf-1",
    });
    setRetryWorkflowDepsForTest({
      sleep: async () => undefined,
      runRetriedOperation: async () => ({ kind: "failed", error: "unimplemented" }),
    });

    try {
      await expect(
        scheduledTaskWorkflow({
          mode: "dispatch",
          agentId: config.agentId,
          stateRefs: config.stateRefs,
          input: { kind: "text", text: "hello" },
        }),
      ).resolves.toEqual({ kind: "dispatched" });

      await expect(
        scheduledTaskWorkflow({
          mode: "spawn",
          agentId: config.agentId,
          stateRefs: config.stateRefs,
          input: { kind: "text", text: "hello" },
        }),
      ).resolves.toMatchObject({ kind: "spawned" });

      await expect(
        retryWorkflow({
          operation: "runAgentTurn",
          attempt: 0,
          maxAttempts: 3,
          backoffMs: 250,
          payload: { agentId: config.agentId },
        }),
      ).resolves.toMatchObject({ kind: "failed", attempts: 3 });
    } finally {
      resetScheduledTaskWorkflowDepsForTest();
      resetRetryWorkflowDepsForTest();
    }
  });

  test("retry workflow retries until success within max attempts", async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;

    setRetryWorkflowDepsForTest({
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      runRetriedOperation: async () => {
        attempts += 1;
        if (attempts < 3) {
          return { kind: "failed", error: "transient" } as const;
        }
        return { kind: "succeeded", value: { ok: true } } as const;
      },
    });

    try {
      await expect(
        retryWorkflow({
          operation: "runAgentTurn",
          attempt: 0,
          maxAttempts: 3,
          backoffMs: 250,
          payload: { agentId: "agent-1" as never },
        }),
      ).resolves.toEqual({ kind: "succeeded", attempts: 3, value: { ok: true } });

      expect(sleepCalls).toEqual([250, 250]);
    } finally {
      resetRetryWorkflowDepsForTest();
    }
  });

  test("scheduled task workflow returns spawned result for spawn mode", async () => {
    setScheduledTaskWorkflowDepsForTest({
      startAgentExecution: async () => "wf-spawned-1",
    });

    try {
      await expect(
        scheduledTaskWorkflow({
          mode: "spawn",
          agentId: "agent-1" as never,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          input: { kind: "text", text: "tick" },
        }),
      ).resolves.toEqual({ kind: "spawned", workflowId: "wf-spawned-1" });
    } finally {
      resetScheduledTaskWorkflowDepsForTest();
    }
  });
});
