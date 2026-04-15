import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookConfig } from "@koi/core";
import type { McpServerConfig } from "@koi/mcp";
import {
  buildPluginMcpSetup,
  loadUserMcpSetup,
  loadUserRegisteredHooks,
  mergeUserAndPluginHooks,
} from "./shared-wiring.js";

function mkTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "koi-shared-wiring-"));
}

function writeMcpJson(cwd: string, body: unknown): void {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(body), "utf8");
}

function commandHook(name: string): HookConfig {
  return { kind: "command", name, cmd: ["/bin/true"] };
}

function agentHook(name: string): HookConfig {
  return { kind: "agent", name, prompt: "verify" };
}

// ---------------------------------------------------------------------------
// loadUserMcpSetup
// ---------------------------------------------------------------------------

describe("loadUserMcpSetup", () => {
  test("returns undefined when .mcp.json is absent", async () => {
    const cwd = mkTempCwd();
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(setup).toBeUndefined();
  });

  test("returns undefined when .mcp.json declares no servers", async () => {
    const cwd = mkTempCwd();
    writeMcpJson(cwd, { mcpServers: {} });
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(setup).toBeUndefined();
  });

  test("returns undefined on invalid JSON (silent skip)", async () => {
    const cwd = mkTempCwd();
    writeFileSync(join(cwd, ".mcp.json"), "not-json", "utf8");
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(setup).toBeUndefined();
  });

  test("returns a setup with provider + resolver when servers present", async () => {
    const cwd = mkTempCwd();
    writeMcpJson(cwd, {
      mcpServers: {
        example: { command: "/bin/echo", args: ["hi"] },
      },
    });
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(setup).toBeDefined();
    expect(setup?.provider).toBeDefined();
    expect(setup?.resolver).toBeDefined();
    expect(setup?.bridge).toBeUndefined();
    setup?.dispose();
  });

  test("dispose is idempotent", async () => {
    const cwd = mkTempCwd();
    writeMcpJson(cwd, {
      mcpServers: { example: { command: "/bin/echo" } },
    });
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(() => {
      setup?.dispose();
      setup?.dispose();
    }).not.toThrow();
  });

  test("handles parent cwd without write access (non-existent)", async () => {
    const setup = await loadUserMcpSetup("/nonexistent-dir-for-koi-test", undefined);
    expect(setup).toBeUndefined();
  });

  test("skips when .mcp.json points at a directory, not a file", async () => {
    const cwd = mkTempCwd();
    mkdirSync(join(cwd, ".mcp.json"));
    const setup = await loadUserMcpSetup(cwd, undefined);
    expect(setup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildPluginMcpSetup
// ---------------------------------------------------------------------------

describe("buildPluginMcpSetup", () => {
  test("returns undefined on empty input", () => {
    expect(buildPluginMcpSetup([])).toBeUndefined();
  });

  test("returns a setup with no bridge when servers are present", () => {
    const servers: readonly McpServerConfig[] = [
      { kind: "stdio", name: "plugin-a", command: "/bin/echo" },
    ];
    const setup = buildPluginMcpSetup(servers);
    expect(setup).toBeDefined();
    expect(setup?.bridge).toBeUndefined();
    expect(setup?.provider).toBeDefined();
    setup?.dispose();
  });
});

// ---------------------------------------------------------------------------
// loadUserRegisteredHooks — per-entry loader semantics (issue #1781)
// ---------------------------------------------------------------------------

describe("loadUserRegisteredHooks", () => {
  let fakeHome: string;
  let origHome: string | undefined;

  function writeHooksJson(body: string): void {
    const dir = join(fakeHome, ".koi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hooks.json"), body, "utf8");
  }

  beforeEach(() => {
    origHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "koi-user-hooks-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("returns [] silently when hooks.json is absent", async () => {
    const errors: string[] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: (m) => errors.push(m),
    });
    expect(hooks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("aborts startup when hooks.json exists but cannot be parsed (fail closed)", async () => {
    // A truncated write, merge conflict, or corrupt file must not degrade to
    // "no hooks configured" — the file may have declared failClosed hooks
    // and we cannot know (review round 2 finding).
    writeHooksJson("not-json");
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*Could not read/);
    expect(errors.some((m) => m.includes("Could not read"))).toBe(true);
  });

  test("loads valid peers when one entry is invalid (issue #1781 regression)", async () => {
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "command", name: "bad", cmd: [] }, // schema-invalid
      ]),
    );
    const errors: string[] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: (m) => errors.push(m),
    });
    expect(hooks.map((rh) => rh.hook.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad");
  });

  test("aborts startup when hooks.json root is not an array (fail closed)", async () => {
    // Object-shaped root cannot be inspected for failClosed entries, so the
    // safe default is abort — otherwise an object root containing a
    // failClosed hook would silently start the TUI with zero user hooks
    // (review round 3 finding).
    writeHooksJson(JSON.stringify({ kind: "command", name: "deny", cmd: [], failClosed: true }));
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*structurally invalid/);
    expect(errors.some((m) => m.includes("array"))).toBe(true);
  });

  test("aborts startup on duplicate hook names (review round 4 finding)", async () => {
    // "First occurrence wins" would silently keep a stale definition when
    // an operator intended the later entry to replace or tighten it.
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "deny", cmd: ["/bin/true"] },
        { kind: "command", name: "deny", cmd: ["/bin/strict"] },
      ]),
    );
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*duplicate hook name/);
    expect(errors.some((m) => m.includes('"deny"'))).toBe(true);
  });

  test("aborts startup when a failClosed entry fails to load", async () => {
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "command", name: "deny", cmd: [], failClosed: true },
      ]),
    );
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start/);
    // Diagnostics for the failed entry must fire before the throw so operators
    // see which hook broke, not just the fatal message.
    expect(errors.some((m) => m.includes('"deny"'))).toBe(true);
  });

  test("does not abort when invalid entries have no failClosed flag", async () => {
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "command", name: "bad", cmd: [] },
      ]),
    );
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: () => {},
    });
    expect(hooks.map((rh) => rh.hook.name)).toEqual(["good"]);
  });

  test("filters agent hooks and fires onAgentHooksFiltered", async () => {
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "c1", cmd: ["/bin/true"] },
        { kind: "agent", name: "a1", prompt: "verify" },
      ]),
    );
    const filtered: string[][] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: true,
      onAgentHooksFiltered: (names) => filtered.push([...names]),
    });
    expect(hooks.map((rh) => rh.hook.name)).toEqual(["c1"]);
    expect(filtered).toEqual([["a1"]]);
  });
});

describe("mergeUserAndPluginHooks", () => {
  test("returns empty array when both inputs are empty", () => {
    const merged = mergeUserAndPluginHooks([], [], { filterAgentHooks: false });
    expect(merged).toEqual([]);
  });

  test("preserves user-then-plugin order", () => {
    const user = [
      {
        id: "u1#0",
        hook: commandHook("u1"),
        tier: "user" as const,
      },
    ];
    const plugin = [commandHook("p1"), commandHook("p2")];
    const merged = mergeUserAndPluginHooks(user, plugin, { filterAgentHooks: false });
    const names = merged.map((rh) => rh.hook.name);
    expect(names).toEqual(["u1", "p1", "p2"]);
  });

  test("tags plugin hooks with 'session' tier", () => {
    const plugin = [commandHook("p1")];
    const merged = mergeUserAndPluginHooks([], plugin, { filterAgentHooks: false });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.tier).toBe("session");
  });

  test("filters agent hooks from plugin list when filterAgentHooks is true", () => {
    const plugin = [commandHook("p1"), agentHook("p2"), commandHook("p3")];
    const merged = mergeUserAndPluginHooks([], plugin, { filterAgentHooks: true });
    const names = merged.map((rh) => rh.hook.name);
    expect(names).toEqual(["p1", "p3"]);
  });

  test("does not filter agent hooks when filterAgentHooks is false", () => {
    const plugin = [commandHook("p1"), agentHook("p2")];
    const merged = mergeUserAndPluginHooks([], plugin, { filterAgentHooks: false });
    expect(merged).toHaveLength(2);
  });

  test("does not second-filter user hooks (trusts the loader)", () => {
    // loadUserRegisteredHooks is responsible for agent-hook filtering on the
    // user tier. If an agent hook slips through here, it should still be
    // present — the merge step is not the place for a belt-and-suspenders.
    const user = [
      {
        id: "u1#0",
        hook: agentHook("u1"),
        tier: "user" as const,
      },
    ];
    const merged = mergeUserAndPluginHooks(user, [], { filterAgentHooks: true });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.hook.kind).toBe("agent");
  });
});
