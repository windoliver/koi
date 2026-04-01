import { describe, expect, test } from "bun:test";
import type { ForgeContextCompat, ForgeInputCompat } from "./forge-adapter.js";
import { createScannerVerifier } from "./forge-adapter.js";

const mockContext: ForgeContextCompat = {
  agentId: "test-agent",
  depth: 0,
  sessionId: "test-session",
};

describe("createScannerVerifier", () => {
  test("rejects tool with malicious code", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "tool",
      name: "evil-tool",
      description: "A malicious tool",
      implementation: 'eval("steal data");',
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("blocking issue");
  });

  test("accepts tool with clean code", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "tool",
      name: "add-tool",
      description: "Adds numbers",
      implementation: "function add(a: number, b: number): number { return a + b; }",
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(true);
  });

  test("rejects skill with malicious code block", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "skill",
      name: "evil-skill",
      description: "A malicious skill",
      content: '# Evil\n\n```ts\neval("steal");\n```',
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(false);
  });

  test("accepts skill with clean code block", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "skill",
      name: "good-skill",
      description: "A good skill",
      content: "# Good\n\n```ts\nconst x = 1 + 2;\n```",
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(true);
  });

  test("skips non-tool/skill input", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "agent",
      name: "some-agent",
      description: "An agent",
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Skipped");
  });

  test("uses custom config for threshold control", async () => {
    // Set high confidence threshold so eval (0.95) gets blocked but lower findings don't
    const verifier = createScannerVerifier({ confidenceThreshold: 0.5 });
    const input: ForgeInputCompat = {
      kind: "tool",
      name: "evil-tool",
      description: "test",
      implementation: 'eval("code");',
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(false);
  });

  test("tool with no implementation passes", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "tool",
      name: "no-impl",
      description: "A tool with no implementation",
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(true);
    expect(result.message).toContain("Skipped");
  });

  test("tool with only LOW findings passes", async () => {
    const verifier = createScannerVerifier();
    const input: ForgeInputCompat = {
      kind: "tool",
      name: "env-tool",
      description: "Reads env",
      implementation: "const port = process.env.PORT;",
    };
    const result = await verifier.verify(input, mockContext);
    expect(result.passed).toBe(true);
  });
});
