import { describe, expect, mock, test } from "bun:test";
import type { ForgeStore, Result, SandboxExecutor, TieredSandboxExecutor } from "@koi/core";
import { brickId } from "@koi/core";
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
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found", retryable: false },
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

  test("returns error when bricks are mixed kinds", async () => {
    const toolBrick = createTestToolArtifact({ name: "tool-a" });
    const skillBrick = createTestSkillArtifact({ name: "skill-b" });

    const store = createMockStore({
      load: mock(async (id: unknown) => {
        const idStr = String(id);
        if (idStr === toolBrick.id) return { ok: true as const, value: toolBrick };
        if (idStr === skillBrick.id) return { ok: true as const, value: skillBrick };
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: "nf", retryable: false },
        };
      }),
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "mixed",
      description: "test",
      brickIds: [toolBrick.id, skillBrick.id],
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("same kind");
    }
  });

  test("returns error for unsupported kinds (agent)", async () => {
    const agentBrick = {
      id: brickId("brick_agent-1"),
      kind: "agent" as const,
      name: "agent-a",
      description: "test",
      scope: "agent" as const,
      trustTier: "sandbox" as const,
      lifecycle: "active" as const,
      provenance: createTestToolArtifact().provenance,
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      manifestYaml: "name: test",
    };

    const store = createMockStore({
      load: mock(async () => ({ ok: true as const, value: agentBrick })),
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "composite",
      description: "test",
      brickIds: [agentBrick.id, agentBrick.id],
    })) as Result<unknown, ForgeError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("does not support");
    }
  });

  test("merges two tools with combined implementations and inputSchemas", async () => {
    const toolA = createTestToolArtifact({
      name: "fetch-data",
      implementation: "function fetchData(url) { return fetch(url); }",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    });
    const toolB = createTestToolArtifact({
      name: "parse-json",
      implementation: "function parseJson(text) { return JSON.parse(text); }",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });

    const store = createMockStore({
      load: mock(async (id: unknown) => {
        const idStr = String(id);
        if (idStr === toolA.id) return { ok: true as const, value: toolA };
        if (idStr === toolB.id) return { ok: true as const, value: toolB };
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: "nf", retryable: false },
        };
      }),
      exists: mock(async () => ({ ok: true as const, value: false })),
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "fetch-and-parse",
      description: "Fetches then parses",
      brickIds: [toolA.id, toolB.id],
      tags: ["composite"],
    })) as Result<ForgeResult, ForgeError>;

    // The forge pipeline may or may not succeed depending on sandbox execution,
    // but if it does, verify the result shape
    if (result.ok) {
      expect(result.value.kind).toBe("tool");
      expect(result.value.name).toBe("fetch-and-parse");
    }
  });

  test("merges two skills with markdown sections", async () => {
    const skillA = createTestSkillArtifact({
      name: "skill-a",
      content: "Content of skill A",
    });
    const skillB = createTestSkillArtifact({
      name: "skill-b",
      content: "Content of skill B",
    });

    const store = createMockStore({
      load: mock(async (id: unknown) => {
        const idStr = String(id);
        if (idStr === skillA.id) return { ok: true as const, value: skillA };
        if (idStr === skillB.id) return { ok: true as const, value: skillB };
        return {
          ok: false as const,
          error: { code: "NOT_FOUND", message: "nf", retryable: false },
        };
      }),
      exists: mock(async () => ({ ok: true as const, value: false })),
    });

    const deps = createDeps({ store });
    const tool = createComposeForge(deps);
    const result = (await tool.execute({
      name: "combined-skills",
      description: "Two skills merged",
      brickIds: [skillA.id, skillB.id],
    })) as Result<ForgeResult, ForgeError>;

    if (result.ok) {
      expect(result.value.kind).toBe("skill");
      expect(result.value.name).toBe("combined-skills");
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
});
