import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSystemBackend, HookConfig } from "@koi/core";
import type { McpServerConfig } from "@koi/mcp";
import {
  buildCoreProviders,
  buildPluginMcpSetup,
  loadUserMcpSetup,
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
// mergeUserAndPluginHooks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildCoreProviders — filesystem operation gating
// ---------------------------------------------------------------------------

// Stub backend — buildCoreProviders does not call into it at assembly time
// (createFsReadTool et al are deferred to provider.attach()), so a marker
// object satisfies the branch under test.
const stubBackend: FileSystemBackend = {
  name: "stub",
  read: async () => ({ ok: false, error: { code: "INTERNAL", message: "stub", retryable: false } }),
  write: async () => ({
    ok: false,
    error: { code: "INTERNAL", message: "stub", retryable: false },
  }),
  edit: async () => ({ ok: false, error: { code: "INTERNAL", message: "stub", retryable: false } }),
} as unknown as FileSystemBackend;

describe("buildCoreProviders: filesystem operation gating", () => {
  test("host default (no manifest filesystem) wires all three fs tools", () => {
    const providers = buildCoreProviders({ cwd: mkTempCwd(), includeWebFetch: false });
    const names = providers.map((p) => p.name);
    expect(names).toContain("fs-read");
    expect(names).toContain("fs-write");
    expect(names).toContain("fs-edit");
  });

  test("filesystemOperations=[read] gates to read-only even without a supplied backend", () => {
    // Regression for #1777: hosts apply the `FileSystemConfig.operations`
    // default (`["read"]`) at the callsite before invoking this builder.
    // `filesystemOperations` must be honored verbatim — including when no
    // custom backend is supplied, so a manifest that sets
    // `filesystem: { backend: local, operations: [read] }` runs read-only
    // on the default local backend.
    const providers = buildCoreProviders({
      cwd: mkTempCwd(),
      filesystemOperations: ["read"],
      includeWebFetch: false,
    });
    const names = providers.map((p) => p.name);
    expect(names).toContain("fs-read");
    expect(names).not.toContain("fs-write");
    expect(names).not.toContain("fs-edit");
  });

  test("filesystemOperations=[read,write] wires only those tools", () => {
    const providers = buildCoreProviders({
      cwd: mkTempCwd(),
      filesystem: stubBackend,
      filesystemOperations: ["read", "write"],
      includeWebFetch: false,
    });
    const names = providers.map((p) => p.name);
    expect(names).toContain("fs-read");
    expect(names).toContain("fs-write");
    expect(names).not.toContain("fs-edit");
  });

  test("filesystemOperations=[read,write,edit] wires all three", () => {
    const providers = buildCoreProviders({
      cwd: mkTempCwd(),
      filesystem: stubBackend,
      filesystemOperations: ["read", "write", "edit"],
      includeWebFetch: false,
    });
    const names = providers.map((p) => p.name);
    expect(names).toContain("fs-read");
    expect(names).toContain("fs-write");
    expect(names).toContain("fs-edit");
  });

  test("no manifest, no operations: legacy host-default wires all three", () => {
    // Ensures the "manifest defaults to read-only" logic lives at the
    // host callsite (start.ts / tui-command.ts), not here — the
    // host-default local path has no manifest signal and must keep all
    // three tools wired so the permission middleware remains the gate.
    const providers = buildCoreProviders({
      cwd: mkTempCwd(),
      filesystem: stubBackend,
      includeWebFetch: false,
    });
    const names = providers.map((p) => p.name);
    expect(names).toContain("fs-read");
    expect(names).toContain("fs-write");
    expect(names).toContain("fs-edit");
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
