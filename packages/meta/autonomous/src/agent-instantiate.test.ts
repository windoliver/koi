/**
 * Tests for createAgentFromBrick — agent instantiation from forge artifacts.
 */

import { describe, expect, it, mock } from "bun:test";
import type { BrickArtifact, ComponentProvider, EngineAdapter, KoiMiddleware } from "@koi/core";
import type { MiddlewareRegistry } from "@koi/starter";
import { createTestAgentArtifact, createTestToolArtifact } from "@koi/test-utils";

import { createAgentFromBrick } from "./agent-instantiate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_YAML = `name: "test-agent"\nversion: "0.0.1"\nmodel: "mock-model"`;
const YAML_WITH_MIDDLEWARE = `name: "test-agent"\nversion: "0.0.1"\nmodel: "mock-model"\nmiddleware:\n  - name: "context-arena"`;
const INVALID_YAML = "not: valid: yaml: {{";

function mockAdapter(): EngineAdapter {
  return {
    engineId: "test-engine",
    capabilities: { supportsStreaming: true, supportsCheckpointing: false },
    stream: async function* () {
      yield { kind: "done" as const, reason: "complete" };
    },
  } as unknown as EngineAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentFromBrick", () => {
  it("returns result with parsed manifest and adapter for valid agent brick", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: VALID_YAML });
    const adapter = mockAdapter();
    const adapterFactory = mock(async () => adapter);

    const result = await createAgentFromBrick(brick, { adapterFactory });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("test-agent");
      expect(result.value.adapter).toBe(adapter);
      expect(result.value.brickId).toBe(brick.id);
      expect(result.value.middleware).toEqual([]);
      expect(result.value.providers).toEqual([]);
    }
    expect(adapterFactory).toHaveBeenCalledTimes(1);
  });

  it("returns VALIDATION error for non-agent brick", async () => {
    const toolBrick: BrickArtifact = createTestToolArtifact({ name: "not-an-agent" });
    const adapterFactory = mock(async () => mockAdapter());

    const result = await createAgentFromBrick(toolBrick, { adapterFactory });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("not an agent brick");
    }
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("returns VALIDATION error for invalid manifest YAML", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: INVALID_YAML });
    const adapterFactory = mock(async () => mockAdapter());

    const result = await createAgentFromBrick(brick, { adapterFactory });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Failed to parse manifest");
    }
  });

  it("returns EXTERNAL error when adapter factory throws", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: VALID_YAML });
    const adapterFactory = mock(async () => {
      throw new Error("adapter creation failed");
    });

    const result = await createAgentFromBrick(brick, { adapterFactory });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("adapter creation failed");
    }
  });

  it("passes provided middleware and providers through", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: VALID_YAML });
    const middleware = [{ name: "test-mw", priority: 100 }] as unknown as readonly KoiMiddleware[];
    const providers = [
      { name: "test-provider", attach: mock(() => {}) },
    ] as unknown as readonly ComponentProvider[];

    const result = await createAgentFromBrick(brick, {
      adapterFactory: async () => mockAdapter(),
      middleware,
      providers,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.middleware).toHaveLength(1);
      expect(result.value.providers).toHaveLength(1);
    }
  });

  it("resolves manifest middleware when registry provided", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: YAML_WITH_MIDDLEWARE });
    const resolvedMw = { name: "context-arena", priority: 500 } as unknown as KoiMiddleware;
    const registry: MiddlewareRegistry = {
      get: (name: string) => (name === "context-arena" ? async () => resolvedMw : undefined),
      names: () => ["context-arena"],
    };

    const result = await createAgentFromBrick(brick, {
      adapterFactory: async () => mockAdapter(),
      middlewareRegistry: registry,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.middleware).toHaveLength(1);
      expect(result.value.middleware[0]).toBe(resolvedMw);
    }
  });

  it("merges manifest + explicit middleware", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: YAML_WITH_MIDDLEWARE });
    const manifestMw = { name: "context-arena", priority: 500 } as unknown as KoiMiddleware;
    const explicitMw = { name: "test-mw", priority: 100 } as unknown as KoiMiddleware;
    const registry: MiddlewareRegistry = {
      get: (name: string) => (name === "context-arena" ? async () => manifestMw : undefined),
      names: () => ["context-arena"],
    };

    const result = await createAgentFromBrick(brick, {
      adapterFactory: async () => mockAdapter(),
      middlewareRegistry: registry,
      middleware: [explicitMw],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Manifest middleware comes first, then explicit
      expect(result.value.middleware).toHaveLength(2);
      expect(result.value.middleware[0]).toBe(manifestMw);
      expect(result.value.middleware[1]).toBe(explicitMw);
    }
  });

  it("works without registry (backward compatible)", async () => {
    const brick = createTestAgentArtifact({ manifestYaml: YAML_WITH_MIDDLEWARE });

    const result = await createAgentFromBrick(brick, {
      adapterFactory: async () => mockAdapter(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // No registry → no manifest middleware resolved
      expect(result.value.middleware).toEqual([]);
    }
  });
});
