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
  let origStrict: string | undefined;

  function writeHooksJson(body: string): void {
    const dir = join(fakeHome, ".koi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hooks.json"), body, "utf8");
  }

  beforeEach(() => {
    origHome = process.env.HOME;
    origStrict = process.env.KOI_HOOKS_STRICT;
    fakeHome = mkdtempSync(join(tmpdir(), "koi-user-hooks-"));
    process.env.HOME = fakeHome;
    // Default every test to lenient mode; strict-mode tests opt in explicitly.
    delete process.env.KOI_HOOKS_STRICT;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (origStrict === undefined) {
      delete process.env.KOI_HOOKS_STRICT;
    } else {
      process.env.KOI_HOOKS_STRICT = origStrict;
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

  test("degrades to warning + empty load when hooks.json cannot be parsed", async () => {
    // A truncated write, merge conflict, or transient editor save must not
    // lock the operator out of `koi tui` / `koi start`. Partial/empty load
    // is preferable to a machine-wide outage for an optional per-user config
    // (review round 6). Operators who need fail-closed behaviour mark
    // individual hooks `failClosed: true`.
    writeHooksJson("not-json");
    const errors: string[] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: (m) => errors.push(m),
    });
    expect(hooks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Could not read");
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

  test("degrades to warning + empty load when hooks.json root is not an array", async () => {
    // Structural root errors are treated as non-fatal for availability
    // reasons (round 6): better to warn and start empty than to lock the
    // operator out on a malformed optional config.
    writeHooksJson(JSON.stringify({ preToolUse: [{ command: "echo" }] }));
    const errors: string[] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: (m) => errors.push(m),
    });
    expect(hooks).toEqual([]);
    expect(errors.some((m) => m.includes("array"))).toBe(true);
  });

  test("aborts startup when a failClosed replacement duplicates a stale entry (review round 7)", async () => {
    // Replacement-in-place: operator edited a deny hook, left the old copy
    // above it, and marked the replacement failClosed:true. The stricter
    // replacement must not silently defer to the stale definition.
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "deny", cmd: ["/bin/true"] },
        {
          kind: "command",
          name: "deny",
          cmd: ["/bin/strict"],
          failClosed: true,
        },
      ]),
    );
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*failClosed.*"deny"/);
    expect(errors.some((m) => m.includes("Duplicate"))).toBe(true);
  });

  test("keeps first occurrence on duplicate hook names and warns (issue #1781 availability)", async () => {
    // Duplicate names warn but do not abort startup. Operators who want a
    // failing duplicate to be fatal mark the entry `failClosed: true`.
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "audit", cmd: ["/bin/true"] },
        { kind: "command", name: "audit", cmd: ["/bin/strict"] },
      ]),
    );
    const errors: string[] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: (m) => errors.push(m),
    });
    expect(hooks).toHaveLength(1);
    expect(errors.some((m) => m.includes("Duplicate"))).toBe(true);
  });

  // ---------- KOI_HOOKS_STRICT=1 (policy-bearing mode) ----------

  test("strict mode: parse errors abort startup", async () => {
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson("not-json");
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*KOI_HOOKS_STRICT=1/);
    expect(errors.some((m) => m.includes("Could not read"))).toBe(true);
  });

  test("strict mode: non-array root aborts startup", async () => {
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(JSON.stringify({ preToolUse: [{ command: "echo" }] }));
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: () => {},
      }),
    ).rejects.toThrow(/Refusing to start.*KOI_HOOKS_STRICT=1.*root.*array/);
  });

  test("strict mode: ordinary schema error aborts startup", async () => {
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "command", name: "bad", cmd: [] },
      ]),
    );
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: () => {},
      }),
    ).rejects.toThrow(/Refusing to start.*KOI_HOOKS_STRICT=1.*"bad"/);
  });

  test("strict mode: unmarked duplicate aborts startup", async () => {
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "dup", cmd: ["/bin/true"] },
        { kind: "command", name: "dup", cmd: ["/bin/true"] },
      ]),
    );
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: () => {},
      }),
    ).rejects.toThrow(/Refusing to start.*KOI_HOOKS_STRICT=1.*"dup"/);
  });

  test("strict mode: any agent entry aborts under filterAgentHooks:true", async () => {
    // Strict mode operator opted into "fail on anything the loader cannot
    // honor" — silently dropping unsupported agent hooks is exactly the
    // class of bypass strict mode exists to prevent (review round 7 new).
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "agent", name: "verify", prompt: "check" },
      ]),
    );
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: true,
        onAgentHooksFiltered: () => {},
        onLoadError: () => {},
      }),
    ).rejects.toThrow(/Refusing to start.*agent hook.*KOI_HOOKS_STRICT=1/);
  });

  test("strict mode: unnamed agent entry also aborts (review round 8 new)", async () => {
    // Regression: an agent entry without a parseable `name` used to slip
    // through the strict-mode gate because it didn't populate `agentNames`.
    // The gate now counts every filtered agent-kind entry.
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "agent", prompt: "deny" }, // no name
        { kind: "agent", name: 7, prompt: "deny" }, // non-string name
      ]),
    );
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: true,
        onAgentHooksFiltered: () => {},
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*2 agent hook.*KOI_HOOKS_STRICT=1/);
    expect(errors.some((m) => m.includes("without a parseable name"))).toBe(true);
  });

  test("lenient mode: failClosed:true agent entry aborts even under filterAgentHooks", async () => {
    // The per-hook failClosed opt-in is an explicit contract — even
    // outside strict mode, an agent hook marked load-critical cannot be
    // silently dropped by a host that doesn't support agent hooks
    // (review round 7 new finding).
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "agent", name: "critical", prompt: "deny", failClosed: true },
      ]),
    );
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: true,
        onAgentHooksFiltered: () => {},
        onLoadError: () => {},
      }),
    ).rejects.toThrow(/Refusing to start.*agent hook.*failClosed.*"critical"/);
  });

  test("strict mode: clean file loads normally", async () => {
    process.env.KOI_HOOKS_STRICT = "1";
    writeHooksJson(JSON.stringify([{ kind: "command", name: "clean", cmd: ["/bin/true"] }]));
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: false,
      onLoadError: () => {},
    });
    expect(hooks.map((rh) => rh.hook.name)).toEqual(["clean"]);
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

  test("pre-filters non-failClosed agent entries so invalid agent hooks cannot brick TUI startup (review round 5 finding)", async () => {
    // All of these would otherwise be fatal under filterAgentHooks:true —
    // duplicate agent name + schema-invalid agent. The TUI does not support
    // agent hooks, and operators who share a hooks.json across hosts should
    // not be locked out of the TUI by a host they aren't currently using.
    // (Agents marked `failClosed: true` do abort; see the round-7 test.)
    writeHooksJson(
      JSON.stringify([
        { kind: "command", name: "good", cmd: ["/bin/true"] },
        { kind: "agent", name: "dup", prompt: "verify" },
        { kind: "agent", name: "dup", prompt: "verify" },
        { kind: "agent", name: "broken", prompt: "" },
      ]),
    );
    const filtered: string[][] = [];
    const hooks = await loadUserRegisteredHooks({
      filterAgentHooks: true,
      onAgentHooksFiltered: (names) => filtered.push([...names]),
    });
    expect(hooks.map((rh) => rh.hook.name)).toEqual(["good"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual(["dup", "dup", "broken"]);
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
