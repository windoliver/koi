/**
 * Tests for built-in agent definitions.
 */

import { describe, expect, test } from "bun:test";
import { BUILT_IN_AGENT_COUNT, getBuiltInAgents } from "./index.js";

describe("getBuiltInAgents", () => {
  test("all built-in agents load without error", () => {
    const agents = getBuiltInAgents();
    expect(agents.length).toBeGreaterThan(0);
  });

  test("built-in count matches expected number", () => {
    const agents = getBuiltInAgents();
    expect(agents.length).toBe(BUILT_IN_AGENT_COUNT);
    expect(agents.length).toBe(4);
  });

  test("structural snapshot: agentType, tools, model", () => {
    const agents = getBuiltInAgents();
    const shapes = agents.map((a) => ({
      agentType: a.agentType,
      source: a.source,
      model: a.manifest.model.name,
      tools: a.manifest.tools?.map((t) => t.name) ?? [],
    }));

    expect(shapes).toMatchSnapshot();
  });

  test("all built-in agents have source = built-in", () => {
    const agents = getBuiltInAgents();
    for (const agent of agents) {
      expect(agent.source).toBe("built-in");
    }
  });

  test("all built-in agents have non-empty whenToUse", () => {
    const agents = getBuiltInAgents();
    for (const agent of agents) {
      expect(agent.whenToUse.length).toBeGreaterThan(10);
    }
  });

  test("coordinator agent is present and uses opus model", () => {
    const agents = getBuiltInAgents();
    const coordinator = agents.find((a) => a.agentType === "coordinator");
    expect(coordinator).toBeDefined();
    expect(coordinator?.manifest.model.name).toBe("opus");
    expect(coordinator?.source).toBe("built-in");
  });
});
