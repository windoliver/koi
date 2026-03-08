import { describe, expect, test } from "bun:test";
import type { InitFlags, ServeFlags, StartFlags, StopFlags } from "./args.js";
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
    const result = parseArgs(["init", "--yes"]) as InitFlags;
    expect(result.yes).toBe(true);
  });

  test("parses -y shorthand for --yes", () => {
    const result = parseArgs(["init", "-y"]) as InitFlags;
    expect(result.yes).toBe(true);
  });

  test("defaults yes to false when not provided", () => {
    const result = parseArgs(["init"]) as InitFlags;
    expect(result.yes).toBe(false);
  });

  test("parses --name flag with value", () => {
    const result = parseArgs(["init", "--name", "my-agent"]) as InitFlags;
    expect(result.name).toBe("my-agent");
  });

  test("parses --template flag with value", () => {
    const result = parseArgs(["init", "--template", "copilot"]) as InitFlags;
    expect(result.template).toBe("copilot");
  });

  test("parses --model flag with value", () => {
    const result = parseArgs(["init", "--model", "openai:gpt-4o"]) as InitFlags;
    expect(result.model).toBe("openai:gpt-4o");
  });

  test("parses --engine flag with value", () => {
    const result = parseArgs(["init", "--engine", "deepagents"]) as InitFlags;
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
    ]) as InitFlags;
    expect(result.command).toBe("init");
    expect(result.directory).toBe("my-project");
    expect(result.yes).toBe(true);
    expect(result.name).toBe("My Agent");
    expect(result.template).toBe("copilot");
    expect(result.model).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(result.engine).toBe("loop");
  });

  test("flags before directory still work", () => {
    const result = parseArgs(["init", "--yes", "--name", "agent", "my-dir"]) as InitFlags;
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
    const result = parseArgs(["init", "--name=my-agent"]) as InitFlags;
    expect(result.name).toBe("my-agent");
  });
});

describe("parseArgs — start command", () => {
  test("parses start command", () => {
    const result = parseArgs(["start"]) as StartFlags;
    expect(result.command).toBe("start");
  });

  test("parses --manifest flag", () => {
    const result = parseArgs(["start", "--manifest", "custom.yaml"]) as StartFlags;
    expect(result.manifest).toBe("custom.yaml");
  });

  test("parses --verbose flag", () => {
    const result = parseArgs(["start", "--verbose"]) as StartFlags;
    expect(result.verbose).toBe(true);
  });

  test("parses -v shorthand for --verbose", () => {
    const result = parseArgs(["start", "-v"]) as StartFlags;
    expect(result.verbose).toBe(true);
  });

  test("parses --dry-run flag", () => {
    const result = parseArgs(["start", "--dry-run"]) as StartFlags;
    expect(result.dryRun).toBe(true);
  });

  test("parses positional manifest path", () => {
    const result = parseArgs(["start", "my-agent.yaml"]) as StartFlags;
    expect(result.manifest).toBe("my-agent.yaml");
    expect(result.directory).toBe("my-agent.yaml");
  });

  test("--manifest flag takes precedence over positional", () => {
    const result = parseArgs(["start", "positional.yaml", "--manifest", "flag.yaml"]) as StartFlags;
    expect(result.manifest).toBe("flag.yaml");
  });

  test("defaults verbose and dryRun to false", () => {
    const result = parseArgs(["start"]) as StartFlags;
    expect(result.verbose).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  test("defaults manifest to undefined when not provided", () => {
    const result = parseArgs(["start"]) as StartFlags;
    expect(result.manifest).toBeUndefined();
  });

  test("parses all start flags together", () => {
    const result = parseArgs([
      "start",
      "--manifest",
      "agent.yaml",
      "--verbose",
      "--dry-run",
    ]) as StartFlags;
    expect(result.command).toBe("start");
    expect(result.manifest).toBe("agent.yaml");
    expect(result.verbose).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

describe("parseArgs — nexus flags", () => {
  test("parses --nexus-url for start command", () => {
    const result = parseArgs(["start", "--nexus-url", "http://localhost:2026"]) as StartFlags;
    expect(result.command).toBe("start");
    expect(result.nexusUrl).toBe("http://localhost:2026");
  });

  test("defaults nexusUrl to undefined for start", () => {
    const result = parseArgs(["start"]) as StartFlags;
    expect(result.nexusUrl).toBeUndefined();
  });

  test("parses --nexus-url for serve command", () => {
    const result = parseArgs(["serve", "--nexus-url", "http://nexus.example.com"]) as ServeFlags;
    expect(result.command).toBe("serve");
    expect(result.nexusUrl).toBe("http://nexus.example.com");
  });

  test("defaults nexusUrl to undefined for serve", () => {
    const result = parseArgs(["serve"]) as ServeFlags;
    expect(result.nexusUrl).toBeUndefined();
  });

  test("parses --nexus flag for stop command", () => {
    const result = parseArgs(["stop", "--nexus"]) as StopFlags;
    expect(result.command).toBe("stop");
    expect(result.nexus).toBe(true);
  });

  test("defaults nexus to false for stop", () => {
    const result = parseArgs(["stop"]) as StopFlags;
    expect(result.nexus).toBe(false);
  });
});

describe("parseArgs — unknown command", () => {
  test("returns unknown command as-is", () => {
    const result = parseArgs(["deploy"]);
    expect(result.command).toBe("deploy");
    expect(result.directory).toBeUndefined();
  });

  test("returns BaseFlags for unknown command", () => {
    const result = parseArgs(["unknown"]);
    expect(result.command).toBe("unknown");
    // Should not have init or start specific fields
    expect("yes" in result).toBe(false);
    expect("manifest" in result).toBe(false);
  });
});
