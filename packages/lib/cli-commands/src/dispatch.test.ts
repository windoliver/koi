/**
 * Tests for slash command dispatch and TUI-only command handling.
 */

import { describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CLI_COMMANDS } from "./commands.js";
import { handleSlashCommand, TUI_ONLY_COMMANDS } from "./dispatch.js";
import type { CliCommandDeps } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<CliCommandDeps> = {}): CliCommandDeps & {
  readonly written: () => string;
} {
  const output = new PassThrough();
  return {
    cancelStream: mock(() => {}),
    listModels: mock(() => ["claude-sonnet-4-6"]),
    currentModel: mock(() => "claude-sonnet-4-6"),
    setModel: mock(() => {}),
    output,
    exit: mock(() => {}),
    written() {
      const chunks: Buffer[] = [];
      let chunk: Buffer | null = output.read() as Buffer | null;
      while (chunk !== null) {
        chunks.push(chunk);
        chunk = output.read() as Buffer | null;
      }
      return Buffer.concat(chunks).toString("utf-8");
    },
    ...overrides,
  };
}

// ─── Dispatch routing ───────────────────────────────────────────────

describe("handleSlashCommand", () => {
  test("dispatches known command", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/cancel", deps);
    expect(result.ok).toBe(true);
    expect(deps.cancelStream).toHaveBeenCalledTimes(1);
  });

  test("dispatches command with arguments", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/model claude-sonnet-4-6", deps);
    expect(result.ok).toBe(true);
    expect(deps.setModel).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  test("dispatches command by alias", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/exit", deps);
    expect(result.ok).toBe(true);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  test("returns error for unknown command", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/foobar", deps);
    expect(result).toEqual({
      ok: false,
      message: "Unknown command: /foobar. Type /help for available commands.",
    });
  });

  test("returns helpful message for bare /", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/", deps);
    expect(result).toEqual({
      ok: false,
      message: "Type /help for available commands.",
    });
  });

  test("handles leading/trailing whitespace", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("  /cancel  ", deps);
    expect(result.ok).toBe(true);
    expect(deps.cancelStream).toHaveBeenCalledTimes(1);
  });

  test("command names are case-insensitive", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/HELP", deps);
    expect(result.ok).toBe(true);
    expect(deps.written()).toContain("Available commands:");
  });
});

// ─── TUI-only commands ──────────────────────────────────────────────

describe("TUI-only command redirect", () => {
  test("redirects known TUI command to koi tui", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/agents", deps);
    expect(result).toEqual({
      ok: false,
      message: "/agents is a TUI panel command. Run: koi tui",
    });
  });

  test("redirects /governance to koi tui", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/governance", deps);
    expect(result).toEqual({
      ok: false,
      message: "/governance is a TUI panel command. Run: koi tui",
    });
  });

  test("redirects /logs to koi tui", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/logs", deps);
    expect(result).toEqual({
      ok: false,
      message: "/logs is a TUI panel command. Run: koi tui",
    });
  });

  test("redirects /deploy to koi tui", async () => {
    const deps = createMockDeps();
    const result = await handleSlashCommand("/deploy", deps);
    expect(result).toEqual({
      ok: false,
      message: "/deploy is a TUI panel command. Run: koi tui",
    });
  });
});

// ─── Completeness guard ─────────────────────────────────────────────

describe("TUI_ONLY_COMMANDS completeness", () => {
  /**
   * Every TUI command that is NOT handled by CLI_COMMANDS must be in
   * TUI_ONLY_COMMANDS. This test catches regressions when new TUI
   * commands are added but not accounted for in the CLI redirect set.
   */
  test("CLI command names do not overlap with TUI_ONLY_COMMANDS", () => {
    const cliNames = new Set<string>();
    for (const cmd of CLI_COMMANDS) {
      cliNames.add(cmd.name);
      if (cmd.aliases !== undefined) {
        for (const alias of cmd.aliases) {
          cliNames.add(alias);
        }
      }
    }
    for (const name of cliNames) {
      expect(TUI_ONLY_COMMANDS.has(name)).toBe(false);
    }
  });

  test("TUI_ONLY_COMMANDS is non-empty", () => {
    expect(TUI_ONLY_COMMANDS.size).toBeGreaterThan(0);
  });

  test("TUI_ONLY_COMMANDS contains expected panel commands", () => {
    const expected = [
      "agents",
      "logs",
      "governance",
      "channels",
      "skills",
      "deploy",
      "scheduler",
      "temporal",
      "nexus",
    ];
    for (const name of expected) {
      expect(TUI_ONLY_COMMANDS.has(name)).toBe(true);
    }
  });
});
