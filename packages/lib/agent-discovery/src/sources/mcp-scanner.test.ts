import { describe, expect, test } from "bun:test";
import type { McpAgentSource } from "../types.js";
import { createMcpSource } from "./mcp-scanner.js";

function ok(tools: readonly { readonly name: string; readonly description?: string }[]) {
  return { ok: true as const, value: tools };
}

describe("createMcpSource", () => {
  test("server with agent-keyword tool produces a descriptor", async () => {
    const m: McpAgentSource = {
      name: "srv-a",
      isAgent: true,
      listTools: async () => ok([{ name: "code_assistant", description: "AI" }]),
    };
    const r = await createMcpSource([m]).discover();
    expect(r.length).toBe(1);
    expect(r[0]?.name).toBe("srv-a");
    expect(r[0]?.transport).toBe("mcp");
    expect(r[0]?.source).toBe("mcp");
  });

  test("server with no qualifying tools produces nothing", async () => {
    const m: McpAgentSource = {
      name: "srv-b",
      isAgent: true,
      listTools: async () => ok([{ name: "ping", description: "pong" }]),
    };
    expect((await createMcpSource([m]).discover()).length).toBe(0);
  });

  test("server returning ok:false is skipped", async () => {
    const m: McpAgentSource = {
      name: "srv-c",
      isAgent: true,
      listTools: async () => ({
        ok: false as const,
        error: { message: "bad" },
      }),
    };
    expect((await createMcpSource([m]).discover()).length).toBe(0);
  });

  test("multiple servers — only qualifying ones returned", async () => {
    const m1: McpAgentSource = {
      name: "srv-1",
      isAgent: true,
      listTools: async () => ok([{ name: "review_code" }]),
    };
    const m2: McpAgentSource = {
      name: "srv-2",
      isAgent: true,
      listTools: async () => ok([{ name: "ping" }]),
    };
    const r = await createMcpSource([m1, m2]).discover();
    expect(r.map((d) => d.name).sort()).toEqual(["srv-1"]);
  });

  test("server without isAgent:true is ignored even if tools match keywords", async () => {
    const m: McpAgentSource = {
      name: "non-agent",
      isAgent: false,
      listTools: async () => ok([{ name: "code_search", description: "find code" }]),
    };
    expect((await createMcpSource([m]).discover()).length).toBe(0);
  });

  test("source id is 'mcp' and priority is 0", () => {
    const s = createMcpSource([]);
    expect(s.id).toBe("mcp");
    expect(s.priority).toBe(0);
  });
});
