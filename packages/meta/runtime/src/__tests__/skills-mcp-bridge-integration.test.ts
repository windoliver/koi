/**
 * Integration test: skills-mcp bridge with real SkillsRuntime.
 *
 * Requires workspace deps to be built (`bun run build`).
 * Run via: `bun run test --filter=@koi/runtime`
 */
import { describe, expect, mock, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import type { McpResolver } from "@koi/mcp";
import { createSkillsRuntime } from "@koi/skills-runtime";
import { createSkillsMcpBridge } from "../skills-mcp-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function descriptor(name: string, server?: string, tags?: readonly string[]): ToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(server !== undefined ? { server } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

interface MockResolver {
  readonly discover: ReturnType<typeof mock>;
  readonly onChange: ReturnType<typeof mock>;
  readonly dispose: ReturnType<typeof mock>;
  readonly failures: readonly never[];
  readonly fireChange: () => void;
}

function createMockResolver(tools: readonly ToolDescriptor[] = []): MockResolver {
  let listener: (() => void) | undefined;
  const unsubscribe = mock(() => {
    listener = undefined;
  });

  return {
    discover: mock(() => Promise.resolve(tools)),
    onChange: mock((fn: () => void) => {
      listener = fn;
      return unsubscribe;
    }),
    dispose: mock(() => {}),
    failures: [],
    fireChange: () => listener?.(),
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("skills-mcp bridge integration", () => {
  test("MCP tools appear as skills via real SkillsRuntime", async () => {
    const tools = [
      descriptor("alpha__search", "alpha", ["ai"]),
      descriptor("alpha__read", "alpha"),
    ];
    const resolver = createMockResolver(tools);
    const runtime = createSkillsRuntime({ bundledRoot: null });

    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime,
    });

    await bridge.sync();

    // Skills visible via discover()
    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has("alpha__search")).toBe(true);
    expect(result.value.has("alpha__read")).toBe(true);
    expect(result.value.get("alpha__search")?.source).toBe("mcp");

    // Skills queryable by source
    const query = await runtime.query({ source: "mcp" });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value).toHaveLength(2);

    // Skills loadable
    const loaded = await runtime.load("alpha__search");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.source).toBe("mcp");
    // Body is the safe generated description, not raw MCP text
    expect(loaded.value.body).toBe('MCP tool "alpha__search" from server "alpha".');

    bridge.dispose();

    // After dispose, skills are cleared
    const afterDispose = await runtime.query({ source: "mcp" });
    expect(afterDispose.ok).toBe(true);
    if (!afterDispose.ok) return;
    expect(afterDispose.value).toHaveLength(0);
  });

  test("onChange updates real SkillsRuntime with new tools", async () => {
    const initialTools = [descriptor("srv__a", "srv")];
    const resolver = createMockResolver(initialTools);
    const runtime = createSkillsRuntime({ bundledRoot: null });

    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime,
    });

    await bridge.sync();

    // Add a tool and fire onChange
    const updatedTools = [descriptor("srv__a", "srv"), descriptor("srv__b", "srv")];
    resolver.discover.mockImplementation(() => Promise.resolve(updatedTools));
    resolver.fireChange();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await runtime.query({ source: "mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.some((s) => s.name === "srv__b")).toBe(true);

    bridge.dispose();
  });
});
