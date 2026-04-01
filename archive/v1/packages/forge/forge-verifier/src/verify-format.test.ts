import { describe, expect, test } from "bun:test";
import type { ForgeInput, FormatConfig } from "@koi/forge-types";
import { verifyFormat } from "./verify-format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISABLED_CONFIG: FormatConfig = {
  enabled: false,
  command: "biome",
  args: ["format", "--write"],
  timeoutMs: 5_000,
};

const ENABLED_CONFIG: FormatConfig = {
  enabled: true,
  command: "biome",
  args: ["format", "--write"],
  timeoutMs: 5_000,
};

const TOOL_INPUT: ForgeInput = {
  kind: "tool",
  name: "test-tool",
  description: "A test tool",
  implementation: "export function run() { return 1 }\n",
} as unknown as ForgeInput;

const SKILL_INPUT: ForgeInput = {
  kind: "skill",
  name: "test-skill",
  description: "A test skill",
} as unknown as ForgeInput;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyFormat", () => {
  test("returns skip when config.enabled is false", async () => {
    const result = await verifyFormat(TOOL_INPUT, DISABLED_CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe("format");
    expect(result.value.passed).toBe(true);
    expect(result.value.message).toContain("disabled");
  });

  test("returns skip for non-implementation kinds", async () => {
    const result = await verifyFormat(SKILL_INPUT, ENABLED_CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe("format");
    expect(result.value.passed).toBe(true);
    expect(result.value.message).toContain("no implementation");
  });

  test("returns skip when formatter binary not found", async () => {
    const config: FormatConfig = {
      enabled: true,
      command: "nonexistent-formatter-binary-xyz-12345",
      args: [],
      timeoutMs: 5_000,
    };
    const result = await verifyFormat(TOOL_INPUT, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe("format");
    expect(result.value.passed).toBe(true);
    expect(result.value.message).toContain("not found");
  });

  test("formats implementation when enabled and binary exists", async () => {
    // Only run if biome is available
    const biome = Bun.which("biome");
    if (biome === null) {
      console.log("Skipping: biome not found");
      return;
    }

    const unformatted: ForgeInput = {
      kind: "tool",
      name: "test-tool",
      description: "A test tool",
      implementation: "export function run(){return    1}\n",
    } as unknown as ForgeInput;

    const result = await verifyFormat(unformatted, ENABLED_CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe("format");
    expect(result.value.passed).toBe(true);
  });

  test("returns error on formatter timeout", async () => {
    // Use bash -c with a long sleep to ensure the process actually hangs
    const config: FormatConfig = {
      enabled: true,
      command: "bash",
      args: ["-c", "sleep 60"],
      timeoutMs: 50,
    };
    const result = await verifyFormat(TOOL_INPUT, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORMAT_TIMEOUT");
  });

  test("returns skip when formatter exits with non-zero code", async () => {
    const config: FormatConfig = {
      enabled: true,
      command: "false", // exits with code 1
      args: [],
      timeoutMs: 5_000,
    };
    const result = await verifyFormat(TOOL_INPUT, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe("format");
    expect(result.value.passed).toBe(true);
    expect(result.value.message).toContain("skipped");
  });
});
