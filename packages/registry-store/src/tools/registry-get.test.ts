import { describe, expect, test } from "bun:test";
import type { BrickArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createRegistryGetTool } from "./registry-get.js";
import { createMockFacade } from "./test-helpers.js";

const TOOL_ARTIFACT: BrickArtifact = {
  id: brickId("brick_get-test"),
  kind: "tool",
  name: "get-test",
  description: "A test tool",
  scope: "agent",
  trustTier: "sandbox",
  lifecycle: "active",
  provenance: DEFAULT_PROVENANCE,
  version: "1.0.0",
  tags: ["test"],
  usageCount: 3,
  implementation: "return 1;",
  inputSchema: { type: "object" },
};

describe("registry_get tool", () => {
  test("returns NOT_FOUND for missing brick", async () => {
    const facade = createMockFacade();
    const tool = createRegistryGetTool(facade, "registry", "verified");

    const result = (await tool.execute({ kind: "tool", name: "missing" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("NOT_FOUND");
  });

  test("returns summary by default (omits implementation)", async () => {
    const facade = createMockFacade({
      bricks: {
        get: () => ({ ok: true, value: TOOL_ARTIFACT }),
      },
    });
    const tool = createRegistryGetTool(facade, "registry", "verified");

    const result = (await tool.execute({ kind: "tool", name: "get-test" })) as Record<
      string,
      unknown
    >;
    expect(result.name).toBe("get-test");
    expect(result.implementation).toBeUndefined();
    expect(result.inputSchema).toBeUndefined();
    expect(result.provenance).toBeUndefined();
  });

  test("returns full details when detail=full", async () => {
    const facade = createMockFacade({
      bricks: {
        get: () => ({ ok: true, value: TOOL_ARTIFACT }),
      },
    });
    const tool = createRegistryGetTool(facade, "registry", "verified");

    const result = (await tool.execute({
      kind: "tool",
      name: "get-test",
      detail: "full",
    })) as Record<string, unknown>;
    expect(result.name).toBe("get-test");
    expect(result.implementation).toBe("return 1;");
    expect(result.inputSchema).toEqual({ type: "object" });
  });

  test("returns validation error for missing name", async () => {
    const facade = createMockFacade();
    const tool = createRegistryGetTool(facade, "registry", "verified");

    const result = (await tool.execute({ kind: "tool" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid kind", async () => {
    const facade = createMockFacade();
    const tool = createRegistryGetTool(facade, "registry", "verified");

    const result = (await tool.execute({ kind: "invalid", name: "test" })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("VALIDATION");
  });
});
