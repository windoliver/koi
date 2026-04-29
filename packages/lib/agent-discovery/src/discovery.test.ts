import { describe, expect, test } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { createDiscovery } from "./discovery.js";
import type { DiscoverySource } from "./types.js";

function counterSource(
  id: DiscoverySource["id"],
  priority: number,
  factory: (n: number) => readonly ExternalAgentDescriptor[],
): DiscoverySource & { calls: () => number } {
  let n = 0;
  return {
    id,
    priority,
    discover: async () => {
      n++;
      return factory(n);
    },
    calls: () => n,
  };
}

const cliClaude: ExternalAgentDescriptor = {
  name: "claude-code",
  transport: "cli",
  capabilities: ["code-review"],
  source: "path",
};
const mcpClaude: ExternalAgentDescriptor = {
  name: "claude-code",
  transport: "mcp",
  capabilities: ["code-review"],
  source: "mcp",
};

describe("createDiscovery", () => {
  test("Promise.allSettled — one rejected source does not block others", async () => {
    const good = counterSource("path", 2, () => [cliClaude]);
    const bad: DiscoverySource = {
      id: "mcp",
      priority: 0,
      discover: async () => {
        throw new Error("fail");
      },
    };
    const d = createDiscovery([good, bad], 1000);
    const r = await d.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.name).toBe("claude-code");
  });

  test("cache returns same value within TTL", async () => {
    const s = counterSource("path", 2, () => [cliClaude]);
    const d = createDiscovery([s], 10_000);
    await d.discover();
    await d.discover();
    expect(s.calls()).toBe(1);
  });

  test("invalidate clears cache", async () => {
    const s = counterSource("path", 2, () => [cliClaude]);
    const d = createDiscovery([s], 10_000);
    await d.discover();
    d.invalidate();
    await d.discover();
    expect(s.calls()).toBe(2);
  });

  test("inflight dedup — concurrent calls share one fetch", async () => {
    const s = counterSource("path", 2, () => [cliClaude]);
    const d = createDiscovery([s], 10_000);
    await Promise.all([d.discover(), d.discover(), d.discover()]);
    expect(s.calls()).toBe(1);
  });

  test("dedup-by-name: MCP wins over PATH for shared name", async () => {
    const path = counterSource("path", 2, () => [cliClaude]);
    const mcp = counterSource("mcp", 0, () => [mcpClaude]);
    const d = createDiscovery([path, mcp], 1000);
    const r = await d.discover();
    expect(r.length).toBe(1);
    expect(r[0]?.transport).toBe("mcp");
  });

  test("filter by transport", async () => {
    const s1 = counterSource("path", 2, () => [cliClaude]);
    const s2 = counterSource("mcp", 0, () => [{ ...mcpClaude, name: "different" }]);
    const d = createDiscovery([s1, s2], 1000);
    const r = await d.discover({ filter: { transport: "cli" } });
    expect(r.map((d) => d.name)).toEqual(["claude-code"]);
  });

  test("filter by source", async () => {
    const s1 = counterSource("path", 2, () => [cliClaude]);
    const s2 = counterSource("mcp", 0, () => [{ ...mcpClaude, name: "different" }]);
    const d = createDiscovery([s1, s2], 1000);
    const r = await d.discover({ filter: { source: "mcp" } });
    expect(r.map((d) => d.name)).toEqual(["different"]);
  });

  test("filter by capability", async () => {
    const writer: ExternalAgentDescriptor = {
      name: "writer",
      transport: "cli",
      capabilities: ["writing"],
      source: "path",
    };
    const s = counterSource("path", 2, () => [cliClaude, writer]);
    const d = createDiscovery([s], 1000);
    const r = await d.discover({ filter: { capability: "code-review" } });
    expect(r.map((d) => d.name)).toEqual(["claude-code"]);
  });
});
