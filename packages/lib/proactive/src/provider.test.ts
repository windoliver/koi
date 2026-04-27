import { describe, expect, test } from "bun:test";
import type { Agent, SchedulerComponent, SubsystemToken } from "@koi/core";
import { COMPONENT_PRIORITY, SCHEDULER, toolToken } from "@koi/core";
import { createProactiveToolsProvider } from "./provider.js";
import { createSchedulerStub } from "./test-helpers.js";

function makeAgent(
  scheduler: SchedulerComponent | undefined,
  agentIdValue = "agent-default",
): Agent {
  const map = new Map<string, unknown>();
  if (scheduler !== undefined) map.set(SCHEDULER as string, scheduler);
  const pid = {
    id: agentIdValue as unknown as Agent["pid"]["id"],
    name: agentIdValue,
    type: "worker" as const,
    depth: 0,
  };
  return {
    pid: pid as Agent["pid"],
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

  test("idempotency_key reservation survives reattach for the same agent pid", async () => {
    const stub = createSchedulerStub();
    const agent = makeAgent(stub.component);
    const provider = createProactiveToolsProvider();

    const sleepKey = toolToken("sleep") as string;
    const first = await provider.attach(agent);
    const firstComps = "components" in first ? first.components : first;
    const sleepFirst = firstComps.get(sleepKey) as { execute: (a: object) => Promise<unknown> };
    const r1 = (await sleepFirst.execute({
      duration_ms: 5_000,
      idempotency_key: "k",
    })) as { task_id: string };

    // Reattach: simulate runtime reassembly between turns.
    const second = await provider.attach(agent);
    const secondComps = "components" in second ? second.components : second;
    const sleepSecond = secondComps.get(sleepKey) as { execute: (a: object) => Promise<unknown> };
    const r2 = (await sleepSecond.execute({
      duration_ms: 5_000,
      idempotency_key: "k",
    })) as { task_id: string; deduped?: boolean };

    expect(r2.task_id).toBe(r1.task_id);
    expect(r2.deduped).toBe(true);
    expect(stub.submitCalls).toHaveLength(1);
  });

  test("scheduler swap preserves dedupe state — durable backends behind fresh wrappers keep working", async () => {
    const stubA = createSchedulerStub();
    const stubB = createSchedulerStub();
    const agent = makeAgent(stubA.component, "agent-x");
    const provider = createProactiveToolsProvider();

    const sleepKey = toolToken("sleep") as string;
    const first = await provider.attach(agent);
    const sleep1 = ("components" in first ? first.components : first).get(sleepKey) as {
      execute: (a: object) => Promise<unknown>;
    };
    const r1 = (await sleep1.execute({ duration_ms: 5_000, idempotency_key: "k" })) as {
      task_id: string;
    };
    expect(stubA.submitCalls).toHaveLength(1);

    // Re-attach against a different scheduler instance. Hosts commonly wrap
    // the same durable backend in a fresh adapter object (in-memory restart,
    // test reassembly), so we preserve dedupe state and rely on the durable
    // task ID still being valid. If the host swapped to a genuinely-fresh
    // backend, they should tear down the agent first.
    const replacedAgent = makeAgent(stubB.component, "agent-x");
    const second = await provider.attach(replacedAgent);
    const sleep2 = ("components" in second ? second.components : second).get(sleepKey) as {
      execute: (a: object) => Promise<unknown>;
    };
    const r2 = (await sleep2.execute({ duration_ms: 5_000, idempotency_key: "k" })) as {
      task_id: string;
      deduped?: boolean;
    };

    // No duplicate submission: dedupe matched the cached entry.
    expect(stubB.submitCalls).toHaveLength(0);
    expect(r2.task_id).toBe(r1.task_id);
    expect(r2.deduped).toBe(true);
  });

  test("two agents with the same idempotency_key do NOT share state", async () => {
    const stubA = createSchedulerStub();
    const stubB = createSchedulerStub();
    const agentA = makeAgent(stubA.component, "agent-a");
    const agentB = makeAgent(stubB.component, "agent-b");
    const provider = createProactiveToolsProvider();

    const sleepKey = toolToken("sleep") as string;
    const resA = await provider.attach(agentA);
    const resB = await provider.attach(agentB);
    const sleepA = ("components" in resA ? resA.components : resA).get(sleepKey) as {
      execute: (a: object) => Promise<unknown>;
    };
    const sleepB = ("components" in resB ? resB.components : resB).get(sleepKey) as {
      execute: (a: object) => Promise<unknown>;
    };

    await sleepA.execute({ duration_ms: 1_000, idempotency_key: "shared" });
    await sleepB.execute({ duration_ms: 1_000, idempotency_key: "shared" });

    // Each agent must hit its own scheduler — the shared key must NOT
    // dedupe across agents.
    expect(stubA.submitCalls).toHaveLength(1);
    expect(stubB.submitCalls).toHaveLength(1);
  });

  test("each attach uses the attaching agent's own scheduler — no cross-agent leak", async () => {
    const stubA = createSchedulerStub();
    const stubB = createSchedulerStub();
    const agentA = makeAgent(stubA.component, "agent-a");
    const agentB = makeAgent(stubB.component, "agent-b");
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
