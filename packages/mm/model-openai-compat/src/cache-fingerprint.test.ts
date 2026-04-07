/**
 * Prompt prefix fingerprint tests — deterministic hash of system prompt + sorted
 * tool payload for detecting unexpected prefix drift (#1554).
 */

import { describe, expect, test } from "bun:test";
import { computeStringHash } from "@koi/hash";
import type { ChatCompletionTool } from "./types.js";

/**
 * Mirror of the adapter-internal computePrefixFingerprint function.
 * Kept in sync to validate the fingerprint contract without importing
 * private adapter internals.
 */
function computePrefixFingerprint(
  systemPrompt: string | undefined,
  tools: readonly ChatCompletionTool[] | undefined,
): string {
  const toolPart = tools !== undefined ? JSON.stringify(tools) : "";
  const input = `${systemPrompt ?? ""}\0${toolPart}`;
  return computeStringHash(input);
}

function tool(
  name: string,
  description = "desc",
  params: Record<string, unknown> = { type: "object" },
): ChatCompletionTool {
  return { type: "function", function: { name, description, parameters: params } };
}

describe("computePrefixFingerprint", () => {
  test("is deterministic for identical inputs", () => {
    const tools = [tool("tool_a"), tool("tool_b")];
    const a = computePrefixFingerprint("You are helpful", tools);
    const b = computePrefixFingerprint("You are helpful", tools);
    expect(a).toBe(b);
  });

  test("changes when tool names differ", () => {
    const a = computePrefixFingerprint("prompt", [tool("tool_a"), tool("tool_b")]);
    const b = computePrefixFingerprint("prompt", [tool("tool_a"), tool("tool_c")]);
    expect(a).not.toBe(b);
  });

  test("changes when tool description differs", () => {
    const a = computePrefixFingerprint("prompt", [tool("t", "description A")]);
    const b = computePrefixFingerprint("prompt", [tool("t", "description B")]);
    expect(a).not.toBe(b);
  });

  test("changes when tool schema differs", () => {
    const a = computePrefixFingerprint("prompt", [tool("t", "d", { type: "object" })]);
    const b = computePrefixFingerprint("prompt", [
      tool("t", "d", { type: "object", properties: { x: { type: "string" } } }),
    ]);
    expect(a).not.toBe(b);
  });

  test("changes when systemPrompt differs", () => {
    const tools = [tool("t")];
    const a = computePrefixFingerprint("prompt A", tools);
    const b = computePrefixFingerprint("prompt B", tools);
    expect(a).not.toBe(b);
  });

  test("same tools in same order produce same fingerprint", () => {
    const a = computePrefixFingerprint("prompt", [tool("a"), tool("b")]);
    const b = computePrefixFingerprint("prompt", [tool("a"), tool("b")]);
    expect(a).toBe(b);
  });

  test("different tool order produces different fingerprint", () => {
    const a = computePrefixFingerprint("prompt", [tool("a"), tool("b")]);
    const b = computePrefixFingerprint("prompt", [tool("b"), tool("a")]);
    expect(a).not.toBe(b);
  });

  test("handles undefined systemPrompt", () => {
    const tools = [tool("t")];
    const a = computePrefixFingerprint(undefined, tools);
    const b = computePrefixFingerprint(undefined, tools);
    expect(a).toBe(b);
  });

  test("handles undefined tools", () => {
    const a = computePrefixFingerprint("prompt", undefined);
    const b = computePrefixFingerprint("prompt", undefined);
    expect(a).toBe(b);
  });

  test("returns a 64-character hex string (SHA-256)", () => {
    const hash = computePrefixFingerprint("test", [tool("t")]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
