/**
 * Tests for tab completion — command names, cached dynamic data, edge cases.
 */

import { describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CLI_COMMANDS } from "./commands.js";
import {
  type CompletionCache,
  createCompletionCache,
  refreshCache,
  slashCompleter,
} from "./completer.js";
import type { CliCommandDeps } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<CliCommandDeps> = {}): CliCommandDeps {
  return {
    cancelStream: mock(() => {}),
    listModels: mock(() => ["claude-sonnet-4-6", "claude-opus-4-6"]),
    currentModel: mock(() => "claude-sonnet-4-6"),
    setModel: mock(() => ({ ok: true })),
    output: new PassThrough(),
    exit: mock(() => {}),
    ...overrides,
  };
}

function cachedWith(agents: readonly string[], models: readonly string[]): CompletionCache {
  const farFuture = Date.now() + 60_000;
  return {
    agents: { data: agents, expiresAt: farFuture },
    models: { data: models, expiresAt: farFuture },
  };
}

// ─── Command name completion ────────────────────────────────────────

describe("command name completion", () => {
  test("/ returns all command names", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/", cache, deps);
    // Should contain all command names (including aliases)
    for (const cmd of CLI_COMMANDS) {
      expect(matches).toContain(`/${cmd.name}`);
    }
  });

  test("/he completes to /help", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/he", cache, deps);
    expect(matches).toEqual(["/help"]);
  });

  test("/cl completes to /clear", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/cl", cache, deps);
    expect(matches).toEqual(["/clear"]);
  });

  test("/q returns /quit", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/q", cache, deps);
    expect(matches).toEqual(["/quit"]);
  });

  test("/ex returns /exit (alias)", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/ex", cache, deps);
    expect(matches).toEqual(["/exit"]);
  });

  test("/nonexist returns empty", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/nonexist", cache, deps);
    expect(matches).toEqual([]);
  });
});

// ─── Argument completion ────────────────────────────────────────────

describe("argument completion", () => {
  test("/attach completes with cached agent names", () => {
    const cache = cachedWith(["Alice", "Bob"], []);
    const deps = createMockDeps();
    const [matches] = slashCompleter("/attach ", cache, deps);
    expect(matches).toEqual(["Alice", "Bob"]);
  });

  test("/attach al filters to matching agents", () => {
    const cache = cachedWith(["Alice", "Bob", "Alvin"], []);
    const deps = createMockDeps();
    const [matches] = slashCompleter("/attach al", cache, deps);
    expect(matches).toEqual(["Alice", "Alvin"]);
  });

  test("/model completes with cached model names", () => {
    const cache = cachedWith([], ["claude-sonnet-4-6", "claude-opus-4-6"]);
    const deps = createMockDeps();
    const [matches] = slashCompleter("/model ", cache, deps);
    expect(matches).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
  });

  test("/model claude-o filters to matching models", () => {
    const cache = cachedWith([], ["claude-sonnet-4-6", "claude-opus-4-6"]);
    const deps = createMockDeps();
    const [matches] = slashCompleter("/model claude-o", cache, deps);
    expect(matches).toEqual(["claude-opus-4-6"]);
  });

  test("/attach returns empty when cache is empty", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("/attach ", cache, deps);
    expect(matches).toEqual([]);
  });
});

// ─── Non-slash input — file path completion ─────────────────────────

describe("file path completion", () => {
  test("empty string returns no completions", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("", cache, deps);
    expect(matches).toEqual([]);
  });

  // Use absolute path so tests work regardless of CWD (package dir or monorepo root).
  // Absolute paths like "/Users/..." are distinguished from slash commands ("/help")
  // by the presence of "/" after the leading slash.
  const testDir = `${import.meta.dir}/`;

  test("partial path returns matching files", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter(testDir, cache, deps);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.includes("completer.test.ts"))).toBe(true);
  });

  test("non-existent directory returns empty", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("nonexistent_dir_xyz/", cache, deps);
    expect(matches).toEqual([]);
  });

  test("extracts last token from multi-word input", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches, partial] = slashCompleter(`look at ${testDir}`, cache, deps);
    expect(partial).toBe(testDir);
    expect(matches.length).toBeGreaterThan(0);
  });

  test("plain text without path returns no completions", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    const [matches] = slashCompleter("hello world", cache, deps);
    // "world" doesn't match any file/dir — returns empty
    expect(matches).toEqual([]);
  });
});

// ─── Cache behavior ─────────────────────────────────────────────────

describe("completion cache", () => {
  test("createCompletionCache starts empty", () => {
    const cache = createCompletionCache();
    expect(cache.agents).toBeUndefined();
    expect(cache.models).toBeUndefined();
  });

  test("refreshCache populates models synchronously", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps();
    refreshCache(cache, deps);
    expect(cache.models).toBeDefined();
    expect(cache.models?.data).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
  });

  test("refreshCache populates agents asynchronously", async () => {
    const cache = createCompletionCache();
    const deps = createMockDeps({
      listAgents: mock(async () => [{ name: "Alice", agentId: "a1", state: "running" }]),
    });
    refreshCache(cache, deps);
    // Agents are populated async — wait for the promise to resolve
    await Bun.sleep(10);
    expect(cache.agents).toBeDefined();
    expect(cache.agents?.data).toEqual(["Alice"]);
  });

  test("refreshCache handles listAgents failure gracefully", async () => {
    const cache = createCompletionCache();
    const deps = createMockDeps({
      listAgents: mock(async () => {
        throw new Error("network error");
      }),
    });
    refreshCache(cache, deps);
    await Bun.sleep(10);
    // Should not throw, agents stay undefined
    expect(cache.agents).toBeUndefined();
  });

  test("expired cache entry returns empty completions", () => {
    const cache: CompletionCache = {
      agents: { data: ["Alice"], expiresAt: Date.now() - 1000 },
      models: { data: ["claude-sonnet-4-6"], expiresAt: Date.now() - 1000 },
    };
    const deps = createMockDeps();
    const [matches] = slashCompleter("/attach ", cache, deps);
    expect(matches).toEqual([]);
  });

  test("refreshCache skips agents when listAgents is undefined", () => {
    const cache = createCompletionCache();
    const deps = createMockDeps({ listAgents: undefined });
    refreshCache(cache, deps);
    expect(cache.agents).toBeUndefined();
    // Models should still be populated
    expect(cache.models).toBeDefined();
  });
});
