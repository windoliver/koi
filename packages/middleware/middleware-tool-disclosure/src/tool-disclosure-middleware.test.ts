/**
 * Tests for tool disclosure middleware — progressive disclosure for forged tools.
 *
 * Covers: threshold bypass (Issue 9A), promotion flow (Issue 10A),
 * error paths (Issue 11A), token estimation (Issue 12A).
 */

import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  BrickSummary,
  ForgeStore,
  KoiError,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  Result,
  ToolDescriptor,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { ToolDisclosureMiddleware } from "./tool-disclosure-middleware.js";
import {
  createToolDisclosureMiddleware,
  DEFAULT_DISCLOSURE_THRESHOLD,
} from "./tool-disclosure-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callWrapModelCall(
  mw: ToolDisclosureMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall not defined");
  return mw.wrapModelCall(ctx, request, next);
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

function descriptor(name: string, schemaProperties?: Record<string, unknown>): ToolDescriptor {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema:
      schemaProperties !== undefined
        ? { type: "object", properties: schemaProperties }
        : { type: "object", properties: { input: { type: "string" } } },
  };
}

function descriptors(count: number, prefix = "tool"): readonly ToolDescriptor[] {
  return Array.from({ length: count }, (_, i) => descriptor(`${prefix}-${i}`));
}

/** Checks whether a descriptor is summary-level (empty inputSchema). */
function isSummaryLevel(d: ToolDescriptor): boolean {
  const schema = d.inputSchema;
  return Object.keys(schema).length === 0;
}

/** Checks whether a descriptor has full schema (non-empty inputSchema). */
function isFullLevel(d: ToolDescriptor): boolean {
  return !isSummaryLevel(d);
}

function createMockStore(bricks: readonly BrickArtifact[] = []): ForgeStore {
  const map = new Map<string, BrickArtifact>();
  for (const b of bricks) {
    map.set(b.id, b);
  }

  return {
    save: async () => ({ ok: true, value: undefined }),
    load: async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const brick = map.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${id}`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    },
    search: async () => ({ ok: true, value: [...map.values()] }),
    searchSummaries: async (): Promise<Result<readonly BrickSummary[], KoiError>> => {
      const summaries = [...map.values()].map((b) => ({
        id: b.id,
        kind: b.kind,
        name: b.name,
        description: b.description,
        tags: b.tags,
      }));
      return { ok: true, value: summaries };
    },
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    exists: async () => ({ ok: true, value: false }),
  };
}

function createMockErrorStore(): ForgeStore {
  const failResult: Result<never, KoiError> = {
    ok: false,
    error: { code: "INTERNAL", message: "Store unavailable", retryable: true },
  };
  return {
    save: async () => failResult as Result<void, KoiError>,
    load: async () => failResult,
    search: async () => failResult,
    searchSummaries: async () => failResult,
    remove: async () => failResult as Result<void, KoiError>,
    update: async () => failResult as Result<void, KoiError>,
    exists: async () => failResult as Result<boolean, KoiError>,
  };
}

function mockTurnContext(): TurnContext {
  return {
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
}

/** Capture the tools from the request that reaches the next handler. */
function captureTools(): {
  readonly handler: (request: ModelRequest) => Promise<ModelResponse>;
  readonly captured: () => readonly ToolDescriptor[] | undefined;
} {
  // let justified: mutable capture slot
  let tools: readonly ToolDescriptor[] | undefined;
  return {
    handler: async (request: ModelRequest) => {
      tools = request.tools;
      return { content: "ok", model: "test" };
    },
    captured: () => tools,
  };
}

// ---------------------------------------------------------------------------
// Issue 9A: Threshold bypass — parameterized matrix
// ---------------------------------------------------------------------------

describe("threshold bypass", () => {
  test("1 tool — all tools pass through as full descriptors", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 50 });
    const tools = descriptors(1);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(1);
    expect(result.every(isFullLevel)).toBe(true);
  });

  test("49 tools — all tools pass through as full descriptors", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 50 });
    const tools = descriptors(49);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(49);
    expect(result.every(isFullLevel)).toBe(true);
  });

  test("50 tools — exactly at threshold, passes through as full descriptors", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 50 });
    const tools = descriptors(50);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(50);
    expect(result.every(isFullLevel)).toBe(true);
  });

  test("51 tools — above threshold, tools demoted to summary level", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 50 });
    const tools = descriptors(51);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(51);
    // All should be summary level (empty inputSchema) since none promoted
    expect(result.every(isSummaryLevel)).toBe(true);
    // Names and descriptions preserved
    const first = requireDefined(result[0], "result[0]");
    expect(first.name).toBe("tool-0");
    expect(first.description).toBe("Tool: tool-0");
  });

  test("200 tools — all demoted to summary level", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 50 });
    const tools = descriptors(200);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(200);
    expect(result.every(isSummaryLevel)).toBe(true);
  });

  test("custom threshold — respects config override", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 100 });
    const tools = descriptors(75);
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    // 75 < 100 threshold → full descriptors
    expect(result.every(isFullLevel)).toBe(true);
  });

  test("default threshold is 50", () => {
    expect(DEFAULT_DISCLOSURE_THRESHOLD).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Issue 10A: Promotion flow — summary → descriptor
// ---------------------------------------------------------------------------

describe("promotion flow", () => {
  test("promote specific tools — they get full descriptors, others stay summary", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(10);

    // First call populates the internal descriptor index
    const warmup = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, warmup.handler);

    // Promote tool-3 and tool-7
    await mw.promoteByName(["tool-3", "tool-7"]);

    const capture = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture.handler);

    const result = requireDefined(capture.captured(), "tools");
    expect(result.length).toBe(10);

    const tool3 = requireDefined(
      result.find((t) => t.name === "tool-3"),
      "tool-3",
    );
    const tool7 = requireDefined(
      result.find((t) => t.name === "tool-7"),
      "tool-7",
    );
    const tool0 = requireDefined(
      result.find((t) => t.name === "tool-0"),
      "tool-0",
    );

    // Promoted tools have full schema from the tool list
    expect(isFullLevel(tool3)).toBe(true);
    expect(isFullLevel(tool7)).toBe(true);

    // Non-promoted tools are summary level
    expect(isSummaryLevel(tool0)).toBe(true);
  });

  test("promote nonexistent tool — gracefully skipped", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });

    const promoted = await mw.promoteByName(["nonexistent-tool"]);
    expect(promoted.length).toBe(0);
  });

  test("promote same tool twice — idempotent", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(10);

    // First call populates the descriptor index
    const capture1 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture1.handler);

    await mw.promoteByName(["tool-5"]);
    await mw.promoteByName(["tool-5"]);

    const capture2 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture2.handler);

    const result = requireDefined(capture2.captured(), "tools");
    const tool5 = requireDefined(
      result.find((t) => t.name === "tool-5"),
      "tool-5",
    );
    expect(isFullLevel(tool5)).toBe(true);
  });

  test("promote all tools — degenerates to current behavior", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(10);

    // First call to populate index
    const capture1 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture1.handler);

    const allNames = tools.map((t) => t.name);
    await mw.promoteByName(allNames);

    const capture2 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture2.handler);

    const result = requireDefined(capture2.captured(), "tools");
    expect(result.every(isFullLevel)).toBe(true);
  });

  test("clearCache resets all promotions", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(10);

    // Populate index
    const capture1 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture1.handler);

    await mw.promoteByName(["tool-3"]);
    mw.clearCache();

    const capture2 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture2.handler);

    const result = requireDefined(capture2.captured(), "tools");
    // All should be back to summary after cache clear
    expect(result.every(isSummaryLevel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue 11A: Error paths — store failures
// ---------------------------------------------------------------------------

describe("error paths", () => {
  test("store.load failure during promotion — gracefully skipped", async () => {
    const errorStore = createMockErrorStore();
    const mw = createToolDisclosureMiddleware({ store: errorStore, threshold: 5 });

    // Promotion should not throw, just return empty
    const promoted = await mw.promoteByName(["some-tool"]);
    expect(promoted.length).toBe(0);
  });

  test("middleware with undefined tools — passes through unchanged", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const capture = captureTools();

    await callWrapModelCall(mw, mockTurnContext(), { messages: [] }, capture.handler);

    // No tools in request — passes through
    expect(capture.captured()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 12A: Token estimation with realistic descriptors
// ---------------------------------------------------------------------------

describe("token estimation", () => {
  test("summary-level descriptors are significantly smaller than full descriptors", () => {
    const fullTools = Array.from({ length: 10 }, (_, i) =>
      descriptor(`complex-tool-${i}`, {
        query: { type: "string", description: "SQL query to execute against the database" },
        parameters: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, value: {} } },
          description: "Parameterized query values for safe interpolation",
        },
        timeout: { type: "number", description: "Query timeout in milliseconds" },
        database: { type: "string", description: "Target database name" },
      }),
    );

    const fullJson = JSON.stringify(fullTools);
    const summaryTools = fullTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {},
    }));
    const summaryJson = JSON.stringify(summaryTools);

    // Summary should be at least 60% smaller than full
    const ratio = summaryJson.length / fullJson.length;
    expect(ratio).toBeLessThan(0.4);
  });

  test("disclosure decision is stable — same input produces same output ref", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(20);

    const capture1 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture1.handler);

    const capture2 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture2.handler);

    // Same tools ref + same promoted set → memoized same output ref
    expect(capture1.captured()).toBe(capture2.captured());
  });

  test("disclosure decision changes when promotions change", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const tools = descriptors(20);

    const capture1 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture1.handler);

    // Promote a tool — output should change
    await mw.promoteByName(["tool-5"]);

    const capture2 = captureTools();
    await callWrapModelCall(mw, mockTurnContext(), { messages: [], tools }, capture2.handler);

    expect(capture1.captured()).not.toBe(capture2.captured());

    // tool-5 should now be full level
    const captured2 = requireDefined(capture2.captured(), "tools");
    const tool5 = requireDefined(
      captured2.find((t) => t.name === "tool-5"),
      "tool-5",
    );
    expect(isFullLevel(tool5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memoization and ref-stability
// ---------------------------------------------------------------------------

describe("memoization", () => {
  test("different tools array ref invalidates memo", async () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });

    const tools1 = descriptors(10);
    const tools2 = descriptors(10); // Same content, different ref

    const capture1 = captureTools();
    await callWrapModelCall(
      mw,
      mockTurnContext(),
      { messages: [], tools: tools1 },
      capture1.handler,
    );

    const capture2 = captureTools();
    await callWrapModelCall(
      mw,
      mockTurnContext(),
      { messages: [], tools: tools2 },
      capture2.handler,
    );

    // Different input ref → different output ref (even if content is same)
    expect(capture1.captured()).not.toBe(capture2.captured());
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  test("returns capability fragment with promoted count", () => {
    const store = createMockStore();
    const mw = createToolDisclosureMiddleware({ store, threshold: 5 });
    const ctx = mockTurnContext();

    const fragment = requireDefined(mw.describeCapabilities(ctx), "fragment");
    expect(fragment.label).toBe("tool-disclosure");
    expect(fragment.description).toContain("0 tools promoted");
  });
});
