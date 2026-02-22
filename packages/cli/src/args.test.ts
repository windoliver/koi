import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  test("returns undefined command when no args", () => {
    const result = parseArgs([]);
    expect(result.command).toBeUndefined();
  });

  test("parses command as first positional arg", () => {
    const result = parseArgs(["init"]);
    expect(result.command).toBe("init");
  });

  test("parses directory as second positional arg", () => {
    const result = parseArgs(["init", "my-agent"]);
    expect(result.command).toBe("init");
    expect(result.directory).toBe("my-agent");
  });

  test("parses --yes flag", () => {
    const result = parseArgs(["init", "--yes"]);
    expect(result.yes).toBe(true);
  });

  test("parses -y shorthand for --yes", () => {
    const result = parseArgs(["init", "-y"]);
    expect(result.yes).toBe(true);
  });

  test("defaults yes to false when not provided", () => {
    const result = parseArgs(["init"]);
    expect(result.yes).toBe(false);
  });

  test("parses --name flag with value", () => {
    const result = parseArgs(["init", "--name", "my-agent"]);
    expect(result.name).toBe("my-agent");
  });

  test("parses --template flag with value", () => {
    const result = parseArgs(["init", "--template", "copilot"]);
    expect(result.template).toBe("copilot");
  });

  test("parses --model flag with value", () => {
    const result = parseArgs(["init", "--model", "openai:gpt-4o"]);
    expect(result.model).toBe("openai:gpt-4o");
  });

  test("parses --engine flag with value", () => {
    const result = parseArgs(["init", "--engine", "deepagents"]);
    expect(result.engine).toBe("deepagents");
  });

  test("parses all flags together", () => {
    const result = parseArgs([
      "init",
      "my-project",
      "--yes",
      "--name",
      "My Agent",
      "--template",
      "copilot",
      "--model",
      "anthropic:claude-sonnet-4-5-20250929",
      "--engine",
      "loop",
    ]);
    expect(result.command).toBe("init");
    expect(result.directory).toBe("my-project");
    expect(result.yes).toBe(true);
    expect(result.name).toBe("My Agent");
    expect(result.template).toBe("copilot");
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.engine).toBe("loop");
  });

  test("flags before directory still work", () => {
    const result = parseArgs(["init", "--yes", "--name", "agent", "my-dir"]);
    expect(result.command).toBe("init");
    expect(result.directory).toBe("my-dir");
    expect(result.yes).toBe(true);
    expect(result.name).toBe("agent");
  });

  test("ignores unknown flags gracefully", () => {
    const result = parseArgs(["init", "--unknown", "value"]);
    expect(result.command).toBe("init");
  });

  test("handles = syntax for flags", () => {
    const result = parseArgs(["init", "--name=my-agent"]);
    expect(result.name).toBe("my-agent");
  });
});
