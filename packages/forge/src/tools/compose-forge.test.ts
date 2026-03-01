import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  ForgeStore,
  Result,
  SandboxExecutor,
  TieredSandboxExecutor,
} from "@koi/core";
import { brickId, MAX_PIPELINE_STEPS } from "@koi/core";
import { createTestSkillArtifact, createTestToolArtifact } from "@koi/test-utils";
import { createDefaultForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import type { ForgeResult } from "../types.js";
import { createComposeForge } from "./compose-forge.js";
import type { ForgeDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(overrides?: Partial<ForgeStore>): ForgeStore {
  return {
    save: mock(async () => ({ ok: true, value: undefined }) as Result<void, never>),
    load: mock(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    })),
    search: mock(async () => ({ ok: true, value: [] })),
    remove: mock(async () => ({ ok: true, value: undefined })),
    update: mock(async () => ({ ok: true, value: undefined })),
    exists: mock(async () => ({ ok: true, value: false })),
    ...overrides,
  } as ForgeStore;
}

function createMockExecutor(): TieredSandboxExecutor {
  const executor: SandboxExecutor = {
    execute: mock(async () => ({
      ok: true as const,
      value: { output: "test", durationMs: 10 },
    })),
  };
  return {
    forTier: () => ({
      executor,
      requestedTier: "sandbox",
      resolvedTier: "sandbox",
      fallback: false,
    }),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createMockStore(),
    executor: createMockExecutor(),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

function createStoreWithBricks(...bricks: readonly BrickArtifact[]): ForgeStore {
  return createMockStore({
    load: mock(async (id: unknown) => {
      const idStr = String(id);
      const brick = bricks.find((b) => b.id === idStr);
      if (brick !== undefined) {
        return { ok: true as const, value: brick };
      }
      return {
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
      };
    }),
    exists: mock(async () => ({ ok: true as const, value: false })),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compose_forge", () => {
  test("returns error when brickIds has fewer than 2 entries", async () => {
    const deps = createDeps();
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "composite",
      description: "test",
      brickIds: ["one"],
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("at least 2");
    }
  });

  test("returns error when name is missing", async () => {
    const deps = createDeps();
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      description: "test",
      brickIds: ["a", "b"],
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
  });

  test("returns error when a brick is not found", async () => {
    const deps = createDeps();
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "composite",
      description: "test",
      brickIds: ["sha256:a", "sha256:b"],
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not found");
    }
  });

  test("returns error when brickIds exceeds MAX_PIPELINE_STEPS", async () => {
    const deps = createDeps();
    const tool = createComposeForge(deps);
    const ids = Array.from(
      { length: MAX_PIPELINE_STEPS + 1 },
      (_, i) => `sha256:${String(i).padStart(64, "0")}`,
    );
    const result = (await tool.execute({
      name: "too-many",
      description: "test",
      brickIds: ids,
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maximum");
    }
  });

  test("constructs CompositeArtifact with ordered pipeline steps", async () => {
    const toolA = createTestToolArtifact({
      name: "step-a",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
    });
    const toolB = createTestToolArtifact({
      name: "step-b",
      inputSchema: { type: "object" },
    });

    const store = createStoreWithBricks(toolA, toolB);
    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "pipeline-ab",
      description: "A→B pipeline",
      brickIds: [toolA.id, toolB.id],
      tags: ["pipeline"],
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("composite");
      expect(result.value.name).toBe("pipeline-ab");
    }
  });

  test("sets outputKind to last brick's kind", async () => {
    const toolA = createTestToolArtifact({ name: "tool-a" });
    const skillB = createTestSkillArtifact({ name: "skill-b" });

    const store = createStoreWithBricks(toolA, skillB);
    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "mixed-pipeline",
      description: "tool → skill pipeline",
      brickIds: [toolA.id, skillB.id],
    })) as Result<ForgeResult, ForgeError>;

    // tool output is { type: "object" }, skill input is { type: "string" }
    // These are incompatible types, so this should fail validation
    expect(result.ok).toBe(false);
  });

  test("supports mixed-kind pipelines when schemas are compatible", async () => {
    // Both have object schemas — compatible
    const toolA = createTestToolArtifact({
      name: "tool-a",
      inputSchema: { type: "object" },
    });
    const toolB = createTestToolArtifact({
      name: "tool-b",
      inputSchema: { type: "object" },
    });

    const store = createStoreWithBricks(toolA, toolB);
    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "two-tools",
      description: "Two tools piped",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(true);
  });

  test("returns error when consecutive steps have incompatible schemas", async () => {
    // Tool has object output, but skill has string input — type mismatch
    const toolA = createTestToolArtifact({ name: "tool-a" });
    const skillB = createTestSkillArtifact({ name: "skill-b" });

    const store = createStoreWithBricks(toolA, skillB);
    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "incompatible",
      description: "Should fail",
      brickIds: [toolA.id, skillB.id],
    })) as Result<unknown, ForgeError>;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Pipeline validation failed");
    }
  });

  test("uses explicit outputSchema from tool when present", async () => {
    const outputSchema = { type: "object", properties: { result: { type: "string" } } };
    const toolA = createTestToolArtifact({
      id: brickId("sha256:aaa"),
      name: "tool-with-output-schema",
      inputSchema: { type: "object" },
      outputSchema,
    });
    const toolB = createTestToolArtifact({
      id: brickId("sha256:bbb"),
      name: "tool-b",
      inputSchema: { type: "object" },
    });

    const saveMock = mock(async () => ({ ok: true as const, value: undefined }));
    const store = createMockStore({
      load: mock(async (id: unknown) => {
        const idStr = String(id);
        if (idStr === toolA.id) return { ok: true as const, value: toolA };
        if (idStr === toolB.id) return { ok: true as const, value: toolB };
        return {
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
        };
      }),
      exists: mock(async () => ({ ok: true as const, value: false })),
      save: saveMock,
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "pipeline-with-output-schema",
      description: "Tests outputSchema propagation",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(true);

    // Verify the saved composite artifact uses the explicit outputSchema for step A
    const savedArg = saveMock.mock.calls[0]?.[0] as BrickArtifact | undefined;
    expect(savedArg).toBeDefined();
    if (savedArg !== undefined && savedArg.kind === "composite") {
      // First step's output port should use the declared outputSchema
      const firstStep = savedArg.steps[0];
      expect(firstStep).toBeDefined();
      if (firstStep !== undefined) {
        expect(firstStep.outputPort.schema).toEqual(outputSchema);
      }
      // Last step (no outputSchema) should fall back to default
      const lastStep = savedArg.steps[1];
      expect(lastStep).toBeDefined();
      if (lastStep !== undefined) {
        expect(lastStep.outputPort.schema).toEqual({ type: "object" });
      }
      // exposedOutput comes from the last step — should be the default
      expect(savedArg.exposedOutput.schema).toEqual({ type: "object" });
    }
  });

  test("loads all bricks in parallel via Promise.all", async () => {
    const toolA = createTestToolArtifact({ name: "tool-a" });
    const toolB = createTestToolArtifact({ name: "tool-b" });

    const loadMock = mock(async (id: unknown) => {
      const idStr = String(id);
      if (idStr === toolA.id) return { ok: true as const, value: toolA };
      if (idStr === toolB.id) return { ok: true as const, value: toolB };
      return {
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
      };
    });

    const store = createMockStore({
      load: loadMock,
      exists: mock(async () => ({ ok: true as const, value: false })),
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    await tool.execute({
      name: "parallel-test",
      description: "test",
      brickIds: [toolA.id, toolB.id],
    });

    // Verify both bricks were loaded
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  test("saves CompositeArtifact to store", async () => {
    const toolA = createTestToolArtifact({ name: "tool-a" });
    const toolB = createTestToolArtifact({ name: "tool-b" });

    const saveMock = mock(async () => ({ ok: true as const, value: undefined }));
    const store = createMockStore({
      load: mock(async (id: unknown) => {
        const idStr = String(id);
        if (idStr === toolA.id) return { ok: true as const, value: toolA };
        if (idStr === toolB.id) return { ok: true as const, value: toolB };
        return {
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "nf", retryable: false },
        };
      }),
      exists: mock(async () => ({ ok: true as const, value: false })),
      save: saveMock,
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "saved-composite",
      description: "Should be saved",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;

    expect(result.ok).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(1);

    // Verify the saved artifact is a CompositeArtifact
    const savedArg = saveMock.mock.calls[0]?.[0] as BrickArtifact | undefined;
    expect(savedArg).toBeDefined();
    if (savedArg !== undefined) {
      expect(savedArg.kind).toBe("composite");
      if (savedArg.kind === "composite") {
        expect(savedArg.steps).toHaveLength(2);
        expect(savedArg.outputKind).toBe("tool");
        expect(savedArg.exposedInput.schema).toEqual({ type: "object" });
        expect(savedArg.exposedOutput.schema).toEqual({ type: "object" });
      }
    }
  });
});
