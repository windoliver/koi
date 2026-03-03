import { describe, expect, test } from "bun:test";
import type { WizardState } from "../wizard/state.js";
import {
  generateManifestYaml,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
} from "./shared.js";

const STATE: WizardState = {
  template: "minimal",
  name: "test-agent",
  description: "A test agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: "loop",
  channels: ["cli"],
  directory: "test-agent",
};

describe("generateManifestYaml", () => {
  test("includes name and version", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("name: test-agent");
    expect(yaml).toContain("version: 0.1.0");
  });

  test("includes description", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("description: A test agent");
  });

  test("includes model as string shorthand", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain('model: "anthropic:claude-sonnet-4-5-20250929"');
  });

  test("includes engine", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("engine: loop");
  });

  test("includes channels for copilot", () => {
    const copilotState: WizardState = {
      ...STATE,
      template: "copilot",
      channels: ["telegram", "slack"],
    };
    const yaml = generateManifestYaml(copilotState);
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("telegram");
    expect(yaml).toContain("slack");
  });

  test("omits channels section for minimal with only cli", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).not.toContain("channels:");
  });

  test("quotes model string containing colons", () => {
    const yaml = generateManifestYaml(STATE);
    // Model strings contain colons and must be quoted
    expect(yaml).toMatch(/model:\s+"[^"]+"/);
  });
});

describe("generatePackageJson", () => {
  test("includes correct name", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.name).toBe("test-agent");
  });

  test("sets type to module", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.type).toBe("module");
  });

  test("includes scripts", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.scripts.dev).toBeDefined();
  });

  test("output is valid JSON", () => {
    expect(() => JSON.parse(generatePackageJson(STATE))).not.toThrow();
  });
});

describe("generateTsconfig", () => {
  test("output is valid JSON", () => {
    expect(() => JSON.parse(generateTsconfig())).not.toThrow();
  });

  test("has strict mode enabled", () => {
    const result = JSON.parse(generateTsconfig());
    expect(result.compilerOptions.strict).toBe(true);
  });

  test("targets ESM", () => {
    const result = JSON.parse(generateTsconfig());
    expect(result.compilerOptions.module).toBe("NodeNext");
  });
});

describe("generateReadme", () => {
  test("includes agent name as heading", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("# test-agent");
  });

  test("includes description", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("A test agent");
  });

  test("includes getting started section", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("Getting Started");
  });
});
