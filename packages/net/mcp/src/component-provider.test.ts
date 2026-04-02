import { describe, expect, test } from "bun:test";
import type { Agent, Resolver, Tool, ToolDescriptor } from "@koi/core";
import { agentId, isAttachResult } from "@koi/core";
import { createMockConnection } from "./__tests__/mock-connection.js";
import { createMcpComponentProvider } from "./component-provider.js";
import { createMcpResolver } from "./resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(): Agent {
  return {
    pid: { id: agentId("test-1"), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "test-model" },
      tools: [],
      channels: [],
      middleware: [],
    },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

// ---------------------------------------------------------------------------
// Contract conformance: McpResolver satisfies Resolver<ToolDescriptor, Tool>
// ---------------------------------------------------------------------------

describe("McpResolver contract conformance", () => {
  test("McpResolver structurally satisfies Resolver<ToolDescriptor, Tool>", () => {
    const conn = createMockConnection("srv", [
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    // Compile-time check: McpResolver assignable to Resolver<ToolDescriptor, Tool>
    const _r: Resolver<ToolDescriptor, Tool> = resolver;
    expect(typeof _r.discover).toBe("function");
    expect(typeof _r.load).toBe("function");
    expect(typeof _r.onChange).toBe("function");
    // source is not defined on MCP resolver
    expect(_r.source).toBeUndefined();

    resolver.dispose();
  });

  test("discover returns readonly ToolDescriptor array", async () => {
    const conn = createMockConnection("srv", [
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    const descriptors = await resolver.discover();
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toHaveProperty("name");
    expect(descriptors[0]).toHaveProperty("description");
    expect(descriptors[0]).toHaveProperty("inputSchema");

    resolver.dispose();
  });

  test("load returns Result<Tool, KoiError>", async () => {
    const conn = createMockConnection(
      "srv",
      [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      { t: { ok: true, value: "result" } },
    );
    const resolver = createMcpResolver([conn]);

    const success = await resolver.load("srv__t");
    expect(success).toHaveProperty("ok", true);
    if (success.ok) {
      expect(success.value).toHaveProperty("descriptor");
      expect(success.value).toHaveProperty("origin");
      expect(success.value).toHaveProperty("policy");
      expect(success.value).toHaveProperty("execute");
    }

    const failure = await resolver.load("srv__nonexistent");
    expect(failure).toHaveProperty("ok", false);
    if (!failure.ok) {
      expect(failure.error).toHaveProperty("code");
      expect(failure.error).toHaveProperty("message");
      expect(failure.error).toHaveProperty("retryable");
    }

    resolver.dispose();
  });
});

// ---------------------------------------------------------------------------
// ComponentProvider: happy path
// ---------------------------------------------------------------------------

describe("createMcpComponentProvider", () => {
  test("provider has name 'mcp'", () => {
    const conn = createMockConnection("srv", []);
    const resolver = createMcpResolver([conn]);
    const provider = createMcpComponentProvider({ resolver });
    expect(provider.name).toBe("mcp");
    resolver.dispose();
  });

  test("attach returns AttachResult with tools as components", async () => {
    const conn = createMockConnection(
      "srv",
      [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "add", description: "Add", inputSchema: { type: "object" } },
      ],
      {
        echo: { ok: true, value: [{ type: "text", text: "hi" }] },
        add: { ok: true, value: [{ type: "text", text: "3" }] },
      },
    );
    const resolver = createMcpResolver([conn]);
    const provider = createMcpComponentProvider({ resolver });
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    expect(isAttachResult(result)).toBe(true);
    if (isAttachResult(result)) {
      expect(result.components.size).toBe(2);
      expect(result.skipped).toHaveLength(0);

      // Verify tool keys are tool tokens
      const keys = [...result.components.keys()];
      expect(keys.some((k) => k.includes("echo"))).toBe(true);
      expect(keys.some((k) => k.includes("add"))).toBe(true);
    }

    resolver.dispose();
  });

  test("attached tool can execute", async () => {
    const conn = createMockConnection(
      "srv",
      [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      {
        echo: { ok: true, value: [{ type: "text", text: "hello" }] },
      },
    );
    const resolver = createMcpResolver([conn]);
    const provider = createMcpComponentProvider({ resolver });
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    if (isAttachResult(result)) {
      const tool = [...result.components.values()][0] as Tool;
      const execResult = await tool.execute({ msg: "hi" });
      expect(execResult).toEqual([{ type: "text", text: "hello" }]);
    }

    resolver.dispose();
  });
});

// ---------------------------------------------------------------------------
// ComponentProvider: failure handling
// ---------------------------------------------------------------------------

describe("createMcpComponentProvider failures", () => {
  test("attach returns empty components when all servers fail to connect", async () => {
    const conn = createMockConnection("bad", [], {}, { shouldFailConnect: true });
    const resolver = createMcpResolver([conn]);
    const provider = createMcpComponentProvider({ resolver });
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    if (isAttachResult(result)) {
      expect(result.components.size).toBe(0);
      // Should have skipped entries for the failed server
      expect(result.skipped.length).toBeGreaterThan(0);
    }

    resolver.dispose();
  });

  test("mixed success/failure: working server tools attached, failed server skipped", async () => {
    const good = createMockConnection(
      "good",
      [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      { t: { ok: true, value: "ok" } },
    );
    const bad = createMockConnection("bad", [], {}, { shouldFailConnect: true });
    const resolver = createMcpResolver([good, bad]);
    const provider = createMcpComponentProvider({ resolver });
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    if (isAttachResult(result)) {
      expect(result.components.size).toBe(1);
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(result.skipped.some((s) => s.name.includes("bad"))).toBe(true);
    }

    resolver.dispose();
  });

  test("attach with no connections returns empty components and no skipped", async () => {
    const resolver = createMcpResolver([]);
    const provider = createMcpComponentProvider({ resolver });
    const agent = createMockAgent();

    const result = await provider.attach(agent);
    if (isAttachResult(result)) {
      expect(result.components.size).toBe(0);
      expect(result.skipped).toHaveLength(0);
    }

    resolver.dispose();
  });
});
