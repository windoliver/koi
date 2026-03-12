import { describe, expect, test } from "bun:test";
import type { WizardState } from "../wizard/state.js";
import { generateCopilot } from "./copilot.js";

const STATE: WizardState = {
  template: "copilot",
  name: "my-copilot",
  description: "A copilot agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: undefined,
  channels: ["cli", "telegram", "slack"],
  directory: "my-copilot",
  koiCommand: "koi",
  preset: "local",
  addons: [],
  demoPack: undefined,
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

  test("generates bootstrap instructions", () => {
    const files = generateCopilot(STATE);
    expect(files[".koi/INSTRUCTIONS.md"]).toBeDefined();
  });

  test("generates tool guidance", () => {
    const files = generateCopilot(STATE);
    expect(files[".koi/TOOLS.md"]).toContain("ask_user");
    expect(files[".koi/TOOLS.md"]).toContain("web_search");
  });

  test("koi.yaml includes channels", () => {
    const files = generateCopilot(STATE);
    const yaml = files["koi.yaml"] as string;
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("telegram");
    expect(yaml).toContain("slack");
  });

  test("koi.yaml includes built-in tools", () => {
    const files = generateCopilot(STATE);
    const yaml = files["koi.yaml"] as string;
    expect(yaml).toContain("@koi/tool-ask-user");
    expect(yaml).toContain("@koi/tools-web");
  });

  test("generates more files than minimal", () => {
    const files = generateCopilot(STATE);
    expect(Object.keys(files)).toHaveLength(8);
  });

  test("generates env scaffolding for selected channels", () => {
    const files = generateCopilot(STATE);
    expect(files[".env"]).toContain("ANTHROPIC_API_KEY=");
    expect(files[".env"]).toContain("TELEGRAM_BOT_TOKEN=");
    expect(files[".env"]).toContain("SLACK_BOT_TOKEN=");
    expect(files[".env"]).toContain("SLACK_APP_TOKEN=");
  });
});
