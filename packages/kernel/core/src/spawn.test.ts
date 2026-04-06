/**
 * Tests for validateSpawnRequest — L0 pure validation function.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnRequest } from "./spawn.js";
import { validateSpawnRequest } from "./spawn.js";

const baseRequest: SpawnRequest = {
  agentName: "test-agent",
  description: "do something",
  signal: AbortSignal.timeout(5000),
};

describe("validateSpawnRequest", () => {
  test("returns ok for a valid request with no tool lists", () => {
    const result = validateSpawnRequest(baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(baseRequest);
  });

  test("returns ok when only toolDenylist is set", () => {
    const result = validateSpawnRequest({ ...baseRequest, toolDenylist: ["ToolA", "ToolB"] });
    expect(result.ok).toBe(true);
  });

  test("returns ok when only toolAllowlist is set", () => {
    const result = validateSpawnRequest({ ...baseRequest, toolAllowlist: ["ToolA", "ToolB"] });
    expect(result.ok).toBe(true);
  });

  test("returns ok when both lists are undefined", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      toolAllowlist: undefined,
      toolDenylist: undefined,
    });
    expect(result.ok).toBe(true);
  });

  test("returns VALIDATION error when both toolAllowlist and toolDenylist are set", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      toolAllowlist: ["ToolA"],
      toolDenylist: ["ToolB"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("error message explains the conflict and what to do", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      toolAllowlist: ["ToolA"],
      toolDenylist: ["ToolB"],
    });
    if (!result.ok) {
      expect(result.error.message).toContain("mutually exclusive");
      expect(result.error.message).toContain("Remove one of the two fields");
    }
  });

  test("error message explains both fields by name", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      toolAllowlist: ["ToolA"],
      toolDenylist: ["ToolB"],
    });
    if (!result.ok) {
      expect(result.error.message).toContain("toolAllowlist");
      expect(result.error.message).toContain("toolDenylist");
    }
  });

  test("returns ok for a request with all optional fields set (except both lists)", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      toolDenylist: ["BannedTool"],
      maxTurns: 10,
      maxTokens: 5000,
      nonInteractive: true,
      systemPrompt: "Be concise.",
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // fork validation (Decision 1-A / 6-A)
  // ---------------------------------------------------------------------------

  test("returns ok for fork=true with no tool lists", () => {
    const result = validateSpawnRequest({ ...baseRequest, fork: true });
    expect(result.ok).toBe(true);
  });

  test("returns ok for fork=true with toolDenylist (further restriction is valid)", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      fork: true,
      toolDenylist: ["shell_exec"],
    });
    expect(result.ok).toBe(true);
  });

  test("returns VALIDATION error for fork=true with toolAllowlist (contradictory)", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      fork: true,
      toolAllowlist: ["task_list"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("fork");
      expect(result.error.message).toContain("toolAllowlist");
    }
  });

  test("fork+toolAllowlist error message explains the fix", () => {
    const result = validateSpawnRequest({
      ...baseRequest,
      fork: true,
      toolAllowlist: ["task_list"],
    });
    if (!result.ok) {
      expect(result.error.message).toContain("toolDenylist");
    }
  });
});
