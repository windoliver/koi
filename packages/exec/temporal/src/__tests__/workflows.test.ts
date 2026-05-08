import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAgentActivities } from "../activities/agent-activity.js";
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

    await expect(
      scheduledTaskWorkflow({
        mode: "spawn",
        agentId: config.agentId,
        stateRefs: config.stateRefs,
        input: { kind: "text", text: "hello" },
      }),
    ).resolves.toMatchObject({ kind: "spawned" });
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

  test("scheduled task workflow spawn default routes scheduled input through agent workflow", async () => {
    const seenConfigs: unknown[] = [];
    const realAgentActivities = createDefaultAgentActivities();
    setAgentWorkflowDepsForTest({
      runAgentTurn: async (input) => {
        seenConfigs.push(input);
        return realAgentActivities.runAgentTurn(input);
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
        workflowId: expect.stringMatching(/^scheduled:agent-1:/),
      });

      expect(seenConfigs).toHaveLength(2);
      expect(seenConfigs[0]).toMatchObject({
        initialMessages: [
          {
            senderId: "u1",
            content: [{ kind: "text", text: "tick" }],
          },
          {
            senderId: "u2",
            content: [{ kind: "text", text: "tock" }],
          },
        ],
        stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
      });
    } finally {
      resetAgentWorkflowDepsForTest();
    }
  });

  test("scheduled task workflow dispatch default routes scheduled input through agent workflow", async () => {
    const seenConfigs: unknown[] = [];
    const realAgentActivities = createDefaultAgentActivities();
    setAgentWorkflowDepsForTest({
      runAgentTurn: async (input) => {
        seenConfigs.push(input);
        return realAgentActivities.runAgentTurn(input);
      },
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

      expect(seenConfigs).toHaveLength(1);
      expect(seenConfigs[0]).toMatchObject({
        sessionId: "agent-1",
        stateRefs: { lastTurnId: "previous-turn", turnsProcessed: 1 },
        initialMessages: [
          {
            senderId: "scheduler",
            content: [{ kind: "text", text: "scheduled ping" }],
          },
        ],
      });
    } finally {
      resetAgentWorkflowDepsForTest();
    }
  });
});
