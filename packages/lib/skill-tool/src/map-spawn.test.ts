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
      expect(result.value.allowedTools).toBeUndefined();
    }
  });

  test("includes allowedTools when present on skill", () => {
    const skill = makeSkill({
      metadata: { agent: "my-agent" },
      allowedTools: ["Bash", "Read"],
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allowedTools).toEqual(["Bash", "Read"]);
    }
  });

  test("returns NOT_FOUND when metadata.agent is missing", () => {
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

  test("returns NOT_FOUND when metadata.agent is empty string", () => {
    const skill = makeSkill({ metadata: { agent: "" } });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION when allowedTools is empty array", () => {
    const skill = makeSkill({
      metadata: { agent: "my-agent" },
      allowedTools: [],
    });
    const result = extractSpawnConfig(skill);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

describe("mapSkillToSpawnRequest", () => {
  const baseConfig = {
    signal: AbortSignal.timeout(5000),
    sessionId: "session-123",
  };

  test("sets fork: true when no allowedTools", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = { agentName: "agent-a" };
    const request = mapSkillToSpawnRequest(skill, "do stuff", spawnConfig, baseConfig);

    expect(request.agentName).toBe("agent-a");
    expect(request.description).toBe("do stuff");
    expect(request.fork).toBe(true);
    expect(request.toolAllowlist).toBeUndefined();
    expect(request.nonInteractive).toBe(true);
  });

  test("sets toolAllowlist when allowedTools present (no fork)", () => {
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = {
      agentName: "agent-b",
      allowedTools: ["Bash", "Edit"],
    };
    const request = mapSkillToSpawnRequest(skill, undefined, spawnConfig, baseConfig);

    expect(request.toolAllowlist).toEqual(["Bash", "Edit"]);
    expect(request.fork).toBeUndefined();
    expect(request.description).toBe("Execute skill: test-skill");
  });

  test("substitutes variables in systemPrompt", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} patterns
    const skill = makeSkill({ body: "Run ${ARGS} in ${SKILL_DIR} (${SESSION_ID})" });
    const spawnConfig: SpawnConfig = { agentName: "agent-c" };
    const request = mapSkillToSpawnRequest(skill, "build", spawnConfig, baseConfig);

    expect(request.systemPrompt).toBe("Run build in /skills/test-skill (session-123)");
  });

  test("passes signal through", () => {
    const signal = AbortSignal.timeout(1000);
    const skill = makeSkill();
    const spawnConfig: SpawnConfig = { agentName: "agent-d" };
    const request = mapSkillToSpawnRequest(skill, "test", spawnConfig, { signal });

    expect(request.signal).toBe(signal);
  });
});
