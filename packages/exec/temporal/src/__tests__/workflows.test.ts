import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetAgentWorkflowDepsForTest,
  setAgentWorkflowDepsForTest,
} from "../workflows/agent-workflow.js";
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
      "--skipLibCheck",
      "true",
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
      "--skipLibCheck",
      "true",
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

    await expect(
      scheduledTaskWorkflow({
        mode: "dispatch",
        agentId: config.agentId,
        stateRefs: config.stateRefs,
        input: { kind: "text", text: "hello" },
      }),
    ).resolves.toEqual({ kind: "dispatched" });

    setScheduledTaskWorkflowDepsForTest({
      startAgentExecution: async () => "wf-entrypoint",
    });

    try {
      await expect(
        scheduledTaskWorkflow({
          mode: "spawn",
          agentId: config.agentId,
          stateRefs: config.stateRefs,
          input: { kind: "text", text: "hello" },
        }),
      ).resolves.toEqual({ kind: "spawned", workflowId: "wf-entrypoint" });
    } finally {
      resetScheduledTaskWorkflowDepsForTest();
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

  test("retry workflow default path runs the real agent turn operation", async () => {
    await expect(
      retryWorkflow({
        operation: "runAgentTurn",
        attempt: 0,
        maxAttempts: 3,
        backoffMs: 0,
        payload: {
          agentId: "agent-1",
          sessionId: "session-1",
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          initialMessages: [
            { id: "m1", senderId: "u1", content: [{ kind: "text", text: "tick" }], timestamp: 1 },
            { id: "m2", senderId: "u1", content: [{ kind: "text", text: "tock" }], timestamp: 2 },
          ],
        },
      }),
    ).resolves.toEqual({
      kind: "succeeded",
      attempts: 1,
      value: {
        turnId: "m1",
        updatedStateRefs: { lastTurnId: "m1", turnsProcessed: 1 },
        next: { kind: "retry" },
      },
    });
  });

  test("agent workflow permits bounded same-state retries when maxStopRetries is available", async () => {
    let attempts = 0;
    setAgentWorkflowDepsForTest({
      runAgentTurn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            turnId: "turn-0",
            updatedStateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
            next: { kind: "retry" },
          } as const;
        }

        return {
          turnId: "turn-1",
          updatedStateRefs: { lastTurnId: "turn-1", turnsProcessed: 1 },
          next: { kind: "complete" },
        } as const;
      },
    });

    try {
      await expect(
        agentWorkflow({
          agentId: "agent-1" as never,
          sessionId: "session-1" as never,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          initialMessages: [
            { id: "m1", senderId: "u1", content: [{ kind: "text", text: "tick" }], timestamp: 1 },
          ],
          maxStopRetries: 2,
        }),
      ).resolves.toBeUndefined();

      expect(attempts).toBe(2);
    } finally {
      resetAgentWorkflowDepsForTest();
    }
  });

  test("scheduled task workflow spawn default routes scheduled input through agent workflow", async () => {
    const seenInputs: unknown[] = [];
    setScheduledTaskWorkflowDepsForTest({
      startAgentExecution: async (input) => {
        seenInputs.push(input);
        return "scheduled:agent-1:spawned";
      },
    });

    try {
      await expect(
        scheduledTaskWorkflow({
          mode: "spawn",
          agentId: "agent-1" as never,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          input: {
            kind: "messages",
            messages: [
              { senderId: "u1", content: [{ kind: "text", text: "tick" }], timestamp: 1 },
              { senderId: "u2", content: [{ kind: "text", text: "tock" }], timestamp: 2 },
            ],
          },
        }),
      ).resolves.toMatchObject({
        kind: "spawned",
        workflowId: "scheduled:agent-1:spawned",
      });

      expect(seenInputs).toEqual([
        {
          mode: "spawn",
          agentId: "agent-1",
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          input: {
            kind: "messages",
            messages: [
              { senderId: "u1", content: [{ kind: "text", text: "tick" }], timestamp: 1 },
              { senderId: "u2", content: [{ kind: "text", text: "tock" }], timestamp: 2 },
            ],
          },
        },
      ]);
    } finally {
      resetScheduledTaskWorkflowDepsForTest();
    }
  });

  test("scheduled task workflow dispatch default routes scheduled input through agent workflow", async () => {
    const seenInputs: unknown[] = [];
    setScheduledTaskWorkflowDepsForTest({
      dispatchToAgent: async (input) => {
        seenInputs.push(input);
      },
      startAgentExecution: async () => "unused",
    });

    try {
      await expect(
        scheduledTaskWorkflow({
          mode: "dispatch",
          agentId: "agent-1" as never,
          stateRefs: { lastTurnId: "previous-turn", turnsProcessed: 1 },
          input: { kind: "text", text: "scheduled ping" },
        }),
      ).resolves.toEqual({ kind: "dispatched" });

      expect(seenInputs).toEqual([
        {
          mode: "dispatch",
          agentId: "agent-1",
          stateRefs: { lastTurnId: "previous-turn", turnsProcessed: 1 },
          input: { kind: "text", text: "scheduled ping" },
        },
      ]);
    } finally {
      resetScheduledTaskWorkflowDepsForTest();
    }
  });
});
