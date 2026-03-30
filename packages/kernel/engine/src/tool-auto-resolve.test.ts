import { describe, expect, spyOn, test } from "bun:test";
import type { Agent, AgentManifest, ComponentProvider, Tool, ToolRegistration } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import type { AssemblyConflict } from "./agent-entity.js";
import { resolveToolPackages, validateManifestTools } from "./tool-auto-resolve.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function stubTool(name: string): Tool {
  return {
    descriptor: { name, description: `${name} tool`, inputSchema: {} },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async () => `${name} result`,
  };
}

function stubRegistration(name: string, toolNames: readonly string[]): ToolRegistration {
  return {
    name,
    tools: toolNames.map((n) => ({ name: n, create: () => stubTool(n) })),
  };
}

function stubProviderFactory(registration: ToolRegistration): ComponentProvider {
  return {
    name: registration.name,
    attach: async () => {
      const components = new Map<string, unknown>();
      for (const tf of registration.tools) {
        components.set(toolToken(tf.name) as string, stubTool(tf.name));
      }
      return { components, skipped: [] };
    },
  };
}

function stubAgent(toolNames: readonly string[]): Agent {
  const components = new Map<string, unknown>();
  for (const name of toolNames) {
    components.set(toolToken(name) as string, stubTool(name));
  }
  return {
    pid: {
      id: "test-agent" as import("@koi/core").AgentId,
      name: "test",
      type: "copilot",
      depth: 0,
    },
    manifest: testManifest(),
    state: "created",
    component: (token) => components.get(token as string) as undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

// ---------------------------------------------------------------------------
// resolveToolPackages
// ---------------------------------------------------------------------------

describe("resolveToolPackages", () => {
  test("returns empty array when no tools have package field", async () => {
    const manifest = testManifest({ tools: [{ name: "my_tool" }] });
    const providers = await resolveToolPackages(manifest, undefined, stubProviderFactory);
    expect(providers).toHaveLength(0);
  });

  test("returns empty array when manifest has no tools", async () => {
    const manifest = testManifest();
    const providers = await resolveToolPackages(manifest, undefined, stubProviderFactory);
    expect(providers).toHaveLength(0);
  });

  test("resolves a single package into a provider", async () => {
    const manifest = testManifest({
      tools: [{ name: "audit_log", package: "@koi/middleware-audit" }],
    });
    const resolver = async (_pkg: string) => ({
      registration: stubRegistration("audit", ["audit_log"]),
    });
    const providers = await resolveToolPackages(manifest, resolver, stubProviderFactory);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("audit");
  });

  test("resolves multiple packages in parallel", async () => {
    const manifest = testManifest({
      tools: [
        { name: "tool_a", package: "@koi/pkg-a" },
        { name: "tool_b", package: "@koi/pkg-b" },
      ],
    });
    const resolver = async (pkg: string) => ({
      registration: stubRegistration(pkg, [pkg === "@koi/pkg-a" ? "tool_a" : "tool_b"]),
    });
    const providers = await resolveToolPackages(manifest, resolver, stubProviderFactory);
    expect(providers).toHaveLength(2);
  });

  test("deduplicates same package referenced by multiple tools", async () => {
    const resolverCalls: string[] = [];
    const manifest = testManifest({
      tools: [
        { name: "tool_a", package: "@koi/shared-pkg" },
        { name: "tool_b", package: "@koi/shared-pkg" },
      ],
    });
    const resolver = async (pkg: string) => {
      resolverCalls.push(pkg);
      return { registration: stubRegistration("shared", ["tool_a", "tool_b"]) };
    };
    const providers = await resolveToolPackages(manifest, resolver, stubProviderFactory);
    expect(providers).toHaveLength(1);
    expect(resolverCalls).toHaveLength(1); // Only imported once
  });

  test("skips and warns on import failure", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({
      tools: [
        { name: "good_tool", package: "@koi/good-pkg" },
        { name: "bad_tool", package: "@koi/bad-pkg" },
      ],
    });
    const resolver = async (pkg: string) => {
      if (pkg === "@koi/bad-pkg") throw new Error("Module not found");
      return { registration: stubRegistration("good", ["good_tool"]) };
    };
    const providers = await resolveToolPackages(manifest, resolver, stubProviderFactory);
    expect(providers).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("@koi/bad-pkg");
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// validateManifestTools
// ---------------------------------------------------------------------------

describe("validateManifestTools", () => {
  test("no warnings when all manifest tools are present", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({ tools: [{ name: "my_tool" }] });
    const agent = stubAgent(["my_tool"]);
    validateManifestTools(manifest, agent, []);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("warns when manifest tool is missing (no package)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({ tools: [{ name: "missing_tool" }] });
    const agent = stubAgent([]);
    validateManifestTools(manifest, agent, []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("missing_tool");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("explicit provider");
    warnSpy.mockRestore();
  });

  test("warns when manifest tool is missing (with package)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({
      tools: [{ name: "missing_tool", package: "@koi/some-pkg" }],
    });
    const agent = stubAgent([]);
    validateManifestTools(manifest, agent, []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("@koi/some-pkg");
    warnSpy.mockRestore();
  });

  test("warns on tool conflicts with provenance", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({ tools: [{ name: "my_tool" }] });
    const agent = stubAgent(["my_tool"]);
    const conflicts: AssemblyConflict[] = [
      { key: "tool:my_tool", winner: "provider-a", shadowed: ["provider-b"] },
    ];
    validateManifestTools(manifest, agent, conflicts);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("provider-a");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("provider-b");
    warnSpy.mockRestore();
  });

  test("no warnings when manifest has no tools", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest();
    const agent = stubAgent([]);
    validateManifestTools(manifest, agent, []);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
