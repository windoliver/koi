import { describe, expect, test } from "bun:test";
import type { Agent, SchedulerComponent, SubsystemToken } from "@koi/core";
import { COMPONENT_PRIORITY, SCHEDULER, toolToken } from "@koi/core";
import { createProactiveToolsProvider } from "./provider.js";
import { createSchedulerStub } from "./test-helpers.js";

function makeAgent(scheduler: SchedulerComponent | undefined): Agent {
  const map = new Map<string, unknown>();
  if (scheduler !== undefined) map.set(SCHEDULER as string, scheduler);
  return {
    pid: "pid" as unknown as Agent["pid"],
    // Manifest/state are only consumed by code paths the provider does not exercise;
    // a minimal `unknown`-cast stub avoids importing the full assembly type tree.
    manifest: {} as unknown as Agent["manifest"],
    state: "running",
    component<T>(t: SubsystemToken<T>): T | undefined {
      return map.get(t as string) as T | undefined;
    },
    has(t: SubsystemToken<unknown>): boolean {
      return map.has(t as string);
    },
    hasAll(...tokens: readonly SubsystemToken<unknown>[]): boolean {
      return tokens.every((t) => map.has(t as string));
    },
    query<T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> {
      const out = new Map<SubsystemToken<T>, T>();
      for (const [k, v] of map) {
        if (k.startsWith(prefix)) out.set(k as SubsystemToken<T>, v as T);
      }
      return out;
    },
    components(): ReadonlyMap<string, unknown> {
      return map;
    },
  };
}

describe("createProactiveToolsProvider", () => {
  test("returns a ComponentProvider named 'proactive' at BUNDLED priority by default", () => {
    const provider = createProactiveToolsProvider();
    expect(provider.name).toBe("proactive");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("respects caller-supplied priority override", () => {
    const provider = createProactiveToolsProvider({ priority: 999 });
    expect(provider.priority).toBe(999);
  });

  test("attach resolves SCHEDULER from the agent and registers four tools", async () => {
    const stub = createSchedulerStub();
    const agent = makeAgent(stub.component);
    const provider = createProactiveToolsProvider();

    const result = await provider.attach(agent);
    const components = "components" in result ? result.components : result;
    const toolNames = ["sleep", "cancel_sleep", "schedule_cron", "cancel_schedule"] as const;
    for (const n of toolNames) {
      expect(components.has(toolToken(n) as string)).toBe(true);
    }
  });

  test("attach surfaces a skipped entry when the agent has no SCHEDULER component", async () => {
    const agent = makeAgent(undefined);
    const provider = createProactiveToolsProvider();

    const result = await provider.attach(agent);
    const skipped = "skipped" in result ? result.skipped : [];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe("proactive");
    expect(skipped[0]?.reason).toContain("SchedulerComponent");
  });

  test("each attach uses the attaching agent's own scheduler — no cross-agent leak", async () => {
    const stubA = createSchedulerStub();
    const stubB = createSchedulerStub();
    const agentA = makeAgent(stubA.component);
    const agentB = makeAgent(stubB.component);
    const provider = createProactiveToolsProvider();

    const resA = await provider.attach(agentA);
    const resB = await provider.attach(agentB);

    const sleepTokenKey = toolToken("sleep") as string;
    const compsA = "components" in resA ? resA.components : resA;
    const compsB = "components" in resB ? resB.components : resB;
    const sleepA = compsA.get(sleepTokenKey) as { execute: (a: object) => Promise<unknown> };
    const sleepB = compsB.get(sleepTokenKey) as { execute: (a: object) => Promise<unknown> };

    await sleepA.execute({ duration_ms: 100 });
    await sleepB.execute({ duration_ms: 200 });

    expect(stubA.submitCalls).toHaveLength(1);
    expect(stubB.submitCalls).toHaveLength(1);
    expect(stubA.submitCalls[0]?.options?.delayMs).toBe(100);
    expect(stubB.submitCalls[0]?.options?.delayMs).toBe(200);
  });
});
