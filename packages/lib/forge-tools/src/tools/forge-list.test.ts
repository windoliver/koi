import { beforeEach, describe, expect, test } from "bun:test";
import type { ForgeQuery, ForgeStore } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import type { ToolExecutionContext } from "@koi/execution-context";
import { runWithExecutionContext } from "@koi/execution-context";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeListTool } from "./forge-list.js";
import { createForgeToolTool } from "./forge-tool.js";

function makeContext(agentId: string): ToolExecutionContext {
  return {
    session: {
      agentId,
      sessionId: sessionId("s1"),
      runId: runId("r1"),
      metadata: {},
    },
    turnIndex: 0,
  };
}

let store: ForgeStore;
beforeEach(() => {
  store = createInMemoryForgeStore();
});

async function synthAs(agentId: string, name: string): Promise<void> {
  const tool = createForgeToolTool({ store });
  const r = await runWithExecutionContext(makeContext(agentId), () =>
    tool.execute({
      name,
      description: name,
      version: "0.0.1",
      scope: "agent",
      implementation: `return ${JSON.stringify(name)};`,
      inputSchema: { type: "object" },
    }),
  );
  if (!(r as { ok: boolean }).ok) {
    throw new Error(`synth failed for ${name}: ${JSON.stringify(r)}`);
  }
}

describe("forge_list", () => {
  test("empty store returns empty list", async () => {
    const tool = createForgeListTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () => tool.execute({}));
    const ok = r as { ok: true; value: { summaries: readonly unknown[] } };
    expect(ok.value.summaries).toEqual([]);
  });

  test("excludes peer-agent agent-scoped artifacts (server-side via createdBy)", async () => {
    await synthAs("agent-B", "peer-private");
    await synthAs("agent-A", "mine");
    const tool = createForgeListTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ kind: "tool" }),
    );
    const ok = r as { ok: true; value: { summaries: readonly { name: string }[] } };
    expect(ok.value.summaries.map((s) => s.name)).toEqual(["mine"]);
  });

  test("respects caller-supplied limit", async () => {
    for (let i = 0; i < 5; i++) await synthAs("agent-A", `t${i}`);
    const tool = createForgeListTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ limit: 2 }),
    );
    const ok = r as { ok: true; value: { summaries: readonly unknown[] } };
    expect(ok.value.summaries).toHaveLength(2);
  });

  test("rejects limit above hard cap with VALIDATION", async () => {
    const tool = createForgeListTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ limit: 999 }),
    );
    const err = r as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("VALIDATION");
  });

  test("explicit scope: zone filter returns empty", async () => {
    await synthAs("agent-A", "mine");
    const tool = createForgeListTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ scope: "zone" }),
    );
    const ok = r as { ok: true; value: { summaries: readonly unknown[] } };
    expect(ok.value.summaries).toEqual([]);
  });

  test("bounded queries — peer pollution does not force full-scan", async () => {
    for (let i = 0; i < 100; i++) await synthAs("agent-B", `peer-${i}`);
    for (let i = 0; i < 5; i++) await synthAs("agent-A", `mine-${i}`);
    const queries: ForgeQuery[] = [];
    const inner = store.searchSummaries;
    const proxiedStore: ForgeStore = {
      ...store,
      searchSummaries: async (q: ForgeQuery) => {
        queries.push(q);
        if (inner === undefined) return { ok: true, value: [] };
        return inner(q);
      },
    };
    const tool = createForgeListTool({ store: proxiedStore });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ limit: 5 }),
    );
    const ok = r as { ok: true; value: { summaries: readonly unknown[] } };
    expect(ok.value.summaries).toHaveLength(5);
    for (const q of queries) {
      expect(q.limit).toBe(5);
    }
    expect(queries.length).toBeLessThanOrEqual(2);
  });

  test("descriptor is a primordial ToolDescriptor with JSON Schema input", () => {
    const tool = createForgeListTool({ store });
    expect(tool.descriptor.name).toBe("forge_list");
    expect(tool.descriptor.origin).toBe("primordial");
    expect(typeof tool.descriptor.description).toBe("string");
    expect(tool.descriptor.inputSchema).toBeDefined();
  });

  test("throws NO_CONTEXT when invoked outside any execution context", async () => {
    const tool = createForgeListTool({ store });
    let caught: unknown;
    try {
      await tool.execute({});
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.message).toMatch(/NO_CONTEXT/);
  });
});
