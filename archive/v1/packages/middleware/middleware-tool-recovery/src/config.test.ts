import { describe, expect, test } from "bun:test";
import { validateToolRecoveryConfig } from "./config.js";

describe("validateToolRecoveryConfig", () => {
  test("accepts empty config object", () => {
    const result = validateToolRecoveryConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects non-object config", () => {
    const result = validateToolRecoveryConfig("bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  test("rejects null config", () => {
    const result = validateToolRecoveryConfig(null);
    expect(result.ok).toBe(false);
  });

  test("accepts valid built-in pattern names", () => {
    const result = validateToolRecoveryConfig({ patterns: ["hermes", "llama31", "json-fence"] });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown pattern name", () => {
    const result = validateToolRecoveryConfig({ patterns: ["hermes", "unknown-pattern"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("unknown-pattern");
  });

  test("accepts custom ToolCallPattern objects", () => {
    const custom = { name: "custom", detect: () => undefined };
    const result = validateToolRecoveryConfig({ patterns: [custom] });
    expect(result.ok).toBe(true);
  });

  test("accepts mixed string and custom patterns", () => {
    const custom = { name: "custom", detect: () => undefined };
    const result = validateToolRecoveryConfig({ patterns: ["hermes", custom] });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid pattern entry", () => {
    const result = validateToolRecoveryConfig({ patterns: [42] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ToolCallPattern");
  });

  test("rejects patterns that is not an array", () => {
    const result = validateToolRecoveryConfig({ patterns: "hermes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("array");
  });

  test("accepts valid maxToolCallsPerResponse", () => {
    const result = validateToolRecoveryConfig({ maxToolCallsPerResponse: 5 });
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxToolCallsPerResponse", () => {
    const result = validateToolRecoveryConfig({ maxToolCallsPerResponse: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("positive integer");
  });

  test("rejects negative maxToolCallsPerResponse", () => {
    const result = validateToolRecoveryConfig({ maxToolCallsPerResponse: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer maxToolCallsPerResponse", () => {
    const result = validateToolRecoveryConfig({ maxToolCallsPerResponse: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function onRecoveryEvent", () => {
    const result = validateToolRecoveryConfig({ onRecoveryEvent: "not a function" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("function");
  });

  test("accepts function onRecoveryEvent", () => {
    const result = validateToolRecoveryConfig({ onRecoveryEvent: () => {} });
    expect(result.ok).toBe(true);
  });
});
