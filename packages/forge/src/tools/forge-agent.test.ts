import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult, ManifestParser } from "../types.js";
import { createForgeAgentTool } from "./forge-agent.js";
import type { ForgeDeps } from "./shared.js";

const VALID_MANIFEST_YAML = `
name: my-agent
model: claude-3-5-sonnet
tools:
  - search
  - calculator
`;

function createPassingParser(): ManifestParser {
  return {
    parse: () => ({ ok: true, warnings: [] }),
  };
}

function createFailingParser(error: string): ManifestParser {
  return {
    parse: () => ({ ok: false, error }),
  };
}

function createWarningParser(warnings: readonly string[]): ManifestParser {
  return {
    parse: () => ({ ok: true, warnings }),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: { execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }) },
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    manifestParser: createPassingParser(),
    ...overrides,
  };
}

describe("createForgeAgentTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeAgentTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_agent");
  });

  test("forges an agent and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const tool = createForgeAgentTool(createDeps({ store }));

    const result = (await tool.execute({
      name: "myAgent",
      description: "A test agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("agent");
    expect(result.value.name).toBe("myAgent");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("agent");
      if (loadResult.value.kind === "agent") {
        expect(loadResult.value.manifestYaml).toBe(VALID_MANIFEST_YAML);
      }
    }
  });

  test("returns verification report in result", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({
      name: "myAgent",
      description: "A test agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(4);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({
      name: "myAgent",
      description: "A test agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
    expect(result.value.metadata.depth).toBe(0);
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({
      name: "myAgent",
      description: "A test agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.forgesConsumed).toBe(1);
  });

  // --- Input validation ---

  test("rejects null input with validation error", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({ name: "myAgent" })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("description");
  });

  test("rejects input with wrong field type", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({
      name: 123,
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("INVALID_TYPE");
    expect(result.error.message).toContain("name");
    expect(result.error.message).toContain("string");
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeAgentTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  // --- Manifest parsing ---

  test("returns error when manifest parser is not provided", async () => {
    const { manifestParser: _, ...depsWithoutParser } = createDeps();
    const tool = createForgeAgentTool(depsWithoutParser);
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MANIFEST_PARSE_FAILED");
    expect(result.error.message).toContain("ManifestParser");
  });

  test("returns error when manifest fails to parse", async () => {
    const tool = createForgeAgentTool(
      createDeps({ manifestParser: createFailingParser("Invalid YAML at line 3") }),
    );
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: "invalid: [yaml: broken",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MANIFEST_PARSE_FAILED");
    expect(result.error.message).toContain("Invalid YAML at line 3");
  });

  test("succeeds with parser warnings", async () => {
    const tool = createForgeAgentTool(
      createDeps({ manifestParser: createWarningParser(["deprecated field: foo"]) }),
    );
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("agent");
  });

  test("works with async manifest parser", async () => {
    const asyncParser: ManifestParser = {
      parse: async () => ({ ok: true, warnings: [] }),
    };
    const tool = createForgeAgentTool(createDeps({ manifestParser: asyncParser }));
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("agent");
  });

  // --- Store failure ---

  test("returns store error on save failure", async () => {
    const failingStore = {
      save: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
      load: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      search: async () => ({
        ok: true as const,
        value: [] as readonly import("../types.js").BrickArtifact[],
      }),
      remove: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      update: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
      exists: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "n/a", retryable: false },
      }),
    };

    const tool = createForgeAgentTool(createDeps({ store: failingStore }));
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SAVE_FAILED");
  });

  // --- Governance ---

  test("rejects when forge is disabled", async () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const tool = createForgeAgentTool(createDeps({ config }));
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("FORGE_DISABLED");
  });

  test("rejects at depth 1 (forge_agent not allowed)", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context = { agentId: "agent-1", depth: 1, sessionId: "session-1", forgesThisSession: 0 };
    const tool = createForgeAgentTool(createDeps({ config, context }));
    const result = (await tool.execute({
      name: "myAgent",
      description: "An agent",
      manifestYaml: VALID_MANIFEST_YAML,
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("DEPTH_TOOL_RESTRICTED");
  });
});
