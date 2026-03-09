/**
 * Tests for run_skill_script tool — Phase 3C.
 *
 * Covers: input validation, script path security, store loading,
 * sandbox execution, and error mapping.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickId, ExecutionContext, SkillArtifact } from "@koi/core";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { RunSkillScriptDeps } from "./run-skill-script.js";
import { createRunSkillScriptTool } from "./run-skill-script.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSkillWithScripts(id: string, files: Record<string, string>): SkillArtifact {
  return {
    id: `sha256:${id}` as BrickId,
    kind: "skill",
    name: `skill-${id}`,
    description: `Test skill ${id}`,
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "active",
    provenance: {
      source: { origin: "forged", forgedBy: "test", sessionId: "s1" },
      buildDefinition: { buildType: "test/v1", externalParameters: {} },
      builder: { id: "test/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 1000,
        finishedAt: 1000,
        sessionId: "s1",
        agentId: "test",
        depth: 0,
      },
      verification: {
        passed: true,
        sandbox: true,
        totalDurationMs: 0,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: `sha256:${id}` as BrickId,
    },
    version: "0.1.0",
    tags: ["test"],
    usageCount: 0,
    content: "# Test skill",
    files,
  };
}

function createMockExecutor(): {
  readonly executor: RunSkillScriptDeps["executor"];
  readonly calls: Array<{
    code: string;
    input: unknown;
    timeoutMs: number;
    context: ExecutionContext | undefined;
  }>;
} {
  const calls: Array<{
    code: string;
    input: unknown;
    timeoutMs: number;
    context: ExecutionContext | undefined;
  }> = [];

  const executor: RunSkillScriptDeps["executor"] = {
    execute: mock(
      async (code: string, input: unknown, timeoutMs: number, context?: ExecutionContext) => {
        calls.push({ code, input, timeoutMs, context });
        return {
          ok: true as const,
          value: { output: { result: "ok" }, durationMs: 42 },
        };
      },
    ),
  };

  return { executor, calls };
}

async function createDeps(executorOverride?: RunSkillScriptDeps["executor"]): Promise<{
  deps: RunSkillScriptDeps;
  store: ReturnType<typeof createInMemoryForgeStore>;
  calls: Array<{
    code: string;
    input: unknown;
    timeoutMs: number;
    context: ExecutionContext | undefined;
  }>;
}> {
  const store = createInMemoryForgeStore();
  const { executor, calls } = createMockExecutor();
  return {
    deps: { store, executor: executorOverride ?? executor },
    store,
    calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run_skill_script", () => {
  // ---- Tool descriptor ----

  test("has correct descriptor", () => {
    const { executor } = createMockExecutor();
    const store = createInMemoryForgeStore();
    const tool = createRunSkillScriptTool({ store, executor });
    expect(tool.descriptor.name).toBe("run_skill_script");
    expect(tool.origin).toBe("primordial");
    expect(tool.policy.sandbox).toBe(true);
  });

  // ---- Input validation ----

  test("returns error when input is null", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute(null as never)) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("returns error when brickId is missing", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      scriptPath: "scripts/setup.ts",
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("returns error when scriptPath is missing", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({ brickId: "sha256:abc" })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  // ---- Script path security ----

  test("rejects scriptPath not starting with scripts/", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:abc",
      scriptPath: "other/file.ts",
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_SCHEMA");
    expect(result.error.message).toContain('must start with "scripts/"');
  });

  test("rejects scriptPath with path traversal", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:abc",
      scriptPath: "scripts/../../../etc/passwd",
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_SCHEMA");
    expect(result.error.message).toContain("path traversal");
  });

  // ---- Store errors ----

  test("returns LOAD_FAILED when brick does not exist", async () => {
    const { deps } = await createDeps();
    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:nonexistent",
      scriptPath: "scripts/run.ts",
    })) as { ok: false; error: { stage: string; code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("LOAD_FAILED");
  });

  test("returns INVALID_SCHEMA when brick is not a skill", async () => {
    const { deps, store } = await createDeps();
    // Save a tool brick (not a skill)
    await store.save({
      id: "sha256:tool1" as BrickId,
      kind: "tool",
      name: "my-tool",
      description: "A tool",
      scope: "agent",
      origin: "forged",
      policy: { sandbox: true, capabilities: {} },
      lifecycle: "active",
      provenance: {
        source: { origin: "forged", forgedBy: "test", sessionId: "s1" },
        buildDefinition: { buildType: "test/v1", externalParameters: {} },
        builder: { id: "test/v1" },
        metadata: {
          invocationId: "inv-1",
          startedAt: 1000,
          finishedAt: 1000,
          sessionId: "s1",
          agentId: "test",
          depth: 0,
        },
        verification: {
          passed: true,
          sandbox: true,
          totalDurationMs: 0,
          stageResults: [],
        },
        classification: "public",
        contentMarkers: [],
        contentHash: "sha256:tool1" as BrickId,
      },
      version: "0.1.0",
      tags: [],
      usageCount: 0,
      implementation: "// noop",
      inputSchema: {},
    });

    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:tool1",
      scriptPath: "scripts/run.ts",
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_SCHEMA");
    expect(result.error.message).toContain("tool");
    expect(result.error.message).toContain("not a skill");
  });

  // ---- Files validation ----

  test("returns MISSING_FIELD when skill has no files", async () => {
    const { deps, store } = await createDeps();
    const skill = makeSkillWithScripts("nofiles", {});
    // Remove files field by saving a skill without it
    const { files: _files, ...skillWithoutFiles } = skill;
    await store.save(skillWithoutFiles as SkillArtifact);

    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:nofiles",
      scriptPath: "scripts/run.ts",
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MISSING_FIELD");
    expect(result.error.message).toContain("no files");
  });

  test("returns MISSING_FIELD when script path not found in files", async () => {
    const { deps, store } = await createDeps();
    const skill = makeSkillWithScripts("partial", {
      "scripts/setup.ts": "// setup",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:partial",
      scriptPath: "scripts/missing.ts",
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MISSING_FIELD");
    expect(result.error.message).toContain("scripts/missing.ts");
    expect(result.error.message).toContain("scripts/setup.ts");
  });

  // ---- Happy path ----

  test("executes script and returns result", async () => {
    const { deps, store } = await createDeps();
    const skill = makeSkillWithScripts("deploy", {
      "scripts/validate.ts": "return { valid: true };",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    const result = (await tool.execute({
      brickId: "sha256:deploy",
      scriptPath: "scripts/validate.ts",
    })) as {
      ok: true;
      value: {
        output: unknown;
        durationMs: number;
        scriptPath: string;
        brickId: string;
      };
    };
    expect(result.ok).toBe(true);
    expect(result.value.scriptPath).toBe("scripts/validate.ts");
    expect(result.value.brickId).toBe("sha256:deploy");
    expect(result.value.durationMs).toBe(42);
    expect(result.value.output).toEqual({ result: "ok" });
  });

  // ---- Execution details ----

  test("passes input to sandbox executor", async () => {
    const { deps, store, calls } = await createDeps();
    const skill = makeSkillWithScripts("s1", {
      "scripts/run.ts": "return input;",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    await tool.execute({
      brickId: "sha256:s1",
      scriptPath: "scripts/run.ts",
      input: { x: 42 },
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.input).toEqual({ x: 42 });
    expect(calls[0]?.code).toBe("return input;");
  });

  test("uses default timeout when not specified", async () => {
    const { deps, store, calls } = await createDeps();
    const skill = makeSkillWithScripts("s2", {
      "scripts/run.ts": "//",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    await tool.execute({
      brickId: "sha256:s2",
      scriptPath: "scripts/run.ts",
    });

    expect(calls[0]?.timeoutMs).toBe(10_000);
  });

  test("clamps timeout to maximum", async () => {
    const { deps, store, calls } = await createDeps();
    const skill = makeSkillWithScripts("s3", {
      "scripts/run.ts": "//",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    await tool.execute({
      brickId: "sha256:s3",
      scriptPath: "scripts/run.ts",
      timeoutMs: 999_999,
    });

    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  test("passes restrictive execution context", async () => {
    const { deps, store, calls } = await createDeps();
    const skill = makeSkillWithScripts("s4", {
      "scripts/run.ts": "//",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    await tool.execute({
      brickId: "sha256:s4",
      scriptPath: "scripts/run.ts",
    });

    const ctx = calls[0]?.context;
    expect(ctx).toBeDefined();
    expect(ctx?.networkAllowed).toBe(false);
    expect(ctx?.resourceLimits?.maxMemoryMb).toBe(256);
    expect(ctx?.resourceLimits?.maxPids).toBe(32);
  });

  // ---- Sandbox errors ----

  test("returns sandbox error on execution failure", async () => {
    const failingExecutor: RunSkillScriptDeps["executor"] = {
      execute: async () => ({
        ok: false as const,
        error: {
          code: "TIMEOUT" as const,
          message: "Script exceeded time limit",
          durationMs: 10_000,
        },
      }),
    };

    const store = createInMemoryForgeStore();
    const skill = makeSkillWithScripts("timeout", {
      "scripts/slow.ts": "while(true){}",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool({
      store,
      executor: failingExecutor,
    });
    const result = (await tool.execute({
      brickId: "sha256:timeout",
      scriptPath: "scripts/slow.ts",
    })) as {
      ok: false;
      error: { stage: string; code: string; durationMs: number };
    };
    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("sandbox");
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.error.durationMs).toBe(10_000);
  });

  test("defaults input to empty object when not provided", async () => {
    const { deps, store, calls } = await createDeps();
    const skill = makeSkillWithScripts("s5", {
      "scripts/run.ts": "//",
    });
    await store.save(skill);

    const tool = createRunSkillScriptTool(deps);
    await tool.execute({
      brickId: "sha256:s5",
      scriptPath: "scripts/run.ts",
    });

    expect(calls[0]?.input).toEqual({});
  });
});
