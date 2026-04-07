/**
 * Cache fingerprint tests — deterministic hash of system prompt + tool names
 * for prompt-cache diagnostics (#1554).
 */

import { describe, expect, test } from "bun:test";
import { computeStringHash } from "@koi/hash";

/**
 * Mirror of the adapter-internal computeCacheFingerprint function.
 * Kept in sync to validate the fingerprint contract without importing
 * private adapter internals.
 */
function computeCacheFingerprint(
  systemPrompt: string | undefined,
  toolNames: readonly string[] | undefined,
): string {
  const input = (systemPrompt ?? "") + "\0" + (toolNames ?? []).join("\0");
  return computeStringHash(input);
}

describe("computeCacheFingerprint", () => {
  test("is deterministic for identical inputs", () => {
    const a = computeCacheFingerprint("You are helpful", ["tool_a", "tool_b"]);
    const b = computeCacheFingerprint("You are helpful", ["tool_a", "tool_b"]);
    expect(a).toBe(b);
  });

  test("changes when tool names differ", () => {
    const a = computeCacheFingerprint("prompt", ["tool_a", "tool_b"]);
    const b = computeCacheFingerprint("prompt", ["tool_a", "tool_c"]);
    expect(a).not.toBe(b);
  });

  test("changes when systemPrompt differs", () => {
    const a = computeCacheFingerprint("prompt A", ["tool"]);
    const b = computeCacheFingerprint("prompt B", ["tool"]);
    expect(a).not.toBe(b);
  });

  test("changes when tool order differs", () => {
    const a = computeCacheFingerprint("prompt", ["a", "b"]);
    const b = computeCacheFingerprint("prompt", ["b", "a"]);
    expect(a).not.toBe(b);
  });

  test("handles undefined systemPrompt", () => {
    const a = computeCacheFingerprint(undefined, ["tool"]);
    const b = computeCacheFingerprint(undefined, ["tool"]);
    expect(a).toBe(b);
  });

  test("handles undefined toolNames", () => {
    const a = computeCacheFingerprint("prompt", undefined);
    const b = computeCacheFingerprint("prompt", undefined);
    expect(a).toBe(b);
  });

  test("returns a 64-character hex string (SHA-256)", () => {
    const hash = computeCacheFingerprint("test", ["tool"]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
