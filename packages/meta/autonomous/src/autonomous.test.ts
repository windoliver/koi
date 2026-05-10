import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentResolver,
  CapabilityFragment,
  ComponentProvider,
  KoiError,
  KoiMiddleware,
  Result,
  SpawnRequest,
  SpawnResult,
  Tool,
  TurnContext,
} from "@koi/core";
import { harnessId, isAttachResult, toolToken } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness, SessionLease } from "@koi/long-running";
import { EMPTY_TASK_BOARD, ZERO_METRICS } from "@koi/long-running";
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
    expect(agent.providers()).toBe(agent.providers());
    expect(agent.providers()).toEqual([]);
  });

  test("builds a cached task provider that uses the wrapped spawn hook", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    let now = 10;
    const harness = createHarnessStub();
    const scheduler = createSchedulerStub();
    const resolver = createResolverStub();
    const spawn = async (request: SpawnRequest): Promise<SpawnResult> => {
      now = 17;
      return { ok: true, output: `done:${request.description}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      agentResolver: resolver,
      spawn,
      spawnFitness: {
        recordOutcome(outcome) {
          recorded.push({ ...outcome });
        },
        now: () => now,
      },
    });

    expect(agent.providers()).toBe(agent.providers());
    expect(agent.providers()).toHaveLength(1);
    const provider = agent.providers()[0] as ComponentProvider;
    const attached = await provider.attach({} as Agent);
    const components = isAttachResult(attached) ? attached.components : attached;
    const tool = components.get(toolToken("task") as string) as Tool;

    const result = await tool.execute({ description: "investigate", agent_type: "worker" });

    expect(result).toBe("done:investigate");
    expect(recorded).toEqual([
      {
        agentName: "Worker",
        description: "investigate",
        durationMs: 7,
        ok: true,
      },
    ]);
  });

  test("forwards an active SessionLease to harness.dispose", async () => {
    const received: Array<SessionLease | undefined> = [];
    const harness = createHarnessStub({
      dispose: async (lease) => {
        received.push(lease);
        return ok();
      },
    });
    const scheduler = createSchedulerStub();
    const lease = { sessionId: "session-7" } as unknown as SessionLease;

    const agent = createAutonomousAgent({ harness, scheduler });
    await agent.dispose(lease);

    expect(received).toEqual([lease]);
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

  test("concurrent dispose calls share a single teardown attempt", async () => {
    let schedulerCalls = 0;
    let harnessCalls = 0;
    let releaseScheduler!: () => void;
    const schedulerGate = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const harness = createHarnessStub({
      dispose: async () => {
        harnessCalls += 1;
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        schedulerCalls += 1;
        await schedulerGate;
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    const first = agent.dispose();
    const second = agent.dispose();
    releaseScheduler();
    await Promise.all([first, second]);

    expect(schedulerCalls).toBe(1);
    expect(harnessCalls).toBe(1);
  });

  test("retries failed scheduler disposal on a later dispose call", async () => {
    let schedulerCalls = 0;
    let harnessCalls = 0;
    const harness = createHarnessStub({
      dispose: async () => {
        harnessCalls += 1;
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        schedulerCalls += 1;
        if (schedulerCalls === 1) throw new Error("transient");
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    await expect(agent.dispose()).rejects.toThrow("transient");
    await agent.dispose();

    expect(schedulerCalls).toBe(2);
    expect(harnessCalls).toBe(1);
  });

  test("retries failed harness disposal on a later dispose call", async () => {
    let schedulerCalls = 0;
    let harnessCalls = 0;
    const harnessError = {
      code: "INTERNAL",
      message: "transient harness",
      retryable: true,
    } as KoiError;
    const harness = createHarnessStub({
      dispose: async () => {
        harnessCalls += 1;
        if (harnessCalls === 1) {
          return { ok: false, error: harnessError };
        }
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        schedulerCalls += 1;
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    await expect(agent.dispose()).rejects.toBe(harnessError);
    await agent.dispose();

    expect(schedulerCalls).toBe(1);
    expect(harnessCalls).toBe(2);
  });

  test("dispose is idempotent", async () => {
    let schedulerDisposals = 0;
    let harnessDisposals = 0;
    const harness = createHarnessStub({
      dispose: async () => {
        harnessDisposals += 1;
        return ok();
      },
    });
    const scheduler = createSchedulerStub({
      dispose: async () => {
        schedulerDisposals += 1;
      },
    });

    const agent = createAutonomousAgent({ harness, scheduler });

    await agent.dispose();
    await agent.dispose();

    expect(schedulerDisposals).toBe(1);
    expect(harnessDisposals).toBe(1);
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

function createSchedulerStub(overrides: Partial<HarnessScheduler> = {}): HarnessScheduler {
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

function createResolverStub(): AgentResolver {
  return {
    resolve: () => ({
      ok: true,
      value: {
        name: "Worker",
        description: "Task worker",
        manifest: { name: "worker", version: "1.0.0", model: { name: "m" } },
      },
    }),
    list: () => [{ key: "worker", name: "Worker", description: "Task worker" }],
  };
}

function createHarnessStub(overrides: Partial<LongRunningHarness> = {}): LongRunningHarness {
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
    status: () => ({
      harnessId: harnessId("harness-1"),
      phase: "idle",
      currentSessionSeq: 0,
      taskBoard: EMPTY_TASK_BOARD,
      metrics: ZERO_METRICS,
    }),
    createMiddleware: () => middleware("harness"),
    ...overrides,
  };
}
