import { describe, expect, test } from "bun:test";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionId,
  ToolDescriptor,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { createMockTurnContext } from "@koi/test";
import {
  createPromoteToolDescriptor,
  createToolDisclosureMiddleware,
  DEFAULT_DISCLOSURE_THRESHOLD,
  PROMOTE_TOOL_NAME,
  type ToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";

const ctx: TurnContext = createMockTurnContext();

function descriptor(name: string): ToolDescriptor {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: { type: "object", properties: { input: { type: "string" } } },
  };
}

function descriptors(count: number, prefix = "tool"): readonly ToolDescriptor[] {
  return Array.from({ length: count }, (_, i) => descriptor(`${prefix}-${i}`));
}

function isSummary(d: ToolDescriptor): boolean {
  return Object.keys(d.inputSchema).length === 0;
}

const noopResponse: ModelResponse = {
  content: "ok",
  model: "test",
};

function captureNext(): {
  readonly handler: ModelHandler;
  readonly seen: { request: ModelRequest | undefined };
} {
  const seen: { request: ModelRequest | undefined } = { request: undefined };
  const handler: ModelHandler = async (request) => {
    seen.request = request;
    return noopResponse;
  };
  return { handler, seen };
}

async function callWrap(
  mw: ToolDisclosureMiddleware,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall missing");
  return mw.wrapModelCall(ctx, request, next);
}

describe("createToolDisclosureMiddleware", () => {
  test("has correct name, priority, phase", () => {
    const mw = createToolDisclosureMiddleware();
    expect(mw.name).toBe("tool-disclosure");
    expect(mw.priority).toBe(50);
    expect(mw.phase).toBe("intercept");
  });

  test("default threshold is 50", () => {
    expect(DEFAULT_DISCLOSURE_THRESHOLD).toBe(50);
  });

  describe("threshold bypass", () => {
    test("below threshold: tools pass through unchanged (zero overhead)", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 10 });
      const tools = descriptors(5);
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      expect(next.seen.request?.tools).toBe(tools); // same reference
    });

    test("at threshold: tools pass through unchanged", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 10 });
      const tools = descriptors(10);
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      expect(next.seen.request?.tools).toBe(tools);
    });

    test("undefined tools: pass through unchanged", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 10 });
      const next = captureNext();

      await callWrap(mw, { messages: [] }, next.handler);

      expect(next.seen.request?.tools).toBeUndefined();
    });
  });

  describe("disclosure above threshold", () => {
    test("all non-promoted tools become summaries", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      const out = next.seen.request?.tools ?? [];
      expect(out).toHaveLength(10);
      for (const t of out) expect(isSummary(t)).toBe(true);
    });

    test("name and description are preserved on summaries", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      const out = next.seen.request?.tools ?? [];
      expect(out[0]?.name).toBe("tool-0");
      expect(out[0]?.description).toBe("Tool: tool-0");
    });

    test("tags are preserved when present", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tagged: ToolDescriptor = { ...descriptor("tagged"), tags: ["a", "b"] };
      const tools: readonly ToolDescriptor[] = [...descriptors(9), tagged];
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      const out = next.seen.request?.tools ?? [];
      const found = out.find((t) => t.name === "tagged");
      expect(found?.tags).toEqual(["a", "b"]);
    });

    test("promote_tools is always full descriptor even when no tools promoted", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools: readonly ToolDescriptor[] = [...descriptors(9), createPromoteToolDescriptor()];
      const next = captureNext();

      await callWrap(mw, { messages: [], tools }, next.handler);

      const out = next.seen.request?.tools ?? [];
      const promote = out.find((t) => t.name === PROMOTE_TOOL_NAME);
      expect(promote).toBeDefined();
      if (promote) expect(isSummary(promote)).toBe(false);
    });
  });

  describe("promotion", () => {
    test("promoted tools keep full descriptor on next call", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const first = captureNext();
      await callWrap(mw, { messages: [], tools }, first.handler);

      const promotedNames = mw.promoteByNameForSession(ctx.session.sessionId, ["tool-3", "tool-7"]);
      expect(promotedNames).toEqual(["tool-3", "tool-7"]);

      const second = captureNext();
      await callWrap(mw, { messages: [], tools }, second.handler);

      const out = second.seen.request?.tools ?? [];
      const t3 = out.find((t) => t.name === "tool-3");
      const t5 = out.find((t) => t.name === "tool-5");
      expect(t3 && isSummary(t3)).toBe(false);
      expect(t5 && isSummary(t5)).toBe(true);
    });

    test("unknown names are filtered out of the promotion result", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const next = captureNext();
      await callWrap(mw, { messages: [], tools }, next.handler);

      const promoted = mw.promoteByNameForSession(ctx.session.sessionId, [
        "tool-1",
        "does-not-exist",
      ]);
      expect(promoted).toEqual(["tool-1"]);
    });

    test("promotion before any model call yields empty result (no known names)", () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const promoted = mw.promoteByNameForSession(ctx.session.sessionId, ["tool-0"]);
      expect(promoted).toEqual([]);
    });

    test("clearCache resets the promoted set", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const first = captureNext();
      await callWrap(mw, { messages: [], tools }, first.handler);
      mw.promoteByNameForSession(ctx.session.sessionId, ["tool-2"]);

      mw.clearCache();

      const second = captureNext();
      await callWrap(mw, { messages: [], tools }, second.handler);
      const t2 = (second.seen.request?.tools ?? []).find((t) => t.name === "tool-2");
      expect(t2 && isSummary(t2)).toBe(true);
    });
  });

  describe("describeCapabilities", () => {
    test("standalone middleware returns undefined (no companion tool)", () => {
      const mw = createToolDisclosureMiddleware();
      const result = mw.describeCapabilities?.(ctx);
      expect(result).toBeUndefined();
    });

    test("after notifyCompanionRegistered: returns fragment", () => {
      const mw = createToolDisclosureMiddleware();
      mw.notifyCompanionRegistered();
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("tool-disclosure");
      expect(result?.description).toContain(PROMOTE_TOOL_NAME);
      expect(result?.description).toContain("0 tools promoted");
    });

    test("fragment reflects current promoted count", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      mw.notifyCompanionRegistered();
      const tools = descriptors(10);
      const next = captureNext();
      await callWrap(mw, { messages: [], tools }, next.handler);

      mw.promoteByNameForSession(ctx.session.sessionId, ["tool-1", "tool-2"]);
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.description).toContain("2 tools promoted");
    });
  });

  describe("per-session isolation", () => {
    test("promotion in session A does not affect session B", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sidA: SessionId = sessionId("session-A");
      const sidB: SessionId = sessionId("session-B");
      const ctxA = createMockTurnContext({ session: { sessionId: sidA } });
      const ctxB = createMockTurnContext({ session: { sessionId: sidB } });

      // Both sessions see the tools
      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, captureNext().handler);
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, captureNext().handler);

      // Promote in B explicitly
      mw.promoteByNameForSession(sidB, ["tool-1"]);

      // A should NOT see tool-1 promoted on its next call
      const seenA = captureNext();
      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, seenA.handler);
      const t1A = (seenA.seen.request?.tools ?? []).find((t) => t.name === "tool-1");
      expect(t1A && isSummary(t1A)).toBe(true);

      // B should see tool-1 promoted on its next call
      const seenB = captureNext();
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, seenB.handler);
      const t1B = (seenB.seen.request?.tools ?? []).find((t) => t.name === "tool-1");
      expect(t1B && isSummary(t1B)).toBe(false);
    });

    test("onSessionEnd evicts the session's promoted state", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sid: SessionId = sessionId("ephemeral");
      const ctxOne = createMockTurnContext({ session: { sessionId: sid } });

      await mw.onSessionStart?.(ctxOne.session);
      await mw.wrapModelCall?.(ctxOne, { messages: [], tools }, captureNext().handler);
      mw.promoteByNameForSession(sid, ["tool-3"]);

      await mw.onSessionEnd?.(ctxOne.session);

      // Re-disclose under same sessionId — promotion must NOT carry across the end
      const ctxTwo = createMockTurnContext({ session: { sessionId: sid } });
      const seen = captureNext();
      await mw.wrapModelCall?.(ctxTwo, { messages: [], tools }, seen.handler);
      const t3 = (seen.seen.request?.tools ?? []).find((t) => t.name === "tool-3");
      expect(t3 && isSummary(t3)).toBe(true);
    });

    test("promoteByNameForSession targets explicit sessions", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sidA: SessionId = sessionId("a");
      const sidB: SessionId = sessionId("b");
      const ctxA = createMockTurnContext({ session: { sessionId: sidA } });
      const ctxB = createMockTurnContext({ session: { sessionId: sidB } });

      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, captureNext().handler);
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, captureNext().handler);

      // Promote into A specifically — even though B was the most recent active session
      const promoted = mw.promoteByNameForSession(sidA, ["tool-2"]);
      expect(promoted).toEqual(["tool-2"]);

      const seenA = captureNext();
      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, seenA.handler);
      const t2A = (seenA.seen.request?.tools ?? []).find((t) => t.name === "tool-2");
      expect(t2A && isSummary(t2A)).toBe(false);

      const seenB = captureNext();
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, seenB.handler);
      const t2B = (seenB.seen.request?.tools ?? []).find((t) => t.name === "tool-2");
      expect(t2B && isSummary(t2B)).toBe(true);
    });

    test("wrapToolCall routes promote_tools by ctx.session.sessionId", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sidA: SessionId = sessionId("a");
      const sidB: SessionId = sessionId("b");
      const ctxA = createMockTurnContext({ session: { sessionId: sidA } });
      const ctxB = createMockTurnContext({ session: { sessionId: sidB } });

      // Both sessions disclose tools first
      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, captureNext().handler);
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, captureNext().handler);

      // promote_tools call from session A — must NOT promote into B
      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      const noopNext = async (): Promise<ToolResponse> => {
        throw new Error("next should not run for promote_tools");
      };
      await wrap(ctxA, { toolId: PROMOTE_TOOL_NAME, input: { names: ["tool-1"] } }, noopNext);

      // A sees tool-1 promoted
      const seenA = captureNext();
      await mw.wrapModelCall?.(ctxA, { messages: [], tools }, seenA.handler);
      const t1A = (seenA.seen.request?.tools ?? []).find((t) => t.name === "tool-1");
      expect(t1A && isSummary(t1A)).toBe(false);

      // B does NOT
      const seenB = captureNext();
      await mw.wrapModelCall?.(ctxB, { messages: [], tools }, seenB.handler);
      const t1B = (seenB.seen.request?.tools ?? []).find((t) => t.name === "tool-1");
      expect(t1B && isSummary(t1B)).toBe(true);
    });

    test("direct call to summary-level tool is rejected with VALIDATION", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sid: SessionId = sessionId("session-x");
      const ctxX = createMockTurnContext({ session: { sessionId: sid } });
      await mw.wrapModelCall?.(ctxX, { messages: [], tools }, captureNext().handler);

      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      let nextCalled = false;
      const noop = async (): Promise<ToolResponse> => {
        nextCalled = true;
        return { output: "should not reach" };
      };
      const response = await wrap(ctxX, { toolId: "tool-1", input: {} }, noop);

      expect(nextCalled).toBe(false);
      const out = response.output as { ok: boolean; error?: { code: string; message: string } };
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("VALIDATION");
      expect(out.error?.message).toContain(PROMOTE_TOOL_NAME);
      expect(response.metadata?.error).toBe(true);
    });

    test("after promotion, direct calls are allowed (next is invoked)", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const tools = descriptors(10);
      const sid: SessionId = sessionId("session-y");
      const ctxY = createMockTurnContext({ session: { sessionId: sid } });
      await mw.wrapModelCall?.(ctxY, { messages: [], tools }, captureNext().handler);
      mw.promoteByNameForSession(sid, ["tool-1"]);

      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      let nextCalled = false;
      const noop = async (): Promise<ToolResponse> => {
        nextCalled = true;
        return { output: "ok" };
      };
      await wrap(ctxY, { toolId: "tool-1", input: {} }, noop);
      expect(nextCalled).toBe(true);
    });

    test("unknown tool names pass through (not our concern)", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      let nextCalled = false;
      const noop = async (): Promise<ToolResponse> => {
        nextCalled = true;
        return { output: "ok" };
      };
      await wrap(ctx, { toolId: "never-disclosed", input: {} }, noop);
      expect(nextCalled).toBe(true);
    });

    test("stale disclosure state is cleared when tool count drops below threshold", async () => {
      // Session sees 10 tools (threshold 5 — disclosure active) → state.knownNames populated
      // Then sees 3 tools (below threshold) → must clear knownNames so the
      // validation guard does not block tools the model is now seeing at full schema.
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const sid: SessionId = sessionId("dynamic-tool-set");
      const ctxDyn = createMockTurnContext({ session: { sessionId: sid } });

      // First turn: 10 tools — disclosure active
      await mw.wrapModelCall?.(
        ctxDyn,
        { messages: [], tools: descriptors(10) },
        captureNext().handler,
      );

      // Second turn: 3 tools — below threshold, full schemas sent
      await mw.wrapModelCall?.(
        ctxDyn,
        { messages: [], tools: descriptors(3) },
        captureNext().handler,
      );

      // Direct call to tool-1 must succeed (model just saw it at full schema)
      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      let nextCalled = false;
      const noop = async (): Promise<ToolResponse> => {
        nextCalled = true;
        return { output: "ok" };
      };
      await wrap(ctxDyn, { toolId: "tool-1", input: {} }, noop);
      expect(nextCalled).toBe(true);
    });

    test("below threshold: validation guard does NOT fire (no disclosure happened)", async () => {
      const mw = createToolDisclosureMiddleware({ threshold: 50 });
      const tools = descriptors(10);
      await mw.wrapModelCall?.(ctx, { messages: [], tools }, captureNext().handler);

      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error("wrapToolCall missing");
      let nextCalled = false;
      const noop = async (): Promise<ToolResponse> => {
        nextCalled = true;
        return { output: "ok" };
      };
      await wrap(ctx, { toolId: "tool-1", input: {} }, noop);
      expect(nextCalled).toBe(true);
    });

    test("promoteByNameForSession returns empty for unknown session", () => {
      const mw = createToolDisclosureMiddleware({ threshold: 5 });
      const promoted = mw.promoteByNameForSession(sessionId("never-touched"), ["foo"]);
      expect(promoted).toEqual([]);
    });
  });

  describe("createPromoteToolDescriptor", () => {
    test("has correct name, schema shape", () => {
      const d = createPromoteToolDescriptor();
      expect(d.name).toBe(PROMOTE_TOOL_NAME);
      expect(d.description).toContain("full tool schemas");
      const props = d.inputSchema.properties as Record<string, unknown>;
      expect(props.names).toBeDefined();
      expect((d.inputSchema.required as string[]).includes("names")).toBe(true);
    });
  });
});
