import { describe, expect, test } from "bun:test";
import type { Agent, AttachResult, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, DEFAULT_SANDBOXED_POLICY, isAttachResult, toolToken } from "@koi/core";
import { createToolComponentProvider } from "./tool-provider.js";

function fakeTool(name: string, origin: import("@koi/core").ToolOrigin = "operator"): Tool {
  return {
    descriptor: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object" },
      origin,
    },
    origin,
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => "ok",
  };
}

/** Minimal Agent stub — only pid is needed for attach(). */
const stubAgent: Agent = {
  pid: {
    id: "agent-1" as ReturnType<typeof import("@koi/core").agentId>,
    name: "stub",
    type: "worker",
    depth: 0,
  },
  manifest: {} as Agent["manifest"],
  state: "created",
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

/** Helper: extract components map from AttachResult. */
async function attachComponents(
  provider: ReturnType<typeof createToolComponentProvider>,
): Promise<ReadonlyMap<string, unknown>> {
  const result = await provider.attach(stubAgent);
  if (isAttachResult(result)) return result.components;
  return result;
}

describe("createToolComponentProvider", () => {
  test("returns a ComponentProvider with the given name and priority", () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });
    expect(provider.name).toBe("test-provider");
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("uses the exact priority value provided", () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [fakeTool("forged-tool", "forged")],
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
    });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });

  test("attach() returns AttachResult with tools keyed by toolToken(name)", async () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [fakeTool("beta"), fakeTool("alpha")],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const result = await provider.attach(stubAgent);
    expect(isAttachResult(result)).toBe(true);
    const map = (result as AttachResult).components;
    expect(map.get(toolToken("alpha") as string)).toBeDefined();
    expect(map.get(toolToken("beta") as string)).toBeDefined();
    expect((result as AttachResult).skipped).toEqual([]);
  });

  test("attach() deduplicates and sorts tools", async () => {
    const opTool = fakeTool("dup");
    const primTool: Tool = {
      ...fakeTool("dup"),
      origin: "primordial",
      descriptor: { ...fakeTool("dup").descriptor, origin: "primordial" },
    };

    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [opTool, primTool],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const map = await attachComponents(provider);
    const tool = map.get(toolToken("dup") as string) as Tool;
    expect(tool.origin).toBe("primordial");
  });

  test("attach() returns empty components for empty tools", async () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const map = await attachComponents(provider);
    expect(map.size).toBe(0);
  });

  test("freezes tool objects so post-construction mutation throws", async () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [fakeTool("frozen")],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const map = await attachComponents(provider);
    const attached = map.get(toolToken("frozen") as string) as Tool;

    expect(() => {
      (attached as unknown as Record<string, unknown>).origin = "forged";
    }).toThrow();
  });

  test("deep-freezes nested descriptor and policy fields", async () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [fakeTool("deep-frozen")],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const map = await attachComponents(provider);
    const attached = map.get(toolToken("deep-frozen") as string) as Tool;

    expect(() => {
      (attached.descriptor as unknown as Record<string, unknown>).name = "hacked";
    }).toThrow();
    expect(() => {
      (attached.descriptor.inputSchema as unknown as Record<string, unknown>).injected = true;
    }).toThrow();
    expect(() => {
      (attached.policy.capabilities as unknown as Record<string, unknown>).network = {
        allow: true,
      };
    }).toThrow();
  });

  test("does not freeze caller-owned tool objects", () => {
    const tool = fakeTool("mutable");
    createToolComponentProvider({
      name: "test-provider",
      tools: [tool],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    expect(() => {
      (tool as unknown as Record<string, unknown>).origin = "forged";
    }).not.toThrow();
  });

  test("each attach() returns independent components map", async () => {
    const provider = createToolComponentProvider({
      name: "test-provider",
      tools: [fakeTool("a")],
      priority: COMPONENT_PRIORITY.BUNDLED,
    });

    const r1 = await provider.attach(stubAgent);
    const map1 = (r1 as AttachResult).components as Map<string, unknown>;
    map1.delete(toolToken("a") as string);
    expect(map1.size).toBe(0);

    const map2 = await attachComponents(provider);
    expect(map2.size).toBe(1);
  });
});
