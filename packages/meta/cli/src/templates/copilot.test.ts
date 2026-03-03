import { describe, expect, test } from "bun:test";
import type { WizardState } from "../wizard/state.js";
import { generateCopilot } from "./copilot.js";

const STATE: WizardState = {
  template: "copilot",
  name: "my-copilot",
  description: "A copilot agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: "deepagents",
  channels: ["telegram", "slack"],
  directory: "my-copilot",
};

describe("generateCopilot", () => {
  test("generates koi.yaml", () => {
    const files = generateCopilot(STATE);
    expect(files["koi.yaml"]).toBeDefined();
  });

  test("generates package.json", () => {
    const files = generateCopilot(STATE);
    expect(files["package.json"]).toBeDefined();
  });

  test("generates tsconfig.json", () => {
    const files = generateCopilot(STATE);
    expect(files["tsconfig.json"]).toBeDefined();
  });

  test("generates README.md", () => {
    const files = generateCopilot(STATE);
    expect(files["README.md"]).toBeDefined();
  });

  test("generates example tool", () => {
    const files = generateCopilot(STATE);
    expect(files["src/tools/hello.ts"]).toBeDefined();
  });

  test("example tool exports a function", () => {
    const files = generateCopilot(STATE);
    expect(files["src/tools/hello.ts"]).toContain("export");
  });

  test("koi.yaml includes channels", () => {
    const files = generateCopilot(STATE);
    const yaml = files["koi.yaml"] as string;
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("telegram");
    expect(yaml).toContain("slack");
  });

  test("generates more files than minimal", () => {
    const files = generateCopilot(STATE);
    expect(Object.keys(files).length).toBeGreaterThan(4);
  });

  test("escapes backticks in agent name for generated code", () => {
    const state: WizardState = { ...STATE, name: "agent`test" };
    const files = generateCopilot(state);
    const tool = files["src/tools/hello.ts"] as string;
    // The generated code should not have an unescaped backtick
    expect(tool).toContain("agent\\`test");
    // Verify it's valid by checking no syntax-breaking backticks
    expect(tool).not.toContain("agent`test");
  });

  test("escapes template interpolation in agent name for generated code", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing escape of literal ${} in names
    const state: WizardState = { ...STATE, name: "agent${evil}" };
    const files = generateCopilot(state);
    const tool = files["src/tools/hello.ts"] as string;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing escaped output
    expect(tool).toContain("agent\\${evil}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing unescaped NOT present
    expect(tool).not.toContain("agent${evil}");
  });

  test("escapes backslashes in agent name for generated code", () => {
    const state: WizardState = { ...STATE, name: "agent\\path" };
    const files = generateCopilot(state);
    const tool = files["src/tools/hello.ts"] as string;
    expect(tool).toContain("agent\\\\path");
  });
});
