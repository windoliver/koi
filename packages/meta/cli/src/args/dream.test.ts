import { describe, expect, it } from "bun:test";
import { isDreamFlags, parseDreamFlags } from "./dream.js";

describe("parseDreamFlags", () => {
  it("returns default flags with no args", () => {
    const flags = parseDreamFlags([]);
    expect(flags.command).toBe("dream");
    expect(flags.memoryDir).toBeUndefined();
    expect(flags.model).toBeUndefined();
    expect(flags.modelUrl).toBeUndefined();
    expect(flags.force).toBe(false);
    expect(flags.json).toBe(false);
    expect(flags.help).toBe(false);
    expect(flags.version).toBe(false);
  });

  it("parses --force flag", () => {
    const flags = parseDreamFlags(["--force"]);
    expect(flags.force).toBe(true);
  });

  it("parses --json flag", () => {
    const flags = parseDreamFlags(["--json"]);
    expect(flags.json).toBe(true);
  });

  it("parses --memory-dir flag", () => {
    const flags = parseDreamFlags(["--memory-dir", "/tmp/mem"]);
    expect(flags.memoryDir).toBe("/tmp/mem");
  });

  it("parses --model flag", () => {
    const flags = parseDreamFlags(["--model", "openai/gpt-4o"]);
    expect(flags.model).toBe("openai/gpt-4o");
  });

  it("parses --model-url flag", () => {
    const flags = parseDreamFlags(["--model-url", "https://api.example.com/v1"]);
    expect(flags.modelUrl).toBe("https://api.example.com/v1");
  });

  it("throws ParseError for --api-key (removed for security)", () => {
    expect(() => parseDreamFlags(["--api-key", "sk-test-123"])).toThrow();
  });

  it("parses combined flags", () => {
    const flags = parseDreamFlags([
      "--force",
      "--json",
      "--memory-dir",
      "/custom/mem",
      "--model",
      "anthropic/claude-3-5-sonnet",
    ]);
    expect(flags.force).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.memoryDir).toBe("/custom/mem");
    expect(flags.model).toBe("anthropic/claude-3-5-sonnet");
  });

  it("parses --help flag", () => {
    const flags = parseDreamFlags(["--help"]);
    expect(flags.help).toBe(true);
  });

  it("parses --version flag", () => {
    const flags = parseDreamFlags(["--version"]);
    expect(flags.version).toBe(true);
  });
});

describe("isDreamFlags", () => {
  it("returns true for dream command", () => {
    const flags = parseDreamFlags([]);
    expect(isDreamFlags(flags)).toBe(true);
  });

  it("returns false for other commands", () => {
    const flags = { command: "doctor" as const, version: false, help: false };
    expect(isDreamFlags(flags)).toBe(false);
  });

  it("returns false for undefined command", () => {
    const flags = { command: undefined, version: false, help: false };
    expect(isDreamFlags(flags)).toBe(false);
  });
});
