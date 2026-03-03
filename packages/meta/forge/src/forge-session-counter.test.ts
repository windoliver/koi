import { describe, expect, test } from "bun:test";
import type { Agent, GovernanceVariableContributor } from "@koi/core";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import { createDefaultForgeConfig } from "./config.js";
import { FORGE_GOVERNANCE } from "./forge-governance-contributor.js";
import { createForgeSessionCounter } from "./forge-session-counter.js";

// FORGE_GOVERNANCE is a SubsystemToken (branded string) — widen for map lookups
const FORGE_KEY: string = FORGE_GOVERNANCE;

function stubAgent(): Agent {
  return { id: "agent-1", descriptor: {} } as unknown as Agent;
}

describe("createForgeSessionCounter", () => {
  const config = createDefaultForgeConfig();
  const readDepth = (): number => 0;

  test("starts at 0 by default", () => {
    const counter = createForgeSessionCounter({ config, readDepth });
    expect(counter.readForgeCount()).toBe(0);
  });

  test("starts at initialCount when provided", () => {
    const counter = createForgeSessionCounter({ config, readDepth, initialCount: 5 });
    expect(counter.readForgeCount()).toBe(5);
  });

  test("incrementForgeCount increments correctly", () => {
    const counter = createForgeSessionCounter({ config, readDepth });
    counter.incrementForgeCount(1);
    expect(counter.readForgeCount()).toBe(1);
    counter.incrementForgeCount(3);
    expect(counter.readForgeCount()).toBe(4);
  });

  test("readForgeCount reflects live value after multiple increments", () => {
    const counter = createForgeSessionCounter({ config, readDepth, initialCount: 2 });
    counter.incrementForgeCount(1);
    counter.incrementForgeCount(1);
    counter.incrementForgeCount(1);
    expect(counter.readForgeCount()).toBe(5);
  });

  test("provider.attach returns map with FORGE_GOVERNANCE key", async () => {
    const counter = createForgeSessionCounter({ config, readDepth });
    const result = await counter.provider.attach(stubAgent());
    const map = result as ReadonlyMap<string, unknown>;
    expect(map.has(FORGE_KEY)).toBe(true);
  });

  test("contributor variables read from live counter", async () => {
    const counter = createForgeSessionCounter({ config, readDepth });
    const result = await counter.provider.attach(stubAgent());
    const map = result as ReadonlyMap<string, unknown>;
    const contributor = map.get(FORGE_KEY) as GovernanceVariableContributor;

    const variables = contributor.variables();
    const budgetVar = variables.find((v) => v.name === GOVERNANCE_VARIABLES.FORGE_BUDGET);
    if (budgetVar === undefined) throw new Error("budgetVar not found");

    // Initially 0
    expect(budgetVar.read()).toBe(0);

    // Increment and verify live read
    counter.incrementForgeCount(2);
    expect(budgetVar.read()).toBe(2);
  });

  test("contributor depth variable reads from readDepth closure", async () => {
    // let justified: mutable depth for testing live reads
    let depth = 0;
    const counter = createForgeSessionCounter({
      config,
      readDepth: () => depth,
    });
    const result = await counter.provider.attach(stubAgent());
    const map = result as ReadonlyMap<string, unknown>;
    const contributor = map.get(FORGE_KEY) as GovernanceVariableContributor;

    const variables = contributor.variables();
    const depthVar = variables.find((v) => v.name === GOVERNANCE_VARIABLES.FORGE_DEPTH);
    if (depthVar === undefined) throw new Error("depthVar not found");
    expect(depthVar.read()).toBe(0);

    depth = 2;
    expect(depthVar.read()).toBe(2);
  });

  test("provider has correct name", () => {
    const counter = createForgeSessionCounter({ config, readDepth });
    expect(counter.provider.name).toBe("forge-session-counter");
  });

  test("rejects negative initialCount", () => {
    expect(() => createForgeSessionCounter({ config, readDepth, initialCount: -1 })).toThrow(
      "initialCount must be non-negative",
    );
  });
});
