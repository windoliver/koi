/**
 * Tests for brick-conversion — trust-tier dispatch and workspace path handling.
 */

import { describe, expect, test } from "bun:test";
import type { ExecutionContext, SandboxExecutor, ToolArtifact } from "@koi/core";
import { brickToTool } from "./brick-conversion.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: "sha256:0000000000000000000000000000000000000000000000000000000000000001" as ToolArtifact["id"],
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: {} as ToolArtifact["provenance"],
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    implementation: "return input;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function makeMockExecutor(
  handler: (
    code: string,
    input: unknown,
    timeoutMs: number,
    context?: ExecutionContext,
  ) => Promise<
    | {
        readonly ok: true;
        readonly value: { readonly output: unknown; readonly durationMs: number };
      }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: "CRASH";
          readonly message: string;
          readonly durationMs: number;
        };
      }
  >,
): SandboxExecutor {
  return { execute: handler };
}

// ---------------------------------------------------------------------------
// Basic conversion
// ---------------------------------------------------------------------------

describe("brickToTool", () => {
  test("creates tool with correct descriptor", () => {
    const artifact = makeArtifact({ name: "my-tool", description: "Does stuff" });
    const executor = makeMockExecutor(async () => ({
      ok: true,
      value: { output: 42, durationMs: 1 },
    }));

    const tool = brickToTool(artifact, executor);

    expect(tool.descriptor.name).toBe("my-tool");
    expect(tool.descriptor.description).toBe("Does stuff");
    expect(tool.trustTier).toBe("sandbox");
  });

  test("executes without workspace path (new Function fallback)", async () => {
    // let justified: capturedContext tracks what the executor received
    let capturedContext: ExecutionContext | undefined;
    const executor = makeMockExecutor(async (_code, _input, _timeout, ctx) => {
      capturedContext = ctx;
      return { ok: true, value: { output: "result", durationMs: 1 } };
    });

    const tool = brickToTool(makeArtifact(), executor);
    const result = await tool.execute({});

    expect(result).toBe("result");
    expect(capturedContext).toBeUndefined();
  });

  test("passes workspace path via ExecutionContext when provided", async () => {
    // let justified: capturedContext tracks what the executor received
    let capturedContext: ExecutionContext | undefined;
    const executor = makeMockExecutor(async (_code, _input, _timeout, ctx) => {
      capturedContext = ctx;
      return { ok: true, value: { output: "with-deps", durationMs: 1 } };
    });

    const tool = brickToTool(
      makeArtifact(),
      executor,
      5_000,
      "/tmp/workspace",
      "/tmp/workspace/entry.ts",
    );
    const result = await tool.execute({});

    expect(result).toBe("with-deps");
    expect(capturedContext).toBeDefined();
    expect(capturedContext?.workspacePath).toBe("/tmp/workspace");
    expect(capturedContext?.entryPath).toBe("/tmp/workspace/entry.ts");
  });

  test("returns error result when executor fails", async () => {
    const executor = makeMockExecutor(async () => ({
      ok: false,
      error: { code: "CRASH", message: "boom", durationMs: 1 },
    }));

    const tool = brickToTool(makeArtifact({ name: "fail-tool" }), executor);
    const result = (await tool.execute({})) as {
      readonly ok: false;
      readonly error: { readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("fail-tool");
    expect(result.error.message).toContain("boom");
  });

  test("uses custom timeout", async () => {
    // let justified: capturedTimeout tracks what the executor received
    let capturedTimeout = 0;
    const executor = makeMockExecutor(async (_code, _input, timeout) => {
      capturedTimeout = timeout;
      return { ok: true, value: { output: null, durationMs: 1 } };
    });

    const tool = brickToTool(makeArtifact(), executor, 10_000);
    await tool.execute({});

    expect(capturedTimeout).toBe(10_000);
  });
});
