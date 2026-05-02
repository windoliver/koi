import { describe, expect, test } from "bun:test";
import { type AgentRegistry, agentId, type RegistryEntry, type TaskableAgent } from "@koi/core";
import { createRegistryAgentResolver } from "./registry-agent-resolver.js";

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    agentId: agentId("a-1"),
    agentType: "worker",
    version: 1,
    generation: 0,
    registeredAt: 0,
    lastTransitionAt: 0,
    manifest: { name: "x", version: "1.0.0", model: { name: "m" } },
    status: {
      phase: "running",
      conditions: [],
      generation: 0,
      lastTransitionAt: 0,
    } as RegistryEntry["status"],
    metadata: {},
    ...overrides,
  } as RegistryEntry;
}

function fakeRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
  return {
    register: () => entries[0] as RegistryEntry,
    deregister: () => true,
    lookup: () => undefined,
    list: () => entries,
    transition: () => ({ ok: true, value: entries[0] as RegistryEntry }),
    patch: () => ({ ok: true, value: entries[0] as RegistryEntry }),
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

const dummy: TaskableAgent = {
  name: "researcher",
  description: "x",
  manifest: { name: "researcher", version: "1.0.0", model: { name: "m" } },
};

describe("createRegistryAgentResolver", () => {
  test("delegates resolve and list to catalog map", async () => {
    const reg = fakeRegistry([]);
    const r = createRegistryAgentResolver(new Map([["researcher", dummy]]), reg);
    const got = await Promise.resolve(r.resolve("researcher"));
    expect("ok" in got && got.ok === true).toBe(true);
    const list = await Promise.resolve(r.list());
    expect(list[0]?.key).toBe("researcher");
  });

  test("findLive returns idle for waiting+Ready agent", async () => {
    const idle = makeEntry({
      status: { phase: "waiting", conditions: ["Ready"], generation: 0, lastTransitionAt: 0 },
    });
    const r = createRegistryAgentResolver(new Map([["researcher", dummy]]), fakeRegistry([idle]));
    const live = await r.findLive?.("researcher");
    expect(live?.state).toBe("idle");
  });

  test("findLive returns busy for running agent", async () => {
    const running = makeEntry({
      status: { phase: "running", conditions: [], generation: 0, lastTransitionAt: 0 },
    });
    const r = createRegistryAgentResolver(
      new Map([["researcher", dummy]]),
      fakeRegistry([running]),
    );
    const live = await r.findLive?.("researcher");
    expect(live?.state).toBe("busy");
  });

  test("findLive returns undefined when no entries", async () => {
    const r = createRegistryAgentResolver(new Map([["researcher", dummy]]), fakeRegistry([]));
    const live = await r.findLive?.("researcher");
    expect(live).toBeUndefined();
  });
});
