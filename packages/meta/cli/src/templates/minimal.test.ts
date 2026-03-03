import { describe, expect, test } from "bun:test";
import type { WizardState } from "../wizard/state.js";
import { generateMinimal } from "./minimal.js";

const STATE: WizardState = {
  template: "minimal",
  name: "my-agent",
  description: "A minimal agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: "loop",
  channels: ["cli"],
  directory: "my-agent",
};

describe("generateMinimal", () => {
  test("returns a file map", () => {
    const files = generateMinimal(STATE);
    expect(typeof files).toBe("object");
  });

  test("generates koi.yaml", () => {
    const files = generateMinimal(STATE);
    expect(files["koi.yaml"]).toBeDefined();
  });

  test("generates package.json", () => {
    const files = generateMinimal(STATE);
    expect(files["package.json"]).toBeDefined();
  });

  test("generates tsconfig.json", () => {
    const files = generateMinimal(STATE);
    expect(files["tsconfig.json"]).toBeDefined();
  });

  test("generates README.md", () => {
    const files = generateMinimal(STATE);
    expect(files["README.md"]).toBeDefined();
  });

  test("generates exactly 4 files", () => {
    const files = generateMinimal(STATE);
    expect(Object.keys(files)).toHaveLength(4);
  });

  test("koi.yaml contains agent name", () => {
    const files = generateMinimal(STATE);
    expect(files["koi.yaml"]).toContain("my-agent");
  });
});
