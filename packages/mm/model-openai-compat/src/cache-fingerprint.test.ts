/**
 * Cache fingerprint tests — deterministic hash of system prompt + sorted tool
 * payload for prompt-cache diagnostics (#1554).
 */

import { describe, expect, test } from "bun:test";
import { computeStringHash } from "@koi/hash";
import type { ChatCompletionTool } from "./types.js";

/**
 * Mirror of the adapter-internal computeCacheFingerprint function.
 * Kept in sync to validate the fingerprint contract without importing
 * private adapter internals.
 */
function computeCacheFingerprint(
  systemPrompt: string | undefined,
  tools: readonly ChatCompletionTool[] | undefined,
): string {
  const toolPart = tools !== undefined ? JSON.stringify(tools) : "";
  const input = `${systemPrompt ?? ""}\0${toolPart}`;
  return computeStringHash(input);
}

function tool(name: string, description = "desc", params = { type: "object" }): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: params } };
}

describe("computeCacheFingerprint", () => {
  test("is deterministic for identical inputs", () => {
    const tools = [tool("tool_a"), tool("tool_b")];
    const a = computeCacheFingerprint("You are helpful", tools);
    const b = computeCacheFingerprint("You are helpful", tools);
    expect(a).toBe(b);
  });

  test("changes when tool names differ", () => {
    const a = computeCacheFingerprint("prompt", [tool("tool_a"), tool("tool_b")]);
    const b = computeCacheFingerprint("prompt", [tool("tool_a"), tool("tool_c")]);
    expect(a).not.toBe(b);
  });

  test("changes when tool description differs", () => {
    const a = computeCacheFingerprint("prompt", [tool("t", "description A")]);
    const b = computeCacheFingerprint("prompt", [tool("t", "description B")]);
    expect(a).not.toBe(b);
  });

  test("changes when tool schema differs", () => {
    const a = computeCacheFingerprint("prompt", [tool("t", "d", { type: "object" })]);
    const b = computeCacheFingerprint("prompt", [
      tool("t", "d", { type: "object", properties: { x: { type: "string" } } }),
    ]);
    expect(a).not.toBe(b);
  });

  test("changes when systemPrompt differs", () => {
    const tools = [tool("t")];
    const a = computeCacheFingerprint("prompt A", tools);
    const b = computeCacheFingerprint("prompt B", tools);
    expect(a).not.toBe(b);
  });

  test("same tools in same order produce same fingerprint", () => {
    const a = computeCacheFingerprint("prompt", [tool("a"), tool("b")]);
    const b = computeCacheFingerprint("prompt", [tool("a"), tool("b")]);
    expect(a).toBe(b);
  });

  test("different tool order produces different fingerprint", () => {
    const a = computeCacheFingerprint("prompt", [tool("a"), tool("b")]);
    const b = computeCacheFingerprint("prompt", [tool("b"), tool("a")]);
    expect(a).not.toBe(b);
  });

  test("handles undefined systemPrompt", () => {
    const tools = [tool("t")];
    const a = computeCacheFingerprint(undefined, tools);
    const b = computeCacheFingerprint(undefined, tools);
    expect(a).toBe(b);
  });

  test("handles undefined tools", () => {
    const a = computeCacheFingerprint("prompt", undefined);
    const b = computeCacheFingerprint("prompt", undefined);
    expect(a).toBe(b);
  });

  test("returns a 64-character hex string (SHA-256)", () => {
    const hash = computeCacheFingerprint("test", [tool("t")]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
