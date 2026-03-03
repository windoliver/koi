/**
 * Tests for AgentEnv provider — merge-and-narrow with attenuation enforcement.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentEnv, AgentManifest, ProcessId, SubsystemToken } from "@koi/core";
import { agentId, ENV } from "@koi/core";
import { createAgentEnvProvider, mergeEnv } from "./agent-env-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(env?: AgentEnv): Agent {
  const components = new Map<string, unknown>();
  if (env !== undefined) {
    components.set(ENV as string, env);
  }

  const pid: ProcessId = {
    id: agentId("parent-1"),
    name: "parent",
    type: "copilot",
    depth: 0,
  };

  return {
    pid,
    manifest: { name: "test", description: "test" } as AgentManifest,
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>): boolean => components.has(token as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => components,
  };
}

// ---------------------------------------------------------------------------
// mergeEnv tests (table-driven)
// ---------------------------------------------------------------------------

describe("mergeEnv", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly parent: Readonly<Record<string, string>>;
    readonly overrides: Readonly<Record<string, string | undefined>>;
    readonly expected?: Readonly<Record<string, string>>;
    readonly error?: string;
  }> = [
    {
      name: "empty parent + empty overrides → empty result",
      parent: {},
      overrides: {},
      expected: {},
    },
    {
      name: "parent {A,B} + no overrides → copies parent",
      parent: { A: "1", B: "2" },
      overrides: {},
      expected: { A: "1", B: "2" },
    },
    {
      name: "parent {A,B} + override A → merged",
      parent: { A: "1", B: "2" },
      overrides: { A: "override" },
      expected: { A: "override", B: "2" },
    },
    {
      name: "parent {A,B} + narrow A (undefined) → B only",
      parent: { A: "1", B: "2" },
      overrides: { A: undefined },
      expected: { B: "2" },
    },
    {
      name: "parent {A,B} + narrow both → empty",
      parent: { A: "1", B: "2" },
      overrides: { A: undefined, B: undefined },
      expected: {},
    },
    {
      name: "parent {A} + add C → VALIDATION error (attenuation)",
      parent: { A: "1" },
      overrides: { C: "new" },
      error: "Env attenuation violation",
    },
    {
      name: "empty parent + add key → VALIDATION error",
      parent: {},
      overrides: { A: "value" },
      error: "Env attenuation violation",
    },
    {
      name: "parent {A: ''} + override A → replaces empty string",
      parent: { A: "" },
      overrides: { A: "value" },
      expected: { A: "value" },
    },
    {
      name: "parent {A: ''} vs narrow A → removes key",
      parent: { A: "" },
      overrides: { A: undefined },
      expected: {},
    },
    {
      name: "parent {A,B,C} + override A, narrow C → {A:override, B:original}",
      parent: { A: "1", B: "2", C: "3" },
      overrides: { A: "override", C: undefined },
      expected: { A: "override", B: "2" },
    },
    {
      name: "multiple invalid keys → error lists all",
      parent: { A: "1" },
      overrides: { X: "a", Y: "b" },
      error: "Env attenuation violation",
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      if (tc.error !== undefined) {
        expect(() => mergeEnv(tc.parent, tc.overrides)).toThrow(tc.error);
      } else {
        const result = mergeEnv(tc.parent, tc.overrides);
        expect(result).toEqual(tc.expected ?? {});
      }
    });
  }
});

// ---------------------------------------------------------------------------
// createAgentEnvProvider tests
// ---------------------------------------------------------------------------

describe("createAgentEnvProvider", () => {
  test("copies parent env when no overrides", async () => {
    const parentEnv: AgentEnv = { values: { FOO: "bar", BAZ: "qux" } };
    const parent = createMockAgent(parentEnv);
    const provider = createAgentEnvProvider({ parent });

    const components = await provider.attach(parent);
    const childEnv = (components as ReadonlyMap<string, unknown>).get(ENV as string) as AgentEnv;

    expect(childEnv.values).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(childEnv.parentEnv).toBe(parentEnv);
  });

  test("merges overrides with parent env", async () => {
    const parentEnv: AgentEnv = { values: { FOO: "bar", BAZ: "qux" } };
    const parent = createMockAgent(parentEnv);
    const provider = createAgentEnvProvider({
      parent,
      overrides: { FOO: "override" },
    });

    const components = await provider.attach(parent);
    const childEnv = (components as ReadonlyMap<string, unknown>).get(ENV as string) as AgentEnv;

    expect(childEnv.values).toEqual({ FOO: "override", BAZ: "qux" });
  });

  test("returns empty env when parent has no env component", async () => {
    const parent = createMockAgent(); // no env
    const provider = createAgentEnvProvider({ parent });

    const components = await provider.attach(parent);
    const childEnv = (components as ReadonlyMap<string, unknown>).get(ENV as string) as AgentEnv;

    expect(childEnv.values).toEqual({});
    expect(childEnv.parentEnv).toBeUndefined();
  });

  test("rejects new keys not in parent (attenuation)", async () => {
    const parentEnv: AgentEnv = { values: { FOO: "bar" } };
    const parent = createMockAgent(parentEnv);
    const provider = createAgentEnvProvider({
      parent,
      overrides: { NEW_KEY: "value" },
    });

    await expect(provider.attach(parent)).rejects.toThrow("Env attenuation violation");
  });

  test("three-level: root→child→grandchild narrows correctly", async () => {
    const rootEnv: AgentEnv = { values: { A: "1", B: "2", C: "3" } };
    const root = createMockAgent(rootEnv);

    // Child narrows to A, B
    const childProvider = createAgentEnvProvider({
      parent: root,
      overrides: { C: undefined },
    });
    const childComponents = await childProvider.attach(root);
    const childEnv = (childComponents as ReadonlyMap<string, unknown>).get(
      ENV as string,
    ) as AgentEnv;

    expect(childEnv.values).toEqual({ A: "1", B: "2" });

    // Grandchild attempts to reintroduce C → should fail
    const childAgent = createMockAgent(childEnv);
    const grandchildProvider = createAgentEnvProvider({
      parent: childAgent,
      overrides: { C: "reintroduced" },
    });

    await expect(grandchildProvider.attach(childAgent)).rejects.toThrow(
      "Env attenuation violation",
    );
  });

  test("property: leaf keys are subset of root keys", async () => {
    // Simulate 50-key env
    const rootValues: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      rootValues[`KEY_${i}`] = `value_${i}`;
    }
    const rootEnv: AgentEnv = { values: rootValues };
    const root = createMockAgent(rootEnv);

    // Narrow to first 25 keys
    const overrides: Record<string, string | undefined> = {};
    for (let i = 25; i < 50; i++) {
      overrides[`KEY_${i}`] = undefined;
    }

    const provider = createAgentEnvProvider({ parent: root, overrides });
    const components = await provider.attach(root);
    const childEnv = (components as ReadonlyMap<string, unknown>).get(ENV as string) as AgentEnv;

    const childKeys = new Set(Object.keys(childEnv.values));
    const rootKeys = new Set(Object.keys(rootValues));
    for (const key of childKeys) {
      expect(rootKeys.has(key)).toBe(true);
    }
    expect(childKeys.size).toBe(25);
  });
});
