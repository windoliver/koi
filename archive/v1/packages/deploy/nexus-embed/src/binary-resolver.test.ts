import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveNexusBinary } from "./binary-resolver.js";

describe("resolveNexusBinary", () => {
  let savedNexusCommand: string | undefined;

  beforeEach(() => {
    savedNexusCommand = process.env.NEXUS_COMMAND;
    delete process.env.NEXUS_COMMAND;
  });

  afterEach(() => {
    if (savedNexusCommand !== undefined) {
      process.env.NEXUS_COMMAND = savedNexusCommand;
    } else {
      delete process.env.NEXUS_COMMAND;
    }
  });

  test("returns uvx command by default (isolated, no PATH conflicts)", () => {
    const result = resolveNexusBinary();
    expect(result).toEqual(["uvx", "--from", "nexus-ai-fs", "nexus"]);
  });

  test("returns NEXUS_COMMAND split parts when env var is set", () => {
    process.env.NEXUS_COMMAND = "/usr/local/bin/nexus-server --verbose";
    const result = resolveNexusBinary();
    expect(result).toEqual(["/usr/local/bin/nexus-server", "--verbose"]);
  });

  test("handles single-word NEXUS_COMMAND", () => {
    process.env.NEXUS_COMMAND = "nexus";
    const result = resolveNexusBinary();
    expect(result).toEqual(["nexus"]);
  });

  test("falls back to default when NEXUS_COMMAND is empty string", () => {
    process.env.NEXUS_COMMAND = "";
    const result = resolveNexusBinary();
    expect(result).toEqual(["uvx", "--from", "nexus-ai-fs", "nexus"]);
  });

  test("falls back to default when NEXUS_COMMAND is whitespace only", () => {
    process.env.NEXUS_COMMAND = "   ";
    const result = resolveNexusBinary();
    expect(result).toEqual(["uvx", "--from", "nexus-ai-fs", "nexus"]);
  });

  test("trims leading/trailing whitespace from NEXUS_COMMAND", () => {
    process.env.NEXUS_COMMAND = "  python -m nexus  ";
    const result = resolveNexusBinary();
    expect(result).toEqual(["python", "-m", "nexus"]);
  });

  test("uses uv run --directory for sourceDir (contributor mode)", () => {
    const result = resolveNexusBinary("/home/dev/nexus");
    expect(result).toEqual(["uv", "run", "--directory", "/home/dev/nexus", "nexus"]);
  });

  test("NEXUS_COMMAND takes priority over sourceDir", () => {
    process.env.NEXUS_COMMAND = "my-nexus";
    const result = resolveNexusBinary("/home/dev/nexus");
    expect(result).toEqual(["my-nexus"]);
  });
});
