import { describe, expect, test } from "bun:test";
import type {
  AgentResolver,
  CapabilityFragment,
  KoiError,
  KoiMiddleware,
  Result,
  SessionContext,
  StopGateResult,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness, SessionLease } from "@koi/long-running";
import { createAutonomousAgent } from "./autonomous.js";

describe("@koi/autonomous", () => {
  test("exposes a composed autonomous handle with stable middleware ordering", () => {
    const harnessMiddleware = middleware("harness");
    const extraOne = middleware("extra-1");
    const extraTwo = middleware("extra-2");
    const harness = createHarnessStub({
      createMiddleware: () => harnessMiddleware,
    });
    const scheduler = createSchedulerStub();
    const resolver = {} as AgentResolver;

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      agentResolver: resolver,
      extraMiddleware: [extraOne, extraTwo],
    });

    expect(typeof createAutonomousAgent).toBe("function");
    expect(agent.harness).toBe(harness);
    expect(agent.scheduler).toBe(scheduler);
    expect(agent.agentResolver).toBe(resolver);
    expect(agent.middleware()).toBe(agent.middleware());
    expect(agent.middleware()).toEqual([harnessMiddleware, extraOne, extraTwo]);
  });

  test("disposes scheduler before harness", async () => {
    const calls: string[] = [];
    const harness = createHarnessStub({
      dispose: async () => {
        calls.push("harness.dispose");
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        calls.push("scheduler.dispose");
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });
    await agent.dispose();

    expect(calls).toEqual(["scheduler.dispose", "harness.dispose"]);
  });

  test("still disposes harness when scheduler disposal throws", async () => {
    const calls: string[] = [];
    const schedulerError = new Error("scheduler dispose failed");
    const harness = createHarnessStub({
      dispose: async () => {
        calls.push("harness.dispose");
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        calls.push("scheduler.dispose");
        throw schedulerError;
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    await expect(agent.dispose()).rejects.toBe(schedulerError);
    expect(calls).toEqual(["scheduler.dispose", "harness.dispose"]);
  });

  test("throws when harness disposal returns an error result", async () => {
    const harnessError = {
      code: "INTERNAL",
      message: "harness dispose failed",
      retryable: false,
    } as KoiError;
    const harness = createHarnessStub({
      dispose: async () => ({
        ok: false,
        error: harnessError,
      }),
    });
    const scheduler = createSchedulerStub();

    const agent = createAutonomousAgent({ harness, scheduler });

    await expect(agent.dispose()).rejects.toBe(harnessError);
  });

  test("aggregates scheduler and harness cleanup failures", async () => {
    const schedulerError = new Error("scheduler dispose failed");
    const harnessError = {
      code: "INTERNAL",
      message: "harness dispose failed",
      retryable: false,
    } as KoiError;
    const harness = createHarnessStub({
      dispose: async () => ({
        ok: false,
        error: harnessError,
      }),
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        throw schedulerError;
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    await expect(agent.dispose()).rejects.toEqual(
      new AggregateError(
        [schedulerError, harnessError],
        "autonomous dispose failed during scheduler and harness cleanup",
      ),
    );
  });
});

function middleware(name: string): KoiMiddleware {
  return {
    name,
    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },
  };
}

function ok(): Result<void, KoiError> {
  return {
    ok: true,
    value: undefined,
  };
}

function createSchedulerStub(
  overrides: Partial<HarnessScheduler> = {},
): HarnessScheduler {
  return {
    start() {},
    stop() {},
    status: () => ({
      phase: "idle",
      retriesRemaining: 0,
      totalResumes: 0,
    }),
    dispose: async () => {},
    ...overrides,
  };
}

function createHarnessStub(
  overrides: Partial<LongRunningHarness> = {},
): LongRunningHarness {
  const notImplemented = async () => {
    throw new Error("not implemented");
  };

  return {
    start: notImplemented as LongRunningHarness["start"],
    resume: notImplemented as LongRunningHarness["resume"],
    pause: notImplemented as LongRunningHarness["pause"],
    fail: notImplemented as LongRunningHarness["fail"],
    complete: notImplemented as LongRunningHarness["complete"],
    completeTask: notImplemented as LongRunningHarness["completeTask"],
    failTask: notImplemented as LongRunningHarness["failTask"],
    dispose: async (_lease?: SessionLease) => ok(),
    status: notImplemented as LongRunningHarness["status"],
    createMiddleware: () => middleware("harness"),
    ...overrides,
  };
}
