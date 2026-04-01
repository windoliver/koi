/**
 * Tests for individual CLI slash commands.
 *
 * Each command is tested for: happy path, invalid args, missing deps, edge cases.
 */

import { describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CLI_COMMANDS } from "./commands.js";
import type { CliCommandDeps, CommandResult } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<CliCommandDeps> = {}): CliCommandDeps & {
  readonly written: () => string;
} {
  const output = new PassThrough();
  return {
    cancelStream: mock(() => {}),
    listModels: mock(() => ["claude-sonnet-4-6", "claude-opus-4-6"]),
    currentModel: mock(() => "claude-sonnet-4-6"),
    setModel: mock(() => ({ ok: true }) as const),
    output,
    exit: mock(() => {}),
    written() {
      const chunks: Uint8Array[] = [];
      let chunk: Uint8Array | null = output.read() as Uint8Array | null;
      while (chunk !== null) {
        chunks.push(chunk);
        chunk = output.read() as Uint8Array | null;
      }
      return Buffer.concat(chunks).toString("utf-8");
    },
    ...overrides,
  };
}

function findCommand(name: string): (typeof CLI_COMMANDS)[number] {
  const cmd = CLI_COMMANDS.find((c) => c.name === name);
  if (cmd === undefined) throw new Error(`Command not found: ${name}`);
  return cmd;
}

// ─── /help ──────────────────────────────────────────────────────────

describe("/help", () => {
  const cmd = findCommand("help");

  test("lists all commands when called without args", () => {
    const deps = createMockDeps();
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("Available commands:");
    for (const c of CLI_COMMANDS) {
      expect(out).toContain(`/${c.name}`);
    }
  });

  test("shows detail for a specific command", () => {
    const deps = createMockDeps();
    const result = cmd.execute("model", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("/model");
    expect(out).toContain("Show or switch");
  });

  test("shows detail for a command alias", () => {
    const deps = createMockDeps();
    const result = cmd.execute("exit", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("/quit");
    expect(out).toContain("aliases: /exit");
  });

  test("returns error for unknown command", () => {
    const deps = createMockDeps();
    const result = cmd.execute("nonexistent", deps);
    expect(result).toEqual({
      ok: false,
      message: "Unknown command: nonexistent. Type /help for available commands.",
    });
  });
});

// ─── /clear ─────────────────────────────────────────────────────────

describe("/clear", () => {
  const cmd = findCommand("clear");

  test("writes ANSI clear sequence", () => {
    const deps = createMockDeps();
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("\x1b[2J");
    expect(out).toContain("\x1b[H");
  });
});

// ─── /cancel ────────────────────────────────────────────────────────

describe("/cancel", () => {
  const cmd = findCommand("cancel");

  test("calls cancelStream and confirms", () => {
    const deps = createMockDeps();
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.cancelStream).toHaveBeenCalledTimes(1);
    expect(deps.written()).toContain("Stream cancelled");
  });
});

// ─── /quit ──────────────────────────────────────────────────────────

describe("/quit", () => {
  const cmd = findCommand("quit");

  test("calls exit", () => {
    const deps = createMockDeps();
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  test("has exit as an alias", () => {
    expect(cmd.aliases).toContain("exit");
  });
});

// ─── /model ─────────────────────────────────────────────────────────

describe("/model", () => {
  const cmd = findCommand("model");

  test("shows current model when called without args", async () => {
    const deps = createMockDeps();
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("Current model: claude-sonnet-4-6");
    expect(out).toContain("Available:");
  });

  test("switches model and reports success", async () => {
    const deps = createMockDeps();
    const result = await cmd.execute("claude-opus-4-6", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.setModel).toHaveBeenCalledWith("claude-opus-4-6");
    expect(deps.written()).toContain("Model switched to: claude-opus-4-6");
  });

  test("reports failure from setModel", async () => {
    const deps = createMockDeps({
      setModel: mock(() => ({ ok: false, message: "Model switching not supported" })),
    });
    const result = await cmd.execute("gpt-99", deps);
    expect(result).toEqual({ ok: false, message: "Model switching not supported" });
  });

  test("completer returns matching models", () => {
    const deps = createMockDeps();
    const completions = cmd.complete?.("claude-o", deps);
    expect(completions).toEqual(["claude-opus-4-6"]);
  });

  test("completer returns all models for empty input", () => {
    const deps = createMockDeps();
    const completions = cmd.complete?.("", deps);
    expect(completions).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
  });
});

// ─── /status ────────────────────────────────────────────────────────

describe("/status", () => {
  const cmd = findCommand("status");

  test("shows status when deps available", async () => {
    const deps = createMockDeps({
      getStatus: mock(async () => "Agent running — 3 turns, 1.2k tokens"),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("Agent running");
  });

  test("returns unavailable when getStatus is undefined", async () => {
    const deps = createMockDeps({ getStatus: undefined });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({
      ok: false,
      message: "/status requires --admin mode. Run: koi start --admin",
    });
  });

  test("returns error when getStatus throws", async () => {
    const deps = createMockDeps({
      getStatus: mock(async () => {
        throw new Error("connection refused");
      }),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({
      ok: false,
      message: "Status check failed: connection refused",
    });
  });
});

// ─── /attach ────────────────────────────────────────────────────────

describe("/attach", () => {
  const cmd = findCommand("attach");

  test("lists agents when called without args", async () => {
    const deps = createMockDeps({
      listAgents: mock(async () => [
        { name: "Alice", agentId: "a1", state: "running" },
        { name: "Bob", agentId: "a2", state: "idle" },
      ]),
      attachAgent: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("Alice");
    expect(out).toContain("Bob");
    expect(out).toContain("/attach <name>");
  });

  test("attaches to agent by name (case-insensitive)", async () => {
    const deps = createMockDeps({
      listAgents: mock(async () => [{ name: "Alice", agentId: "a1", state: "running" }]),
      attachAgent: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("alice", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.attachAgent).toHaveBeenCalledWith("Alice");
  });

  test("returns error when agent not found", async () => {
    const deps = createMockDeps({
      listAgents: mock(async () => [{ name: "Alice", agentId: "a1", state: "running" }]),
      attachAgent: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("bob", deps);
    expect(result).toEqual({
      ok: false,
      message: "Agent not found: bob. Available: Alice",
    });
  });

  test("returns unavailable when listAgents is undefined", async () => {
    const deps = createMockDeps({ listAgents: undefined, attachAgent: undefined });
    const result = await cmd.execute("alice", deps);
    expect(result).toEqual({
      ok: false,
      message: "/attach requires --admin mode. Run: koi start --admin",
    });
  });

  test("handles empty agent list", async () => {
    const deps = createMockDeps({
      listAgents: mock(async () => []),
      attachAgent: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("No agents available");
  });
});

// ─── /sessions ──────────────────────────────────────────────────────

describe("/sessions", () => {
  const cmd = findCommand("sessions");

  test("lists sessions when available", async () => {
    const deps = createMockDeps({
      listSessions: mock(async () => [
        { sessionId: "s1", agentName: "Alice", startedAt: 1710000000000 },
      ]),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("s1");
    expect(out).toContain("Alice");
  });

  test("shows message for empty session list", async () => {
    const deps = createMockDeps({
      listSessions: mock(async () => []),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("No recent sessions");
  });

  test("returns unavailable when listSessions is undefined", async () => {
    const deps = createMockDeps({ listSessions: undefined });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({
      ok: false,
      message: "/sessions requires --admin mode. Run: koi start --admin",
    });
  });

  test("handles error from listSessions", async () => {
    const deps = createMockDeps({
      listSessions: mock(async () => {
        throw new Error("db unavailable");
      }),
    });
    const result = await cmd.execute("", deps);
    expect(result).toEqual({
      ok: false,
      message: "Failed to list sessions: db unavailable",
    });
  });
});

// ─── /tools ─────────────────────────────────────────────────────────

describe("/tools", () => {
  const cmd = findCommand("tools");

  test("lists loaded tools", () => {
    const deps = createMockDeps({
      listTools: mock(() => [
        { name: "read_file", description: "Read a file from disk" },
        { name: "search", description: "Search the codebase" },
      ]),
    });
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("Loaded tools (2):");
    expect(out).toContain("read_file");
    expect(out).toContain("search");
  });

  test("shows message for empty tool list", () => {
    const deps = createMockDeps({
      listTools: mock(() => []),
    });
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("No tools loaded");
  });

  test("shows message when listTools is undefined", () => {
    const deps = createMockDeps({ listTools: undefined });
    const result = cmd.execute("", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("Tool listing not available");
  });
});

// ─── /forge ─────────────────────────────────────────────────────────

describe("/forge", () => {
  const cmd = findCommand("forge");

  test("shows usage when called without subcommand", async () => {
    const deps = createMockDeps();
    const result = await cmd.execute("", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("Usage:");
  });

  test("shows usage for unknown subcommand", async () => {
    const deps = createMockDeps();
    const result = await cmd.execute("delete foo", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("Usage:");
  });

  test("search returns results", async () => {
    const deps = createMockDeps({
      forgeSearch: mock(async () => [
        { id: "b1", name: "csv-parser", kind: "tool", description: "Parse CSV files" },
      ]),
    });
    const result = await cmd.execute("search csv", deps);
    expect(result).toEqual({ ok: true });
    const out = deps.written();
    expect(out).toContain("csv-parser");
    expect(out).toContain("/forge install");
  });

  test("search shows empty message", async () => {
    const deps = createMockDeps({
      forgeSearch: mock(async () => []),
    });
    const result = await cmd.execute("search nonexistent", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("No results");
  });

  test("search returns error when forge not configured", async () => {
    const deps = createMockDeps({ forgeSearch: undefined });
    const result = await cmd.execute("search csv", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("not configured");
  });

  test("search requires a query", async () => {
    const deps = createMockDeps({
      forgeSearch: mock(async () => []),
    });
    const result = await cmd.execute("search", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("Usage:");
  });

  test("install delegates to forgeInstall", async () => {
    const deps = createMockDeps({
      forgeInstall: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("install b1", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.forgeInstall).toHaveBeenCalledWith("b1");
  });

  test("install returns error when forge not configured", async () => {
    const deps = createMockDeps({ forgeInstall: undefined });
    const result = await cmd.execute("install b1", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("not configured");
  });

  test("install requires an id", async () => {
    const deps = createMockDeps({
      forgeInstall: mock(async () => ({ ok: true }) as CommandResult),
    });
    const result = await cmd.execute("install", deps);
    expect(result.ok).toBe(false);
    expect((result as { readonly message: string }).message).toContain("Usage:");
  });

  test("inspect shows brick details", async () => {
    const deps = createMockDeps({
      forgeInspect: mock(async () => "Name: csv-parser\nKind: tool\nStatus: active"),
    });
    const result = await cmd.execute("inspect b1", deps);
    expect(result).toEqual({ ok: true });
    expect(deps.written()).toContain("csv-parser");
  });

  test("inspect returns error when forge not configured", async () => {
    const deps = createMockDeps({ forgeInspect: undefined });
    const result = await cmd.execute("inspect b1", deps);
    expect(result.ok).toBe(false);
  });

  test("search handles thrown error gracefully", async () => {
    const deps = createMockDeps({
      forgeSearch: mock(async () => {
        throw new Error("connection refused");
      }),
    });
    const result = await cmd.execute("search csv", deps);
    expect(result).toEqual({
      ok: false,
      message: "Forge search failed: connection refused",
    });
  });

  test("completer returns subcommands", () => {
    expect(cmd.complete?.("", createMockDeps())).toEqual(["search", "install", "inspect"]);
  });

  test("completer filters subcommands", () => {
    expect(cmd.complete?.("se", createMockDeps())).toEqual(["search"]);
  });
});

// ─── Registry integrity ─────────────────────────────────────────────

describe("CLI_COMMANDS registry", () => {
  test("all commands have unique names", () => {
    const names = CLI_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no alias collides with a command name", () => {
    const names = new Set(CLI_COMMANDS.map((c) => c.name));
    for (const cmd of CLI_COMMANDS) {
      if (cmd.aliases !== undefined) {
        for (const alias of cmd.aliases) {
          expect(names.has(alias)).toBe(false);
        }
      }
    }
  });

  test("contains exactly 10 commands", () => {
    expect(CLI_COMMANDS).toHaveLength(10);
  });
});
