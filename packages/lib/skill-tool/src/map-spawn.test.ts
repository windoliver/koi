import { describe, expect, test } from "bun:test";
import { extractSpawnConfig, mapSkillToSpawnRequest } from "./map-spawn.js";
import type { LoadedSkill, SpawnConfig } from "./types.js";

function makeSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: "test-skill",
    description: "A test skill",
    source: "project",
    dirPath: "/skills/test-skill",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} pattern
    body: "Do the thing with ${ARGS}",
    ...overrides,
  };
}

describe("extractSpawnConfig", () => {
  test("returns SpawnConfig when metadata.agent is present", () => {
    const skill = makeSkill({ metadata: { agent: "my-agent" } });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentName).toBe("my-agent");
    }
  });

  test("returns SpawnConfig when executionMode is fork", () => {
    const skill = makeSkill({ executionMode: "fork" });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Falls back to skill name when no metadata.agent
      expect(result.value.agentName).toBe("test-skill");
    }
  });

  test("returns SpawnConfig when executionMode is fork with agent override", () => {
    const skill = makeSkill({
      executionMode: "fork",
      metadata: { agent: "custom-agent" },
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentName).toBe("custom-agent");
    }
  });

  test("returns NOT_FOUND when executionMode is explicitly inline even with agent", () => {
    const skill = makeSkill({
      executionMode: "inline",
      metadata: { agent: "should-be-ignored" },
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND when inline-only (no executionMode, no agent)", () => {
    const skill = makeSkill({ metadata: { other: "value" } });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND when metadata is undefined", () => {
    const skill = makeSkill();
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND when metadata.agent is empty and no executionMode", () => {
    const skill = makeSkill({ metadata: { agent: "" } });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION when allowedTools is empty array", () => {
    const skill = makeSkill({
      executionMode: "fork",
      allowedTools: [],
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns VALIDATION when allowedTools has only reserved spawn tools", () => {
    const skill = makeSkill({
      executionMode: "fork",
      allowedTools: ["agent_spawn", "Spawn"],
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("reserved spawn tools");
    }
  });

  test("includes allowedTools when present on fork skill", () => {
    const skill = makeSkill({
      executionMode: "fork",
      allowedTools: ["Bash", "Read"],
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedTools).toEqual(["Bash", "Read"]);
    }
  });
});

describe("mapSkillToSpawnRequest", () => {
  const baseConfig = {
    signal: AbortSignal.timeout(5000),
    sessionId: "session-123",
  };

  test("always sets fork: true for recursion guard and turn cap", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = { agentName: "agent-a" };
    const request = mapSkillToSpawnRequest(skill, "do stuff", spawnConfig, baseConfig);

    expect(request.agentName).toBe("agent-a");
    expect(request.description).toBe("do stuff");
    expect(request.fork).toBe(true);
    expect(request.nonInteractive).toBe(true);
  });

  test("substitutes trusted variables in systemPrompt but not args", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} patterns
    const skill = makeSkill({ body: "Run ${ARGS} in ${SKILL_DIR} (${SESSION_ID})" });
    const spawnConfig: SpawnConfig = { agentName: "agent-c" };
    const request = mapSkillToSpawnRequest(skill, "build", spawnConfig, baseConfig);

    // ARGS should NOT be interpolated into systemPrompt (prompt injection risk)
    // SKILL_DIR and SESSION_ID are trusted and should be substituted
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting literal pattern preserved
    expect(request.systemPrompt).toBe("Run ${ARGS} in /skills/test-skill (session-123)");
    // args should be in description instead
    expect(request.description).toBe("build");
  });

  test("passes signal through", () => {
    const signal = AbortSignal.timeout(1000);
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = { agentName: "agent-d" };
    const request = mapSkillToSpawnRequest(skill, "test", spawnConfig, { signal });

    expect(request.signal).toBe(signal);
  });

  test("uses toolAllowlist with maxTurns when allowedTools present", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = {
      agentName: "agent-restricted",
      allowedTools: ["Bash", "Read"],
    };
    const request = mapSkillToSpawnRequest(skill, "run", spawnConfig, baseConfig);

    expect(request.toolAllowlist).toEqual(["Bash", "Read"]);
    expect(request.fork).toBeUndefined();
    expect(request.maxTurns).toBe(200);
    expect(request.nonInteractive).toBe(true);
  });

  test("strips reserved spawn tools from allowedTools for recursion guard", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = {
      agentName: "agent-f",
      allowedTools: ["Bash", "agent_spawn", "Spawn", "Read"],
    };
    const request = mapSkillToSpawnRequest(skill, "run", spawnConfig, baseConfig);

    expect(request.toolAllowlist).toEqual(["Bash", "Read"]);
    expect(request.toolAllowlist).not.toContain("agent_spawn");
    expect(request.toolAllowlist).not.toContain("Spawn");
  });

  // Note: all-reserved-spawn-tools case is caught by extractSpawnConfig validation

  test("uses skill name as default description", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = { agentName: "agent-e" };
    const request = mapSkillToSpawnRequest(skill, undefined, spawnConfig, baseConfig);

    expect(request.description).toBe("Execute skill: test-skill");
  });
});
