import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookConfig } from "@koi/core";
import type { McpServerConfig } from "@koi/mcp";
import {
  __setUserHooksConfigPathForTests,
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
  let origStrict: string | undefined;

  function writeHooksJson(body: string): void {
    const dir = join(fakeHome, ".koi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hooks.json"), body, "utf8");
  }

  beforeEach(() => {
    origStrict = process.env.KOI_HOOKS_STRICT;
    fakeHome = mkdtempSync(join(tmpdir(), "koi-user-hooks-"));
    // Use the explicit test seam instead of redirecting $HOME — runtime
    // path resolution trusts `os.homedir()`, not the env var, for
    // trust-boundary reasons (review round 9 finding).
    __setUserHooksConfigPathForTests(join(fakeHome, ".koi", "hooks.json"));
    // Default every test to lenient mode; strict-mode tests opt in explicitly.
    delete process.env.KOI_HOOKS_STRICT;
  });

  afterEach(() => {
    __setUserHooksConfigPathForTests(undefined);
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

  test("aborts startup when hooks.json cannot be parsed (fail-closed default)", async () => {
    // File-level corruption cannot be treated as "no hooks configured" —
    // a failClosed hook could be in the file and we cannot see it, so the
    // only safe response is to refuse startup (third-loop review round 1).
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

  test("aborts startup when hooks.json root is not an array (fail-closed default)", async () => {
    // Non-array roots cannot be enumerated for per-entry failClosed intent,
    // so we cannot tell whether a critical hook was meant to be present.
    // Same reasoning as the parse-failure branch.
    writeHooksJson(JSON.stringify({ preToolUse: [{ command: "echo" }] }));
    const errors: string[] = [];
    await expect(
      loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: (m) => errors.push(m),
      }),
    ).rejects.toThrow(/Refusing to start.*structurally invalid/);
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

  test("rejects relative KOI_HOOKS_CONFIG_PATH (review third-loop r2)", async () => {
    // A relative path defeats the trust-boundary fix by making resolution
    // cwd-dependent.
    __setUserHooksConfigPathForTests(undefined);
    const origPath = process.env.KOI_HOOKS_CONFIG_PATH;
    process.env.KOI_HOOKS_CONFIG_PATH = "hooks.json";
    try {
      await expect(
        loadUserRegisteredHooks({
          filterAgentHooks: false,
          onLoadError: () => {},
        }),
      ).rejects.toThrow(/Refusing to start.*must be an absolute path/);
    } finally {
      if (origPath === undefined) {
        delete process.env.KOI_HOOKS_CONFIG_PATH;
      } else {
        process.env.KOI_HOOKS_CONFIG_PATH = origPath;
      }
      __setUserHooksConfigPathForTests(join(fakeHome, ".koi", "hooks.json"));
    }
  });

  test("KOI_HOOKS_CONFIG_PATH pins loader path regardless of HOME", async () => {
    // Deployment-override trust-boundary fix: HOME-preserving launchers
    // (sudo -E, launchd, etc.) should be able to pin the hook file to a
    // fixed absolute path.
    const altDir = mkdtempSync(join(tmpdir(), "koi-hooks-override-"));
    const altPath = join(altDir, "fixed-hooks.json");
    writeFileSync(
      altPath,
      JSON.stringify([{ kind: "command", name: "pinned", cmd: ["/bin/true"] }]),
      "utf8",
    );
    // Unset the test seam so the real env-var path is exercised.
    __setUserHooksConfigPathForTests(undefined);
    const origPath = process.env.KOI_HOOKS_CONFIG_PATH;
    process.env.KOI_HOOKS_CONFIG_PATH = altPath;
    try {
      const hooks = await loadUserRegisteredHooks({
        filterAgentHooks: false,
        onLoadError: () => {},
      });
      expect(hooks.map((rh) => rh.hook.name)).toEqual(["pinned"]);
    } finally {
      if (origPath === undefined) {
        delete process.env.KOI_HOOKS_CONFIG_PATH;
      } else {
        process.env.KOI_HOOKS_CONFIG_PATH = origPath;
      }
      // Restore the test seam for the next test's beforeEach.
      __setUserHooksConfigPathForTests(join(fakeHome, ".koi", "hooks.json"));
      rmSync(altDir, { recursive: true, force: true });
    }
  });

  // ---------- KOI_HOOKS_STRICT=1 (tightens per-entry handling) ----------
  //
  // Parse failures and structural root errors are now fatal regardless of
  // strict mode — see the default-mode tests above. Strict mode exists to
  // turn ORDINARY per-entry schema errors and duplicate names fatal too.

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
    const filtered: string[][] = [];
    const merged = mergeUserAndPluginHooks([], plugin, {
      filterAgentHooks: true,
      onFilteredAgentHooks: (names) => filtered.push([...names]),
    });
    const names = merged.map((rh) => rh.hook.name);
    expect(names).toEqual(["p1", "p3"]);
    expect(filtered).toEqual([["p2"]]);
  });

  test("does not filter agent hooks when filterAgentHooks is false", () => {
    const plugin = [commandHook("p1"), agentHook("p2")];
    const merged = mergeUserAndPluginHooks([], plugin, { filterAgentHooks: false });
    expect(merged).toHaveLength(2);
  });

  test("aborts when a plugin agent hook is marked failClosed:true (review third-loop r2)", () => {
    const plugin: HookConfig[] = [
      commandHook("p1"),
      { kind: "agent", name: "critical-plugin", prompt: "deny", failClosed: true },
    ];
    expect(() =>
      mergeUserAndPluginHooks([], plugin, {
        filterAgentHooks: true,
      }),
    ).toThrow(/Refusing to start.*plugin agent hook.*failClosed.*"critical-plugin"/);
  });

  test("aborts on plugin agent hooks under KOI_HOOKS_STRICT=1 (review third-loop r2)", () => {
    const origStrict = process.env.KOI_HOOKS_STRICT;
    process.env.KOI_HOOKS_STRICT = "1";
    try {
      const plugin = [commandHook("p1"), agentHook("plugin-agent")];
      expect(() =>
        mergeUserAndPluginHooks([], plugin, {
          filterAgentHooks: true,
        }),
      ).toThrow(/Refusing to start.*1 plugin agent hook.*KOI_HOOKS_STRICT=1/);
    } finally {
      if (origStrict === undefined) {
        delete process.env.KOI_HOOKS_STRICT;
      } else {
        process.env.KOI_HOOKS_STRICT = origStrict;
      }
    }
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
