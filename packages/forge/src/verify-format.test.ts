/**
 * Tests for the format verification stage (1.25).
 */

import { describe, expect, test } from "bun:test";
import type { FormatConfig } from "./config.js";
import type { ForgeInput } from "./types.js";
import { verifyFormat } from "./verify-format.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_FORMAT_CONFIG: FormatConfig = {
  enabled: true,
  command: "biome",
  args: ["format", "--write"],
  timeoutMs: 5_000,
};

const DISABLED_FORMAT_CONFIG: FormatConfig = {
  ...DEFAULT_FORMAT_CONFIG,
  enabled: false,
};

const validToolInput: ForgeInput = {
  kind: "tool",
  name: "myTool",
  description: "A test tool",
  inputSchema: { type: "object" },
  implementation: "function run(input) { return input; }",
};

const skillInput: ForgeInput = {
  kind: "skill",
  name: "mySkill",
  description: "A test skill",
  body: "# Skill content",
};

const agentInput: ForgeInput = {
  kind: "agent",
  name: "myAgent",
  description: "A test agent",
  manifestYaml: "name: myAgent",
};

const middlewareInput: ForgeInput = {
  kind: "middleware",
  name: "myMiddleware",
  description: "A test middleware",
  implementation: "function run(ctx) { return ctx; }",
};

const channelInput: ForgeInput = {
  kind: "channel",
  name: "myChannel",
  description: "A test channel",
  implementation: "function send(msg) { return msg; }",
};

// ---------------------------------------------------------------------------
// Disabled config
// ---------------------------------------------------------------------------

describe("verifyFormat — disabled config", () => {
  test("skips immediately when disabled", async () => {
    const result = await verifyFormat(validToolInput, DISABLED_FORMAT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("format");
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("disabled");
      expect(result.value.formattedImplementation).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-implementation kinds
// ---------------------------------------------------------------------------

describe("verifyFormat — non-implementation kinds", () => {
  test("skips skill kind", async () => {
    const result = await verifyFormat(skillInput, DEFAULT_FORMAT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("format");
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("skill");
      expect(result.value.formattedImplementation).toBeUndefined();
    }
  });

  test("skips agent kind", async () => {
    const result = await verifyFormat(agentInput, DEFAULT_FORMAT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("format");
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("agent");
      expect(result.value.formattedImplementation).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Formatter not found
// ---------------------------------------------------------------------------

describe("verifyFormat — formatter not found", () => {
  test("skips gracefully when formatter binary not found", async () => {
    const config: FormatConfig = {
      ...DEFAULT_FORMAT_CONFIG,
      command: "nonexistent-formatter-binary-xyz",
    };
    const result = await verifyFormat(validToolInput, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("format");
      expect(result.value.passed).toBe(true);
      expect(result.value.message).toContain("not found");
      expect(result.value.formattedImplementation).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Implementation kinds are accepted
// ---------------------------------------------------------------------------

describe("verifyFormat — implementation kinds accepted", () => {
  test("processes tool kind", async () => {
    // Uses a non-existent formatter so it skips, but confirms it gets past the kind check
    const config: FormatConfig = {
      ...DEFAULT_FORMAT_CONFIG,
      command: "nonexistent-formatter-binary-xyz",
    };
    const result = await verifyFormat(validToolInput, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // If kind check passed, it reaches the binary check
      expect(result.value.message).toContain("not found");
    }
  });

  test("processes middleware kind", async () => {
    const config: FormatConfig = {
      ...DEFAULT_FORMAT_CONFIG,
      command: "nonexistent-formatter-binary-xyz",
    };
    const result = await verifyFormat(middlewareInput, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toContain("not found");
    }
  });

  test("processes channel kind", async () => {
    const config: FormatConfig = {
      ...DEFAULT_FORMAT_CONFIG,
      command: "nonexistent-formatter-binary-xyz",
    };
    const result = await verifyFormat(channelInput, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toContain("not found");
    }
  });
});

// ---------------------------------------------------------------------------
// Stage report structure
// ---------------------------------------------------------------------------

describe("verifyFormat — report structure", () => {
  test("report has correct stage name", async () => {
    const result = await verifyFormat(validToolInput, DISABLED_FORMAT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("format");
    }
  });

  test("report includes non-negative durationMs", async () => {
    const result = await verifyFormat(validToolInput, DISABLED_FORMAT_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
