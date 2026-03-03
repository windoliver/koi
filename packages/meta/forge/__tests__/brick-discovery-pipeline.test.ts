/**
 * Integration test: brick discovery pipeline.
 *
 * Verifies the end-to-end flow: forge store → component provider → agent query.
 * Skills and agents flow through the same discover → verify → attach pipeline as tools.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentDescriptor, SkillComponent, SubsystemToken } from "@koi/core";
import { agentId, agentToken, skillToken, toolToken } from "@koi/core";
import {
  createTestAgentArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
} from "@koi/test-utils";
import { createForgeComponentProvider } from "../src/forge-component-provider.js";
import { createInMemoryForgeStore } from "../src/memory-store.js";
import type { SandboxExecutor } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true as const,
      value: { output: input, durationMs: 1 },
    }),
  };
}

/**
 * Creates a mock agent that accumulates components from attach().
 * Supports query<T>(prefix) for prefix-based component lookup.
 */
function createQueryableAgent(components: ReadonlyMap<string, unknown>): Agent {
  return {
    pid: { id: agentId("test-agent"), name: "test", type: "worker", depth: 0 },
    manifest: { name: "test-agent", version: "0.0.0", model: { name: "test-model" } },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

describe("brick discovery pipeline", () => {
  test("skill: save → discover → attach → query<SkillComponent>", async () => {
    // 1. Save skill artifact to forge store
    const store = createInMemoryForgeStore();
    await store.save(
      createTestSkillArtifact({
        name: "research",
        description: "Research skill",
        content: "# Research\n\nGather information and analyze.",
        tags: ["research"],
      }),
    );

    // 2. Create provider and attach to agent
    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
    });
    const components = await provider.attach(createQueryableAgent(new Map()));

    // 3. Verify skill is discoverable via prefix query
    const agent = createQueryableAgent(components);
    const skills = agent.query<SkillComponent>("skill:");
    expect(skills.size).toBe(1);

    const skill = skills.get(skillToken("research") as SubsystemToken<SkillComponent>);
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("research");
    expect(skill?.description).toBe("Research skill");
    expect(skill?.content).toBe("# Research\n\nGather information and analyze.");
    expect(skill?.tags).toEqual(["research"]);
  });

  test("agent: save → discover → attach → query<AgentDescriptor>", async () => {
    // 1. Save agent artifact to forge store
    const store = createInMemoryForgeStore();
    await store.save(
      createTestAgentArtifact({
        name: "planner",
        description: "Planning agent",
        manifestYaml: "name: planner\ntype: worker\nmodel:\n  name: gpt-4",
      }),
    );

    // 2. Create provider and attach to agent
    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
    });
    const components = await provider.attach(createQueryableAgent(new Map()));

    // 3. Verify agent is discoverable via prefix query
    const agent = createQueryableAgent(components);
    const agents = agent.query<AgentDescriptor>("agent:");
    expect(agents.size).toBe(1);

    const descriptor = agents.get(agentToken("planner") as SubsystemToken<AgentDescriptor>);
    expect(descriptor).toBeDefined();
    expect(descriptor?.name).toBe("planner");
    expect(descriptor?.description).toBe("Planning agent");
    expect(descriptor?.manifestYaml).toContain("name: planner");
  });

  test("mixed bricks: all kinds discoverable in single pass", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createTestToolArtifact({ name: "calc" }));
    await store.save(
      createTestSkillArtifact({
        name: "summarize",
        content: "# Summarize",
      }),
    );
    await store.save(
      createTestAgentArtifact({
        name: "worker",
        manifestYaml: "name: worker",
      }),
    );

    const provider = createForgeComponentProvider({
      store,
      executor: echoExecutor(),
    });
    const components = await provider.attach(createQueryableAgent(new Map()));
    const agent = createQueryableAgent(components);

    // Tools
    expect(agent.has(toolToken("calc"))).toBe(true);
    // Skills
    const skills = agent.query<SkillComponent>("skill:");
    expect(skills.size).toBe(1);
    // Agents
    const agents = agent.query<AgentDescriptor>("agent:");
    expect(agents.size).toBe(1);
  });
});
