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
    metadata: { agentName: "researcher" },
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

  test("findLive ignores entries whose metadata does not match the requested agent", async () => {
    // Agent of the same coarse type but a different catalog key — must NOT
    // be routed to (would otherwise hand researcher work to a deployer).
    const unrelated = makeEntry({
      status: { phase: "waiting", conditions: ["Ready"], generation: 0, lastTransitionAt: 0 },
      metadata: { agentName: "deployer" },
    });
    const r = createRegistryAgentResolver(
      new Map([["researcher", dummy]]),
      fakeRegistry([unrelated]),
    );
    const live = await r.findLive?.("researcher");
    expect(live).toBeUndefined();
  });

  test("findLive precedence: explicit agentName mismatch is NOT bypassed by metadata.name match", async () => {
    // An entry advertising agentName: "deployer" but also carrying the
    // manifest's name must NOT be returned for an agentType: "researcher"
    // lookup, even if the manifest names happen to coincide.
    const conflicting = makeEntry({
      status: { phase: "waiting", conditions: ["Ready"], generation: 0, lastTransitionAt: 0 },
      metadata: { agentName: "deployer", name: "researcher" },
    });
    const r = createRegistryAgentResolver(
      new Map([["researcher", dummy]]),
      fakeRegistry([conflicting]),
    );
    const live = await r.findLive?.("researcher");
    expect(live).toBeUndefined();
  });

  test("findLive matches explicit taskAgentType even when local catalog cannot resolve the key", async () => {
    // Version-skew tolerance: the live registry entry advertises an explicit
    // catalog key the local catalog has never heard of. The match should
    // still succeed because explicit keys don't depend on local resolution.
    const skewed = makeEntry({
      status: { phase: "waiting", conditions: ["Ready"], generation: 0, lastTransitionAt: 0 },
      metadata: { taskAgentType: "future-role" },
    });
    const r = createRegistryAgentResolver(
      new Map(), // empty catalog — no entry for "future-role"
      fakeRegistry([skewed]),
    );
    const live = await r.findLive?.("future-role");
    expect(live?.state).toBe("idle");
  });

  test("findLive returns undefined when no entries", async () => {
    const r = createRegistryAgentResolver(new Map([["researcher", dummy]]), fakeRegistry([]));
    const live = await r.findLive?.("researcher");
    expect(live).toBeUndefined();
  });
});
