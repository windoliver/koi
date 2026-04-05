import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  AttachResult,
  ForgeScope,
  ProcessId,
  SubsystemToken,
  Tool,
} from "@koi/core";
import {
  agentId,
  COMPONENT_PRIORITY,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  isAttachResult,
} from "@koi/core";
import { createInheritedComponentProvider } from "./inherited-component-provider.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTool(name: string): Tool {
  return {
    descriptor: { name, description: `Mock tool ${name}`, inputSchema: { type: "object" } },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => ({ result: name }),
  };
}

function mockVerifiedTool(name: string): Tool {
  return {
    descriptor: { name, description: `Verified tool ${name}`, inputSchema: { type: "object" } },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async () => ({ result: name }),
  };
}

function mockPid(overrides?: Partial<ProcessId>): ProcessId {
  return {
    id: agentId("parent-001"),
    name: "parent",
    type: "copilot",
    depth: 0,
    ...overrides,
  };
}

function mockManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "parent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

/**
 * Creates a mock Agent whose `query("tool:")` returns the given tools map.
 * Tool map keys should be full token strings like "tool:calc".
 */
function mockParentAgent(tools: ReadonlyMap<string, Tool>): Agent {
  return {
    pid: mockPid(),
    manifest: mockManifest(),
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      if (prefix === "tool:") {
        return tools as unknown as ReadonlyMap<SubsystemToken<T>, T>;
      }
      return new Map();
    },
    components: () => tools as ReadonlyMap<string, unknown>,
  };
}

/** Creates a minimal mock child Agent (passed to attach()). */
function mockChildAgent(): Agent {
  return {
    pid: {
      id: agentId("child-001"),
      name: "child",
      type: "worker",
      depth: 1,
      parent: agentId("parent-001"),
    },
    manifest: mockManifest({ name: "child", version: "0.1.0" }),
    state: "created",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: () => new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInheritedComponentProvider", () => {
  test("has name inherited", () => {
    const parent = mockParentAgent(new Map());
    const provider = createInheritedComponentProvider({ parent });

    expect(provider.name).toBe("inherited");
  });

  test("inherits all parent tools when no scopeChecker provided", async () => {
    const tools = new Map<string, Tool>([
      ["tool:calc", mockTool("calc")],
      ["tool:search", mockTool("search")],
      ["tool:write", mockTool("write")],
    ]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({ parent });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(3);
    expect(result.has("tool:calc")).toBe(true);
    expect(result.has("tool:search")).toBe(true);
    expect(result.has("tool:write")).toBe(true);
  });

  test("inherits zone-scoped tools (scopeChecker returns zone)", async () => {
    const tools = new Map<string, Tool>([["tool:shared", mockTool("shared")]]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope => "zone";
    const provider = createInheritedComponentProvider({ parent, scopeChecker });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:shared")).toBe(true);
  });

  test("inherits global-scoped tools (scopeChecker returns global)", async () => {
    const tools = new Map<string, Tool>([["tool:global-util", mockTool("global-util")]]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope => "global";
    const provider = createInheritedComponentProvider({ parent, scopeChecker });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:global-util")).toBe(true);
  });

  test("excludes agent-scoped tools (scopeChecker returns agent)", async () => {
    const tools = new Map<string, Tool>([["tool:private", mockTool("private")]]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope => "agent";
    const provider = createInheritedComponentProvider({ parent, scopeChecker });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(0);
    expect(result.has("tool:private")).toBe(false);
  });

  test("inherits manifest-defined tools (scopeChecker returns undefined)", async () => {
    const tools = new Map<string, Tool>([["tool:manifest-tool", mockTool("manifest-tool")]]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope | undefined => undefined;
    const provider = createInheritedComponentProvider({ parent, scopeChecker });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:manifest-tool")).toBe(true);
  });

  test("empty parent (no tools) returns empty map", async () => {
    const parent = mockParentAgent(new Map());
    const provider = createInheritedComponentProvider({ parent });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(0);
  });

  test("mixed scopes: only zone/global/undefined pass through, agent excluded", async () => {
    const tools = new Map<string, Tool>([
      ["tool:zone-tool", mockTool("zone-tool")],
      ["tool:global-tool", mockTool("global-tool")],
      ["tool:agent-tool", mockTool("agent-tool")],
      ["tool:manifest-tool", mockTool("manifest-tool")],
    ]);
    const parent = mockParentAgent(tools);

    const scopeMap: Readonly<Record<string, ForgeScope | undefined>> = {
      "zone-tool": "zone",
      "global-tool": "global",
      "agent-tool": "agent",
      "manifest-tool": undefined,
    };
    const scopeChecker = (toolName: string): ForgeScope | undefined => scopeMap[toolName];
    const provider = createInheritedComponentProvider({ parent, scopeChecker });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(3);
    expect(result.has("tool:zone-tool")).toBe(true);
    expect(result.has("tool:global-tool")).toBe(true);
    expect(result.has("tool:manifest-tool")).toBe(true);
    expect(result.has("tool:agent-tool")).toBe(false);
  });

  test("stateless: concurrent attach() calls each query the parent independently", async () => {
    // Regression test for the removed mutable cache (Issue 6).
    // Two concurrent attach calls must not race — each independently queries
    // the parent's tool set and returns a correct result for its child.
    const tools = new Map<string, Tool>([["tool:calc", mockTool("calc")]]);
    const queryFn = mock((prefix: string): ReadonlyMap<string, unknown> => {
      if (prefix === "tool:") {
        return tools;
      }
      return new Map();
    });
    const parent: Agent = {
      ...mockParentAgent(tools),
      query: queryFn as unknown as Agent["query"],
    };
    const provider = createInheritedComponentProvider({ parent });

    // Concurrent spawn: two children assembled simultaneously from the same parent
    const [first, second] = await Promise.all([
      provider.attach(mockChildAgent()),
      provider.attach(mockChildAgent()),
    ]);

    const firstMap = extractMap(first);
    const secondMap = extractMap(second);

    // Both children must receive the correct tool set
    expect(firstMap.size).toBe(1);
    expect(firstMap.has("tool:calc")).toBe(true);
    expect(secondMap.size).toBe(1);
    expect(secondMap.has("tool:calc")).toBe(true);

    // query() called twice — once per attach() (stateless, no cache)
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test("concurrent attach() with different allowlists produce independent filtered results", async () => {
    // Two providers with different allowlists spawned from the same parent concurrently.
    // Each must return only its own allowed tools — no cross-contamination.
    const tools = new Map<string, Tool>([
      ["tool:Read", mockTool("Read")],
      ["tool:Grep", mockTool("Grep")],
      ["tool:Write", mockTool("Write")],
    ]);
    const parent = mockParentAgent(tools);

    const providerA = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set(["Read"]),
    });
    const providerB = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set(["Grep", "Write"]),
    });

    const [resultA, resultB] = await Promise.all([
      providerA.attach(mockChildAgent()),
      providerB.attach(mockChildAgent()),
    ]);

    const mapA = extractMap(resultA);
    const mapB = extractMap(resultB);

    expect(mapA.size).toBe(1);
    expect(mapA.has("tool:Read")).toBe(true);
    expect(mapA.has("tool:Grep")).toBe(false);

    expect(mapB.size).toBe(2);
    expect(mapB.has("tool:Grep")).toBe(true);
    expect(mapB.has("tool:Write")).toBe(true);
    expect(mapB.has("tool:Read")).toBe(false);
  });

  test("priority defaults to BUNDLED (100)", () => {
    const parent = mockParentAgent(new Map());
    const provider = createInheritedComponentProvider({ parent });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("filters to allowlist-only tools when toolAllowlist is set", async () => {
    const tools = new Map<string, Tool>([
      ["tool:Read", mockTool("Read")],
      ["tool:Grep", mockTool("Grep")],
      ["tool:Bash", mockTool("Bash")],
      ["tool:Write", mockTool("Write")],
    ]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set(["Read", "Grep"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(2);
    expect(result.has("tool:Read")).toBe(true);
    expect(result.has("tool:Grep")).toBe(true);
    expect(result.has("tool:Bash")).toBe(false);
    expect(result.has("tool:Write")).toBe(false);
  });

  test("allowlist respects scope filtering (agent-scoped excluded even if in allowlist)", async () => {
    const tools = new Map<string, Tool>([
      ["tool:Read", mockTool("Read")],
      ["tool:private", mockTool("private")],
    ]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (name: string): ForgeScope | undefined =>
      name === "private" ? "agent" : undefined;
    const provider = createInheritedComponentProvider({
      parent,
      scopeChecker,
      toolAllowlist: new Set(["Read", "private"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:Read")).toBe(true);
    expect(result.has("tool:private")).toBe(false);
  });

  test("tool trust tier is preserved in inherited tools", async () => {
    const verifiedTool = mockVerifiedTool("secure");
    const tools = new Map<string, Tool>([["tool:secure", verifiedTool]]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({ parent });

    const result = extractMap(await provider.attach(mockChildAgent()));

    const inherited = result.get("tool:secure") as Tool;
    expect(inherited).toBeDefined();
    expect(inherited.policy.sandbox).toBe(false);
    expect(inherited.descriptor.name).toBe("secure");
    expect(inherited).toBe(verifiedTool);
  });
});

// ---------------------------------------------------------------------------
// Adversarial filter pipeline interaction tests (Issue 11)
//
// Tests the three-stage pipeline: scope → denylist → allowlist.
// Each test targets a specific interaction between stages that could silently
// produce wrong results if the ordering or precedence is incorrect.
// ---------------------------------------------------------------------------

describe("filter pipeline stage interactions", () => {
  test("agent-scoped tool in allowlist is still excluded (scope wins over allowlist)", async () => {
    // If a tool is agent-scoped AND in the allowlist, scope exclusion must take
    // precedence. The allowlist cannot escalate an agent-local tool to inheritable.
    const tools = new Map<string, Tool>([
      ["tool:private", mockTool("private")],
      ["tool:public", mockTool("public")],
    ]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (name: string): ForgeScope | undefined =>
      name === "private" ? "agent" : "zone";
    const provider = createInheritedComponentProvider({
      parent,
      scopeChecker,
      toolAllowlist: new Set(["private", "public"]), // "private" in allowlist but agent-scoped
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:public")).toBe(true);
    expect(result.has("tool:private")).toBe(false); // scope wins
  });

  test("empty allowlist produces zero inherited tools regardless of parent size", async () => {
    // An empty allowlist means start-from-zero — no inherited tools at all.
    // This is the maximal-restriction case for the allowlist filter.
    const tools = new Map<string, Tool>([
      ["tool:Read", mockTool("Read")],
      ["tool:Grep", mockTool("Grep")],
      ["tool:Write", mockTool("Write")],
    ]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set([]), // explicitly empty — zero tools allowed
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(0);
  });

  test("all parent tools agent-scoped with non-empty allowlist still yields zero", async () => {
    // Even if allowlist contains names, scope exclusion runs first.
    // If all parent tools are agent-scoped, the child gets nothing.
    const tools = new Map<string, Tool>([
      ["tool:ToolA", mockTool("ToolA")],
      ["tool:ToolB", mockTool("ToolB")],
    ]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope => "agent"; // all agent-local
    const provider = createInheritedComponentProvider({
      parent,
      scopeChecker,
      toolAllowlist: new Set(["ToolA", "ToolB"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(0);
  });

  test("denylist applied after scope: denying a zone-scoped tool excludes it", async () => {
    // A zone-scoped tool passes the scope filter but is then excluded by denylist.
    // Order: scope(pass zone) → denylist(exclude ToolB) → result excludes ToolB.
    const tools = new Map<string, Tool>([
      ["tool:ToolA", mockTool("ToolA")],
      ["tool:ToolB", mockTool("ToolB")],
    ]);
    const parent = mockParentAgent(tools);
    const scopeChecker = (): ForgeScope => "zone";
    const provider = createInheritedComponentProvider({
      parent,
      scopeChecker,
      toolDenylist: new Set(["ToolB"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:ToolA")).toBe(true);
    expect(result.has("tool:ToolB")).toBe(false);
  });

  test("denylist does not affect tools absent from parent (no phantom exclusions)", async () => {
    // Denylisting a tool name that does not exist in the parent should be a no-op.
    // This verifies the denylist does not accidentally manufacture absent tools.
    const tools = new Map<string, Tool>([["tool:ToolA", mockTool("ToolA")]]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({
      parent,
      toolDenylist: new Set(["ToolB", "ToolC", "ToolD"]), // none exist in parent
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:ToolA")).toBe(true);
  });

  test("allowlist with tool names not present in parent yields only intersection", async () => {
    // The allowlist specifies names that don't exist in the parent alongside ones that do.
    // Only names that are both in the allowlist AND in the parent's actual tools are inherited.
    const tools = new Map<string, Tool>([
      ["tool:Read", mockTool("Read")],
      ["tool:Grep", mockTool("Grep")],
    ]);
    const parent = mockParentAgent(tools);
    const provider = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set(["Read", "NonExistent", "AlsoMissing"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));

    expect(result.size).toBe(1);
    expect(result.has("tool:Read")).toBe(true);
    expect(result.has("tool:Grep")).toBe(false); // not in allowlist
    // NonExistent and AlsoMissing: no phantom entries
    expect(result.has("tool:NonExistent")).toBe(false);
  });

  test("zero parent tools always yields zero inherited tools regardless of config", async () => {
    // Confirmed edge case: no tools to inherit regardless of filter config.
    const parent = mockParentAgent(new Map());
    const provider = createInheritedComponentProvider({
      parent,
      toolAllowlist: new Set(["Read", "Grep"]),
    });

    const result = extractMap(await provider.attach(mockChildAgent()));
    expect(result.size).toBe(0);
  });
});
