import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveCommand } from "./binary-resolver.js";

describe("resolveCommand", () => {
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

  test("returns uvx default argv (no PATH conflicts)", () => {
    expect(resolveCommand()).toEqual(["uvx", "--from", "nexus-ai-fs", "nexusd"]);
  });

  test("explicit override beats env and default", () => {
    process.env.NEXUS_COMMAND = "from-env";
    expect(resolveCommand({ command: ["my-nexus", "--flag"] })).toEqual(["my-nexus", "--flag"]);
  });

  test("NEXUS_COMMAND env splits on whitespace when no override", () => {
    process.env.NEXUS_COMMAND = "/usr/local/bin/nexus-server --verbose";
    expect(resolveCommand()).toEqual(["/usr/local/bin/nexus-server", "--verbose"]);
  });

  test("empty NEXUS_COMMAND falls through to default", () => {
    process.env.NEXUS_COMMAND = "";
    expect(resolveCommand()).toEqual(["uvx", "--from", "nexus-ai-fs", "nexusd"]);
  });

  test("whitespace-only NEXUS_COMMAND falls through to default", () => {
    process.env.NEXUS_COMMAND = "   ";
    expect(resolveCommand()).toEqual(["uvx", "--from", "nexus-ai-fs", "nexusd"]);
  });

  test("trims surrounding whitespace from NEXUS_COMMAND", () => {
    process.env.NEXUS_COMMAND = "  python -m nexus  ";
    expect(resolveCommand()).toEqual(["python", "-m", "nexus"]);
  });

  test("sourceDir uses uv run --directory", () => {
    expect(resolveCommand({ sourceDir: "/home/dev/nexus" })).toEqual([
      "uv",
      "run",
      "--directory",
      "/home/dev/nexus",
      "nexusd",
    ]);
  });

  test("explicit command beats sourceDir", () => {
    expect(resolveCommand({ command: ["x"], sourceDir: "/y" })).toEqual(["x"]);
  });

  test("NEXUS_COMMAND env beats sourceDir", () => {
    process.env.NEXUS_COMMAND = "envbin";
    expect(resolveCommand({ sourceDir: "/y" })).toEqual(["envbin"]);
  });

  test("returned argv is readonly (frozen)", () => {
    const argv = resolveCommand();
    expect(Object.isFrozen(argv)).toBe(true);
  });
});
