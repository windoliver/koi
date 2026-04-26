import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_PATTERN_NAMES,
  validateToolRecoveryConfig,
} from "./config.js";
import type { ToolCallPattern } from "./types.js";

describe("validateToolRecoveryConfig", () => {
  test("returns empty config when input is undefined", () => {
    const result = validateToolRecoveryConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  test("rejects non-object configs", () => {
    const result = validateToolRecoveryConfig(42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects unknown built-in pattern names", () => {
    const result = validateToolRecoveryConfig({ patterns: ["mistral"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("mistral");
  });

  test("rejects non-array patterns field", () => {
    const result = validateToolRecoveryConfig({ patterns: "hermes" });
    expect(result.ok).toBe(false);
  });

  test("rejects pattern entry that is neither string nor ToolCallPattern", () => {
    const result = validateToolRecoveryConfig({ patterns: [{ wrong: true }] });
    expect(result.ok).toBe(false);
  });

  test("accepts mix of built-in name and custom ToolCallPattern", () => {
    const custom: ToolCallPattern = { name: "x", detect: () => undefined };
    const result = validateToolRecoveryConfig({ patterns: ["hermes", custom] });
    expect(result.ok).toBe(true);
  });

  test("rejects non-positive maxToolCallsPerResponse", () => {
    expect(validateToolRecoveryConfig({ maxToolCallsPerResponse: 0 }).ok).toBe(false);
    expect(validateToolRecoveryConfig({ maxToolCallsPerResponse: -1 }).ok).toBe(false);
    expect(validateToolRecoveryConfig({ maxToolCallsPerResponse: 1.5 }).ok).toBe(false);
    expect(validateToolRecoveryConfig({ maxToolCallsPerResponse: "10" }).ok).toBe(false);
  });

  test("rejects non-function onRecoveryEvent", () => {
    expect(validateToolRecoveryConfig({ onRecoveryEvent: "no" }).ok).toBe(false);
  });

  test("default constants line up with the spec", () => {
    expect(DEFAULT_MAX_TOOL_CALLS).toBe(10);
    // json-fence is intentionally excluded from defaults — it can promote
    // example/quoted JSON into live tool calls. Callers must opt in.
    expect(DEFAULT_PATTERN_NAMES).toEqual(["hermes", "llama31"]);
  });
});
