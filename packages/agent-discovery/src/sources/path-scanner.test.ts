import { describe, expect, it } from "bun:test";
import { KNOWN_CLI_AGENTS } from "../constants.js";
import type { KnownCliAgent, SystemCalls } from "../types.js";
import { createPathSource } from "./path-scanner.js";

function createStubSystemCalls(found: ReadonlySet<string>): SystemCalls {
  return {
    which: (cmd: string): string | null => (found.has(cmd) ? `/usr/bin/${cmd}` : null),
    exec: async (_cmd: string, _args: readonly string[], _timeout: number) => ({
      exitCode: 0,
      stdout: "1.0.0",
    }),
  };
}

describe("createPathSource", () => {
  it("returns descriptors for agents found on PATH", async () => {
    const sys = createStubSystemCalls(new Set(["claude", "aider"]));
    const source = createPathSource({ systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("claude-code");
    expect(results[0]?.source).toBe("path");
    expect(results[0]?.healthy).toBe(true);
    expect(results[0]?.command).toBe("claude");
    expect(results[1]?.name).toBe("aider");
  });

  it("returns empty array when no agents found", async () => {
    const sys = createStubSystemCalls(new Set());
    const source = createPathSource({ systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(0);
  });

  it("uses first matching binary for agents with multiple binaries", async () => {
    const customAgent: KnownCliAgent = {
      name: "multi-bin",
      displayName: "Multi Binary",
      binaries: ["bin-a", "bin-b"],
      capabilities: ["test"],
      versionFlag: "--version",
      transport: "cli",
    };
    const sys = createStubSystemCalls(new Set(["bin-b"]));
    const source = createPathSource({ knownAgents: [customAgent], systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.command).toBe("bin-b");
  });

  it("stops at first matching binary per agent", async () => {
    const customAgent: KnownCliAgent = {
      name: "both-bins",
      displayName: "Both Bins",
      binaries: ["bin-a", "bin-b"],
      capabilities: ["test"],
      versionFlag: "--version",
      transport: "cli",
    };
    const sys = createStubSystemCalls(new Set(["bin-a", "bin-b"]));
    const source = createPathSource({ knownAgents: [customAgent], systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.command).toBe("bin-a");
  });

  it("uses custom known agents list when provided", async () => {
    const customAgents: readonly KnownCliAgent[] = [
      {
        name: "custom-agent",
        displayName: "Custom Agent",
        binaries: ["custom"],
        capabilities: ["custom-cap"],
        versionFlag: "-v",
        transport: "cli",
      },
    ];
    const sys = createStubSystemCalls(new Set(["custom"]));
    const source = createPathSource({ knownAgents: customAgents, systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("custom-agent");
    expect(results[0]?.capabilities).toEqual(["custom-cap"]);
  });

  it("preserves agent metadata in descriptors", async () => {
    const sys = createStubSystemCalls(new Set(["claude"]));
    const source = createPathSource({ systemCalls: sys });

    const results = await source.discover();

    expect(results[0]?.displayName).toBe("Claude Code");
    expect(results[0]?.transport).toBe("cli");
  });

  it("discovers all default known agents when all are present", async () => {
    const allBinaries = new Set(KNOWN_CLI_AGENTS.flatMap((a) => [...a.binaries]));
    const sys = createStubSystemCalls(allBinaries);
    const source = createPathSource({ systemCalls: sys });

    const results = await source.discover();

    expect(results).toHaveLength(KNOWN_CLI_AGENTS.length);
  });

  it("has name 'path'", () => {
    const sys = createStubSystemCalls(new Set());
    const source = createPathSource({ systemCalls: sys });

    expect(source.name).toBe("path");
  });
});
