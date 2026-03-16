/**
 * Tests for the tool disclosure bundle — middleware + promote_tools companion tool.
 */

import { describe, expect, test } from "bun:test";
import type { BrickSummary, ForgeStore, KoiError, Result, Tool, TurnContext } from "@koi/core";
import { agentId, isAttachResult, runId, sessionId, turnId } from "@koi/core";
import { createToolDisclosureBundle } from "./disclosure-bundle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(): ForgeStore {
  return {
    save: async () => ({ ok: true, value: undefined }),
    load: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }),
    search: async () => ({ ok: true as const, value: [] }),
    searchSummaries: async (): Promise<Result<readonly BrickSummary[], KoiError>> => ({
      ok: true,
      value: [],
    }),
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    exists: async () => ({ ok: true, value: false }),
  };
}

const MOCK_AGENT = {
  pid: {
    id: agentId("agent-1"),
    name: "test",
    type: "worker" as const,
    depth: 0,
  },
  manifest: {
    name: "test",
    version: "0.0.1",
    description: "test",
    model: { name: "m" },
  },
  state: "running" as const,
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolDisclosureBundle", () => {
  test("returns middleware and providers", () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    expect(bundle.middleware).toBeDefined();
    expect(bundle.middleware.name).toBe("tool-disclosure");
    expect(bundle.providers).toHaveLength(1);
  });

  test("provider attaches promote_tools as a tool component", async () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    const provider = bundle.providers[0];
    expect(provider).toBeDefined();
    if (provider === undefined) throw new Error("provider undefined");

    const result = await provider.attach(MOCK_AGENT);
    const components = isAttachResult(result) ? result.components : result;

    expect(components.has("tool:promote_tools")).toBe(true);
    const tool = components.get("tool:promote_tools") as Tool;
    expect(tool.descriptor.name).toBe("promote_tools");
    expect(tool.origin).toBe("primordial");
  });

  test("promote_tools tool executes and returns result", async () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    const provider = bundle.providers[0];
    if (provider === undefined) throw new Error("provider undefined");

    const result = await provider.attach(MOCK_AGENT);
    const components = isAttachResult(result) ? result.components : result;
    const tool = components.get("tool:promote_tools") as Tool;

    // Call with empty names — should return empty promoted list
    const output = (await tool.execute({ names: ["nonexistent"] })) as {
      ok: boolean;
      promoted: readonly string[];
    };
    expect(output.ok).toBe(true);
    expect(output.promoted).toEqual([]);
  });

  test("promote_tools validates input — missing names", async () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    const provider = bundle.providers[0];
    if (provider === undefined) throw new Error("provider undefined");

    const result = await provider.attach(MOCK_AGENT);
    const components = isAttachResult(result) ? result.components : result;
    const tool = components.get("tool:promote_tools") as Tool;

    const output = (await tool.execute({})) as { ok: boolean; error: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("VALIDATION");
  });

  test("promote_tools validates input — empty names array", async () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    const provider = bundle.providers[0];
    if (provider === undefined) throw new Error("provider undefined");

    const result = await provider.attach(MOCK_AGENT);
    const components = isAttachResult(result) ? result.components : result;
    const tool = components.get("tool:promote_tools") as Tool;

    const output = (await tool.execute({ names: [] })) as {
      ok: boolean;
      error: { code: string };
    };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("VALIDATION");
  });

  test("bundle wires notifyCompanionRegistered — describeCapabilities returns fragment", () => {
    const bundle = createToolDisclosureBundle({ store: createMockStore() });
    const ctx: TurnContext = {
      session: {
        agentId: "test-agent",
        sessionId: sessionId("s-1"),
        runId: runId("r-1"),
        metadata: {},
      },
      turnIndex: 0,
      turnId: turnId(runId("r-1"), 0),
      messages: [],
      metadata: {},
    };

    // Bundle calls notifyCompanionRegistered() during construction,
    // so describeCapabilities should return a fragment immediately —
    // before any wrapModelCall (matching real engine lifecycle).
    const fragment = bundle.middleware.describeCapabilities(ctx);
    expect(fragment).toBeDefined();
    expect(fragment?.label).toBe("tool-disclosure");
    expect(fragment?.description).toContain("promote_tools");
  });
});
