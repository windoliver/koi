import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, JsonObject, SandboxExecutor, ToolArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { brickCapabilityFragment, brickToTool } from "./brick-conversion.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId("brick_test"),
    kind: "tool",
    name: "calc",
    description: "A simple calculator tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return input.a + input.b;",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    ...overrides,
  };
}

function createMockExecutor(
  result:
    | { ok: true; value: { output: unknown } }
    | { ok: false; error: { code: string; message: string } },
): SandboxExecutor {
  return {
    execute: mock(async (_code: string, _input: JsonObject, _timeoutMs: number) => result),
  };
}

// ---------------------------------------------------------------------------
// brickToTool
// ---------------------------------------------------------------------------

describe("brickToTool", () => {
  test("creates tool with correct descriptor from brick", () => {
    const brick = createToolBrick({ name: "adder", description: "Adds numbers" });
    const executor = createMockExecutor({ ok: true, value: { output: 3 } });

    const tool = brickToTool(brick, executor);

    expect(tool.descriptor.name).toBe("adder");
    expect(tool.descriptor.description).toBe("Adds numbers");
    expect(tool.descriptor.inputSchema).toEqual(brick.inputSchema);
    expect(tool.trustTier).toBe("sandbox");
  });

  test("execute delegates to sandbox executor on success", async () => {
    const brick = createToolBrick();
    const executor = createMockExecutor({ ok: true, value: { output: 42 } });

    const tool = brickToTool(brick, executor);
    const result = await tool.execute({ a: 1, b: 2 });

    expect(result).toBe(42);
    expect(executor.execute).toHaveBeenCalledWith(brick.implementation, { a: 1, b: 2 }, 5_000);
  });

  test("execute returns error object when sandbox fails", async () => {
    const brick = createToolBrick({ name: "fail_tool" });
    const executor = createMockExecutor({
      ok: false,
      error: { code: "TIMEOUT", message: "execution timed out" },
    });

    const tool = brickToTool(brick, executor);
    const result = await tool.execute({});

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TIMEOUT",
        message: 'Forged tool "fail_tool" failed: execution timed out',
      },
    });
  });

  test("respects custom timeout", async () => {
    const brick = createToolBrick();
    const executor = createMockExecutor({ ok: true, value: { output: 0 } });

    const tool = brickToTool(brick, executor, 10_000);
    await tool.execute({});

    expect(executor.execute).toHaveBeenCalledWith(brick.implementation, {}, 10_000);
  });
});

// ---------------------------------------------------------------------------
// brickCapabilityFragment
// ---------------------------------------------------------------------------

describe("brickCapabilityFragment", () => {
  test("returns label and description from BrickArtifact", () => {
    const brick = createToolBrick({
      name: "my-tool",
      description: "Does something useful",
    });

    const fragment = brickCapabilityFragment(brick);

    expect(fragment.label).toBe("my-tool");
    expect(fragment.description).toBe("Does something useful");
  });

  test("works with non-tool BrickArtifact kinds", () => {
    const middlewareBrick: BrickArtifact = {
      id: brickId("brick_mw"),
      kind: "middleware",
      name: "rate-limiter",
      description: "Rate limiting middleware",
      scope: "agent",
      trustTier: "verified",
      lifecycle: "active",
      provenance: DEFAULT_PROVENANCE,
      version: "1.0.0",
      tags: [],
      usageCount: 5,
      implementation: "/* middleware impl */",
    };

    const fragment = brickCapabilityFragment(middlewareBrick);

    expect(fragment.label).toBe("rate-limiter");
    expect(fragment.description).toBe("Rate limiting middleware");
  });
});
