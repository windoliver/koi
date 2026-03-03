import { describe, expect, test } from "bun:test";
import { agentId } from "./ecs.js";
import type { RegistryEntry } from "./lifecycle.js";
import { matchesFilter } from "./lifecycle.js";
import type { ZoneId } from "./zone.js";
import { zoneId } from "./zone.js";

function createEntry(overrides?: Partial<RegistryEntry>): RegistryEntry {
  return {
    agentId: agentId("agent-1"),
    status: {
      phase: "running",
      generation: 1,
      conditions: ["Ready"],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
    ...overrides,
  };
}

describe("zoneId", () => {
  test("creates a branded ZoneId from a plain string", () => {
    const id: ZoneId = zoneId("us-east-1");
    expect(id).toBe(zoneId("us-east-1"));
  });

  test("roundtrips through string comparison", () => {
    const id = zoneId("zone-a");
    expect(id === ("zone-a" as unknown as ZoneId)).toBe(true);
  });
});

describe("matchesFilter with zoneId", () => {
  test("matches when entry zoneId equals filter zoneId", () => {
    const entry = createEntry({ zoneId: zoneId("zone-a") });
    expect(matchesFilter(entry, { zoneId: zoneId("zone-a") })).toBe(true);
  });

  test("does not match when entry zoneId differs from filter zoneId", () => {
    const entry = createEntry({ zoneId: zoneId("zone-a") });
    expect(matchesFilter(entry, { zoneId: zoneId("zone-b") })).toBe(false);
  });

  test("does not match when entry has no zoneId but filter requires one", () => {
    const entry = createEntry();
    expect(matchesFilter(entry, { zoneId: zoneId("zone-a") })).toBe(false);
  });

  test("matches all entries when filter has no zoneId", () => {
    const entry = createEntry({ zoneId: zoneId("zone-a") });
    expect(matchesFilter(entry, {})).toBe(true);
  });

  test("combines zoneId filter with other filters", () => {
    const entry = createEntry({
      zoneId: zoneId("zone-a"),
      agentType: "worker",
    });
    expect(matchesFilter(entry, { zoneId: zoneId("zone-a"), agentType: "worker" })).toBe(true);
    expect(matchesFilter(entry, { zoneId: zoneId("zone-a"), agentType: "copilot" })).toBe(false);
  });
});
