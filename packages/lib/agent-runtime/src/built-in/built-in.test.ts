/**
 * Tests for built-in agent definitions.
 */

import { describe, expect, test } from "bun:test";
import type { ToolConfig } from "@koi/core";
import { COORDINATOR_MANIFEST, COORDINATOR_TOOL_ALLOWLIST } from "./coordinator.js";
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
      tools: a.manifest.tools?.map((t: ToolConfig) => t.name) ?? [],
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

  test("exact agent type set: researcher, coder, reviewer, coordinator", () => {
    const agents = getBuiltInAgents();
    expect(agents.map((a) => a.agentType).sort()).toEqual([
      "coder",
      "coordinator",
      "researcher",
      "reviewer",
    ]);
  });

  test("all built-in agents have substantial whenToUse (> 50 chars)", () => {
    const agents = getBuiltInAgents();
    for (const agent of agents) {
      expect(agent.whenToUse.length).toBeGreaterThan(50);
    }
  });

  test("all built-in agents have a non-trivial systemPrompt (> 100 chars)", () => {
    const agents = getBuiltInAgents();
    for (const agent of agents) {
      expect(agent.systemPrompt).toBeDefined();
      expect((agent.systemPrompt ?? "").length).toBeGreaterThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// Coordinator tool surface (Decision 2-A / 8-A / 11-A)
// ---------------------------------------------------------------------------

describe("COORDINATOR_TOOL_ALLOWLIST", () => {
  test("coordinator manifest spawn.tools.list is the worker ceiling (excludes Spawn)", () => {
    // The manifest ceiling controls what workers spawned BY the coordinator can use.
    // Workers do actual work — they must NOT have Spawn (no further delegation).
    // COORDINATOR_TOOL_ALLOWLIST (assembler-facing) includes "Spawn"; manifest ceiling does not.
    const spawnToolsList = COORDINATOR_MANIFEST.manifest.spawn?.tools?.list;
    expect(spawnToolsList).toBeDefined();
    expect(spawnToolsList).not.toContain("Spawn");
    // All non-Spawn tools from assembler allowlist must appear in worker ceiling
    const nonSpawnAllowlist = [...COORDINATOR_TOOL_ALLOWLIST].filter((t) => t !== "Spawn");
    expect(spawnToolsList).toEqual(nonSpawnAllowlist);
  });

  test("coordinator manifest spawn.tools.policy is allowlist", () => {
    expect(COORDINATOR_MANIFEST.manifest.spawn?.tools?.policy).toBe("allowlist");
  });

  test("COORDINATOR_TOOL_ALLOWLIST contains Spawn and the core delegation tools (assembler-facing)", () => {
    const allowlist = [...COORDINATOR_TOOL_ALLOWLIST];
    expect(allowlist).toContain("Spawn"); // runtime tool name — was incorrectly "agent_spawn"
    expect(allowlist).toContain("task_create");
    expect(allowlist).toContain("task_list");
    expect(allowlist).toContain("task_output");
    expect(allowlist).toContain("task_delegate");
    expect(allowlist).toContain("task_stop");
    expect(allowlist).toContain("send_message");
  });

  test("COORDINATOR_TOOL_ALLOWLIST snapshot — adding tools requires deliberate update", () => {
    expect([...COORDINATOR_TOOL_ALLOWLIST]).toMatchSnapshot();
  });

  test("COORDINATOR_MANIFEST is the pre-parsed coordinator used by getBuiltInAgents", () => {
    const agents = getBuiltInAgents();
    const coordinator = agents.find((a) => a.agentType === "coordinator");
    // Reference equality: getBuiltInAgents() pushes COORDINATOR_MANIFEST directly
    expect(coordinator).toBe(COORDINATOR_MANIFEST);
  });
});
