import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result, SpawnFn, SpawnRequest, SpawnResult } from "@koi/core";
import { createSkillTool, createSkillToolProvider } from "./create-skill-tool.js";
import type { LoadedSkill, SkillMeta, SkillResolver, SkillToolConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMeta(name: string, overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name,
    description: `${name} skill`,
    source: "project",
    dirPath: `/skills/${name}`,
    ...overrides,
  };
}

function makeSkill(name: string, overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    ...makeMeta(name),
    body: `Execute ${name}`,
    ...overrides,
  };
}

function makeResolver(
  skills: readonly LoadedSkill[],
  overrides?: { discoverError?: KoiError; loadError?: KoiError },
): SkillResolver {
  const metaMap = new Map<string, SkillMeta>(skills.map((s) => [s.name, s]));
  const skillMap = new Map<string, LoadedSkill>(skills.map((s) => [s.name, s]));

  return {
    discover: async (): Promise<Result<ReadonlyMap<string, SkillMeta>, KoiError>> => {
      if (overrides?.discoverError !== undefined) {
        return { ok: false, error: overrides.discoverError };
      }
      return { ok: true, value: metaMap };
    },
    load: async (name: string): Promise<Result<LoadedSkill, KoiError>> => {
      if (overrides?.loadError !== undefined) {
        return { ok: false, error: overrides.loadError };
      }
      const skill = skillMap.get(name);
      if (skill === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Skill "${name}" not found`,
            retryable: false,
            context: { name },
          },
        };
      }
      return { ok: true, value: skill };
    },
  };
}

function makeConfig(
  resolver: SkillResolver,
  overrides?: Partial<SkillToolConfig>,
): SkillToolConfig {
  return {
    resolver,
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillTool", () => {
  test("returns error when discover fails", async () => {
    const resolver = makeResolver([], {
      discoverError: {
        code: "INTERNAL",
        message: "Filesystem error",
        retryable: false,
        context: {},
      },
    });
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
    }
  });

  test("returns Tool with skill listing in description", async () => {
    const resolver = makeResolver([makeSkill("alpha"), makeSkill("beta")]);
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("Skill");
      expect(result.value.descriptor.description).toContain("alpha");
      expect(result.value.descriptor.description).toContain("beta");
      expect(result.value.origin).toBe("primordial");
    }
  });

  test("returns Tool with empty skills message when no skills", async () => {
    const resolver = makeResolver([]);
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.description).toContain("No skills are currently available");
    }
  });
});

describe("SkillTool.execute — inline mode", () => {
  test("returns substituted skill body on success", async () => {
    const skill = makeSkill("greet", {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} patterns
      body: "Hello ${ARGS} from ${SKILL_DIR}",
      dirPath: "/skills/greet",
    });
    const resolver = makeResolver([skill]);
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "greet", args: "world" })) as Result<
      string,
      KoiError
    >;
    expect(execResult.ok).toBe(true);
    if (execResult.ok) {
      expect(execResult.value).toBe("Hello world from /skills/greet");
    }
  });

  test("returns NOT_FOUND error when skill does not exist", async () => {
    const resolver = makeResolver([makeSkill("exists")]);
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "nonexistent" })) as Result<
      string,
      KoiError
    >;
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns VALIDATION error for invalid input", async () => {
    const resolver = makeResolver([makeSkill("test")]);
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "" })) as Result<string, KoiError>;
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe("VALIDATION");
    }
  });

  test("falls back to inline when skill has agent but no spawnFn", async () => {
    const skill = makeSkill("fork-skill", {
      body: "Fork body",
      metadata: { agent: "my-agent" },
    });
    const resolver = makeResolver([skill]);
    // No spawnFn provided
    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "fork-skill" })) as Result<
      string,
      KoiError
    >;
    expect(execResult.ok).toBe(true);
    if (execResult.ok) {
      expect(execResult.value).toBe("Fork body");
    }
  });
});

describe("SkillTool.execute — fork mode", () => {
  test("delegates to spawnFn when skill has agent metadata", async () => {
    const skill = makeSkill("fork-skill", {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} pattern
      body: "System prompt for ${ARGS}",
      metadata: { agent: "deploy-agent" },
    });
    const resolver = makeResolver([skill]);

    const spawnFn = mock(
      async (_request: SpawnRequest): Promise<SpawnResult> => ({
        ok: true,
        output: "Spawned successfully",
      }),
    );

    const result = await createSkillTool(
      makeConfig(resolver, { spawnFn: spawnFn as SpawnFn, sessionId: "sess-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({
      skill: "fork-skill",
      args: "deploy prod",
    })) as SpawnResult;
    expect(execResult.ok).toBe(true);
    if (execResult.ok) {
      expect(execResult.output).toBe("Spawned successfully");
    }

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const request = spawnFn.mock.calls[0]?.[0] as SpawnRequest;
    expect(request.agentName).toBe("deploy-agent");
    expect(request.systemPrompt).toBe("System prompt for deploy prod");
    expect(request.nonInteractive).toBe(true);
    expect(request.fork).toBe(true);
  });

  test("surfaces spawnFn error with code", async () => {
    const skill = makeSkill("fail-fork", {
      body: "body",
      metadata: { agent: "bad-agent" },
    });
    const resolver = makeResolver([skill]);

    const spawnFn = mock(
      async (_request: SpawnRequest): Promise<SpawnResult> => ({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "Agent timed out",
          retryable: true,
          context: {},
        },
      }),
    );

    const result = await createSkillTool(makeConfig(resolver, { spawnFn: spawnFn as SpawnFn }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "fail-fork" })) as SpawnResult;
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe("TIMEOUT");
    }
  });

  test("wraps unexpected spawnFn rejection as INTERNAL", async () => {
    const skill = makeSkill("throw-fork", {
      body: "body",
      metadata: { agent: "crash-agent" },
    });
    const resolver = makeResolver([skill]);

    const spawnFn = mock(async (_request: SpawnRequest): Promise<SpawnResult> => {
      throw new Error("Unexpected crash");
    });

    const result = await createSkillTool(makeConfig(resolver, { spawnFn: spawnFn as SpawnFn }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "throw-fork" })) as {
      ok: false;
      error: KoiError;
    };
    expect(execResult.ok).toBe(false);
    expect(execResult.error.code).toBe("INTERNAL");
    expect(execResult.error.message).toContain("throw-fork");
  });
});

describe("SkillTool.execute — cancellation", () => {
  test("returns CANCELLED when signal is already aborted", async () => {
    const resolver = makeResolver([makeSkill("test")]);
    const controller = new AbortController();
    controller.abort();

    const result = await createSkillTool(makeConfig(resolver, { signal: controller.signal }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute({ skill: "test" })) as {
      ok: false;
      error: KoiError;
    };
    expect(execResult.ok).toBe(false);
    expect(execResult.error.code).toBe("INTERNAL");
    expect(execResult.error.context).toEqual({ reason: "aborted" });
  });

  test("returns CANCELLED when per-call signal is aborted", async () => {
    const resolver = makeResolver([makeSkill("test")]);
    const callController = new AbortController();
    callController.abort();

    const result = await createSkillTool(makeConfig(resolver));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const execResult = (await result.value.execute(
      { skill: "test" },
      { signal: callController.signal },
    )) as { ok: false; error: KoiError };
    expect(execResult.ok).toBe(false);
    expect(execResult.error.code).toBe("INTERNAL");
    expect(execResult.error.context).toEqual({ reason: "aborted" });
  });
});

// ---------------------------------------------------------------------------
// createSkillToolProvider
// ---------------------------------------------------------------------------

describe("createSkillToolProvider", () => {
  test("attaches Skill tool under toolToken key", async () => {
    const resolver = makeResolver([makeSkill("alpha")]);
    const provider = createSkillToolProvider(makeConfig(resolver));

    expect(provider.name).toBe("skill-tool");
    expect(provider.priority).toBe(100); // COMPONENT_PRIORITY.BUNDLED

    const result = await provider.attach({} as never);
    if ("components" in result) {
      expect(result.components.size).toBe(1);
      expect(result.skipped.length).toBe(0);
      const key = [...result.components.keys()][0];
      expect(key).toContain("tool:Skill");
    }
  });

  test("skips tool when discover fails", async () => {
    const resolver = makeResolver([], {
      discoverError: {
        code: "INTERNAL",
        message: "Filesystem error",
        retryable: false,
        context: {},
      },
    });
    const provider = createSkillToolProvider(makeConfig(resolver));

    const result = await provider.attach({} as never);
    if ("components" in result) {
      expect(result.components.size).toBe(0);
      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0]?.reason).toContain("Filesystem error");
    }
  });
});
