import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, ToolDescriptor, TurnContext } from "@koi/core";
import { runId, sessionId, toolCallId, turnId } from "@koi/core";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createTagSelectTools } from "./select-strategy.js";
import { createToolSelectorMiddleware } from "./tool-selector.js";

function turnCtx(opts: { readonly turnIndex?: number } = {}): TurnContext {
  const rid = runId("run-1");
  const idx = opts.turnIndex ?? 0;
  return {
    session: { agentId: "a", sessionId: sessionId("s-1"), runId: rid, metadata: {} },
    turnIndex: idx,
    turnId: turnId(rid, idx),
    messages: [],
    metadata: {},
  };
}

function userMsg(text: string): InboundMessage {
  return { content: [{ kind: "text", text }], senderId: "user", timestamp: 0 };
}

function tool(name: string, description = "x", tags?: readonly string[]): ToolDescriptor {
  return tags === undefined
    ? { name, description, inputSchema: {} }
    : { name, description, inputSchema: {}, tags };
}

function modelResponse(): ModelResponse {
  return { content: "ok", model: "test" };
}

function getWrap(
  mw: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: ModelHandler) => Promise<ModelResponse> {
  const wrap = mw.wrapModelCall;
  if (!wrap) throw new Error("wrapModelCall missing");
  return wrap;
}

describe("createToolSelectorMiddleware — defaults & metadata", () => {
  test("emits intercept-phase middleware with priority 200", () => {
    const mw = createToolSelectorMiddleware({ selectTools: async () => [] });
    expect(mw.phase).toBe("intercept");
    expect(mw.priority).toBe(200);
    expect(mw.name).toBe("koi:tool-selector");
  });

  test("describeCapabilities returns a tool-selector fragment", () => {
    const mw = createToolSelectorMiddleware({
      selectTools: async () => [],
      alwaysInclude: ["bash"],
    });
    const cap = mw.describeCapabilities(turnCtx());
    expect(cap?.label).toBe("tool-selector");
    expect(cap?.description).toContain("always: bash");
  });

  test("throws KoiRuntimeError when config is invalid", () => {
    expect(() => createToolSelectorMiddleware({ selectTools: "nope" } as never)).toThrow(
      KoiRuntimeError,
    );
  });
});

describe("createToolSelectorMiddleware — pass-through paths", () => {
  test("passes request through when tools is undefined", async () => {
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({ selectTools: select });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBeUndefined();
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("hi")] }, next);
    expect(select).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("multiple model calls in a turn track per-invocation snapshots; later calls do not authorize earlier tool calls — round 20 F1", async () => {
    // Two model calls in the same turn produce different allowlists.
    // wrapModelStream binds each tool_call_start callId to its own
    // snapshot so wrapToolCall validates against the EXACT tool set
    // the model saw when it generated that call.
    const tools1 = [tool("alpha"), tool("beta"), tool("gamma")];
    const tools2 = [tool("alpha"), tool("beta"), tool("gamma")];
    let nthCall = 0;
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        nthCall += 1;
        // First call: only alpha. Second call: only gamma.
        return nthCall === 1 ? ["alpha"] : ["gamma"];
      },
      minTools: 0,
    });
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const ctx = turnCtx();

    const callId1 = toolCallId("call-1");
    const callId2 = toolCallId("call-2");
    // First model call advertises [alpha, beta, gamma], filters to [alpha].
    const stream1: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "alpha", callId: callId1 };
      yield { kind: "tool_call_end", callId: callId1 };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(
      ctx,
      { messages: [userMsg("first")], tools: tools1 },
      stream1,
    )) {
      // drain
    }

    // Second model call advertises same tools, filters to [gamma].
    const stream2: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "gamma", callId: callId2 };
      yield { kind: "tool_call_end", callId: callId2 };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(
      ctx,
      { messages: [userMsg("second")], tools: tools2 },
      stream2,
    )) {
      // drain
    }

    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );

    // call-1 was bound to snapshot {alpha}. alpha must succeed; gamma must
    // be rejected even though gamma was authorized in the LATER call.
    await expect(
      wrapTool(ctx, { toolId: "alpha", input: {}, callId: callId1 }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    await expect(
      wrapTool(ctx, { toolId: "gamma", input: {}, callId: callId1 }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);

    // call-2 was bound to snapshot {gamma}. gamma must succeed; alpha must
    // be rejected even though alpha was authorized in the EARLIER call.
    await expect(
      wrapTool(ctx, { toolId: "gamma", input: {}, callId: callId2 }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    await expect(
      wrapTool(ctx, { toolId: "alpha", input: {}, callId: callId2 }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("overlapping wrapModelStream invocations bind callIds to their own snapshots — round 21 F1", async () => {
    // Two streams interleave. Without round-21 (snapshot returned
    // synchronously from filterRequest), invocation A's
    // tool_call_start would bind to invocation B's allowlist via the
    // shared lastSnapshotByTurn map after the await boundary.
    let nthCall = 0;
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        nthCall += 1;
        return nthCall === 1 ? ["alpha"] : ["gamma"];
      },
      minTools: 0,
    });
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const ctx = turnCtx();
    const tools = [tool("alpha"), tool("beta"), tool("gamma")];
    const callA = toolCallId("conc-A");
    const callB = toolCallId("conc-B");

    // Hold-open generators — both start before either completes.
    let releaseA = (): void => {};
    let releaseB = (): void => {};
    const streamA: ModelStreamHandler = async function* () {
      await new Promise<void>((r) => {
        releaseA = r;
      });
      yield { kind: "tool_call_start", toolName: "alpha", callId: callA };
      yield { kind: "tool_call_end", callId: callA };
      yield { kind: "done", response: modelResponse() };
    };
    const streamB: ModelStreamHandler = async function* () {
      await new Promise<void>((r) => {
        releaseB = r;
      });
      yield { kind: "tool_call_start", toolName: "gamma", callId: callB };
      yield { kind: "tool_call_end", callId: callB };
      yield { kind: "done", response: modelResponse() };
    };

    const drainA = (async (): Promise<void> => {
      for await (const _ of wrapStream(ctx, { messages: [userMsg("a")], tools }, streamA));
    })();
    const drainB = (async (): Promise<void> => {
      for await (const _ of wrapStream(ctx, { messages: [userMsg("b")], tools }, streamB));
    })();
    // Let both filterRequest calls resolve and snapshots be captured.
    await new Promise<void>((r) => setTimeout(r, 5));
    // Release B FIRST so its snapshot is the most-recent. If A's
    // snapshot leaked through a shared map, A's tool_call_start
    // would bind to {gamma} and accept gamma below.
    releaseB();
    await new Promise<void>((r) => setTimeout(r, 5));
    releaseA();
    await Promise.all([drainA, drainB]);

    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );

    // call-A bound to A's snapshot {alpha}; call-B bound to B's snapshot {gamma}.
    await expect(
      wrapTool(ctx, { toolId: "alpha", input: {}, callId: callA }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    await expect(
      wrapTool(ctx, { toolId: "gamma", input: {}, callId: callA }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    await expect(
      wrapTool(ctx, { toolId: "gamma", input: {}, callId: callB }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
  });

  test("recycled callIds across overlapping turns do not collide — round 22 F1", async () => {
    // Providers commonly emit short recycled IDs ("call_0", "tc1").
    // Without per-turn scoping, invocation B (turn-2) overwrote
    // invocation A's (turn-1) binding for the same callId, so A's
    // tool execution validated against B's snapshot.
    let nthCall = 0;
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        nthCall += 1;
        return nthCall === 1 ? ["alpha"] : ["gamma"];
      },
      minTools: 0,
    });
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");

    const ctx1 = turnCtx({ turnIndex: 0 });
    const ctx2 = turnCtx({ turnIndex: 1 });
    const tools = [tool("alpha"), tool("beta"), tool("gamma")];
    const recycled = toolCallId("call_0"); // same id, different turns

    const stream1: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "alpha", callId: recycled };
      yield { kind: "tool_call_end", callId: recycled };
      yield { kind: "done", response: modelResponse() };
    };
    const stream2: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "gamma", callId: recycled };
      yield { kind: "tool_call_end", callId: recycled };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx1, { messages: [userMsg("a")], tools }, stream1));
    for await (const _ of wrapStream(ctx2, { messages: [userMsg("b")], tools }, stream2));

    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    // ctx1 + recycled → snapshot {alpha}. gamma must reject even
    // though the second turn authorized gamma under the same callId.
    await expect(
      wrapTool(ctx1, { toolId: "alpha", input: {}, callId: recycled }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    await expect(
      wrapTool(ctx1, { toolId: "gamma", input: {}, callId: recycled }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    // ctx2 + recycled → snapshot {gamma}. alpha must reject.
    await expect(
      wrapTool(ctx2, { toolId: "gamma", input: {}, callId: recycled }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    await expect(
      wrapTool(ctx2, { toolId: "alpha", input: {}, callId: recycled }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("rejects tool calls with callId not bound to any snapshot — round 21 F2 / round 29 F2", async () => {
    // A tool_call carrying a callId that wasn't emitted by tool_call_start
    // on the wrapped model stream did not come from a model invocation we
    // observed. Treat as forged.
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["safe"],
      minTools: 0,
    });
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const ctx = turnCtx();
    const tools = [tool("safe"), tool("dangerous")];
    const boundCallId = toolCallId("c1");
    const stream: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "safe", callId: boundCallId };
      yield { kind: "tool_call_end", callId: boundCallId };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("go")], tools }, stream)) {
      // drain
    }

    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    // Unbound callId: not from tool_call_start on this turn's stream.
    await expect(
      wrapTool(ctx, { toolId: "safe", input: {}, callId: toolCallId("forged") }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("passes through trusted adapter tool calls without callId — round 29 F2", async () => {
    // Adapters / internal orchestration that invoke callHandlers.toolCall
    // directly (no model callId) are inside the trust boundary; the
    // selector enforces against MODEL-originated tool execution only.
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["safe"],
      minTools: 0,
    });
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const ctx = turnCtx();
    const tools = [tool("safe"), tool("dangerous")];
    const stream: ModelStreamHandler = async function* () {
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("go")], tools }, stream)) {
      // drain
    }

    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    // No callId → trusted adapter / internal invocation. Must pass through
    // even when filtered snapshots exist for this turn.
    await expect(
      wrapTool(ctx, { toolId: "anything", input: {} }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
    expect(toolNext).toHaveBeenCalled();
  });

  test("custom isUserSender predicate routes filtering for non-default sender IDs — round 19 F1", async () => {
    // Deployments using non-default user sender IDs (e.g. test harnesses
    // or custom channels) need a way to keep tool filtering enabled
    // without rewriting the whole extractQuery.
    const select = mock(async () => ["alpha"]);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 0,
      isUserSender: (id) => id === "test-user",
    });
    const tools = [tool("alpha"), tool("beta")];
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["alpha"]);
      return modelResponse();
    });
    // Message has non-default sender — default predicate would drop it.
    await getWrap(mw)(
      turnCtx(),
      {
        messages: [
          { senderId: "test-user", content: [{ kind: "text", text: "do it" }], timestamp: 0 },
        ],
        tools,
      },
      next,
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("deny-all turn (tools undefined) installs empty allowlist enforced against bound model callIds — round 16 F1 / round 29 F2", async () => {
    // Callers can disable tools for a turn by omitting `tools`. Any
    // model-originated tool_call_start in that turn is bound to an
    // empty allowlist and rejected at execution. (Trusted adapter
    // calls without a callId pass through — they are outside the
    // selector's scope per #review-round29-F2.)
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({ selectTools: select });
    const ctx = turnCtx();
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const callId = toolCallId("c-denied");
    const stream: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "anything", callId };
      yield { kind: "tool_call_end", callId };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("hi")] }, stream)) {
      // drain — installs empty snapshot bound to callId
    }

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "anything", input: {}, callId }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(toolNext).not.toHaveBeenCalled();
  });

  test("minTools fast-path skips selection only in advisory mode (enforceFiltering=false) — round 23 F1", async () => {
    // In advisory mode the fast-path is purely an optimization.
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 5,
      enforceFiltering: false,
    });
    const tools = [tool("a"), tool("b"), tool("c"), tool("d"), tool("e")];
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("hi")], tools }, next);
    expect(select).not.toHaveBeenCalled();
  });

  test("under enforceFiltering, minTools fast-path does NOT skip selection — round 23 F1", async () => {
    // Round 23 (high): minTools=5 default skipped selection for
    // small toolsets and authorized every advertised tool, defeating
    // enforceFiltering on exactly the agents with a few high-impact
    // tools. Selection now runs regardless of tool count when
    // enforceFiltering is on.
    const select = mock(async () => ["a"]);
    const mw = createToolSelectorMiddleware({ selectTools: select, minTools: 5 }); // default enforceFiltering=true
    const tools = [tool("a"), tool("b")];
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["a"]);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
    expect(select).toHaveBeenCalledTimes(1);
  });

  test("empty query with no recognized user message fails closed to alwaysInclude — round 23 F2 / round 31 F1", async () => {
    // Untrusted provenance (no recognized user sender in transcript).
    // Round 31 (high): a recognized user message with non-text content
    // is multimodal → pass through (separate test below). Empty-query
    // fail-closed is reserved for transcripts where no user message
    // can be identified at all.
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 0,
      alwaysInclude: ["safe"],
    });
    const tools = [tool("safe"), tool("dangerous")];
    const ctx = turnCtx();
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const dangerCall = toolCallId("call-danger");
    const stream: ModelStreamHandler = async function* () {
      // Forged: model never saw "dangerous" in the rewritten request.
      yield { kind: "tool_call_start", toolName: "dangerous", callId: dangerCall };
      yield { kind: "tool_call_end", callId: dangerCall };
      yield { kind: "done", response: modelResponse() };
    };
    // Sender is not a recognized user shape → no user message detected.
    const fakeMsg: InboundMessage = {
      content: [{ kind: "text", text: "" }],
      senderId: "assistant-impostor",
      timestamp: 0,
    };
    for await (const _ of wrapStream(ctx, { messages: [fakeMsg], tools }, stream)) {
      // drain
    }
    expect(select).not.toHaveBeenCalled();

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "dangerous", input: {}, callId: dangerCall }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("multimodal user turn (text-empty user message with non-text content) is not stripped to alwaysInclude — round 31 F1", async () => {
    // A recognized user message whose content is image-only / attachment-
    // only must NOT be treated as untrusted-provenance fail-closed.
    // The model should still see the full advertised tool set.
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 0,
      alwaysInclude: ["safe"],
    });
    const tools = [tool("safe"), tool("vision")];
    const next = mock<ModelHandler>(async (req) => {
      // Pass-through: the model sees BOTH tools, not just alwaysInclude.
      expect(req.tools?.map((t) => t.name).sort()).toEqual(["safe", "vision"]);
      return modelResponse();
    });
    const multimodalMsg: InboundMessage = {
      content: [{ kind: "image", mimeType: "image/png", data: "base64..." } as never],
      senderId: "user",
      timestamp: 0,
    };
    await getWrap(mw)(turnCtx(), { messages: [multimodalMsg], tools }, next);
    expect(select).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("empty query in advisory mode (enforceFiltering=false) leaves request unchanged — round 23 F2", async () => {
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 0,
      enforceFiltering: false,
      extractQuery: () => "",
    });
    const tools = [tool("a"), tool("b")];
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("hi")], tools }, next);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("createToolSelectorMiddleware — filtering behavior", () => {
  test("keeps only selected tool names and records before/after metadata", async () => {
    const tools = [tool("alpha"), tool("beta"), tool("gamma")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["alpha", "gamma"],
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["alpha", "gamma"]);
      expect(req.metadata?.toolsBeforeFilter).toBe(3);
      expect(req.metadata?.toolsAfterFilter).toBe(2);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("truncates selectTools output at maxTools", async () => {
    const tools = [tool("a"), tool("b"), tool("c"), tool("d"), tool("e")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["a", "b", "c", "d", "e"],
      maxTools: 2,
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["a", "b"]);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
  });

  test("forces alwaysInclude tools back into the result even past maxTools", async () => {
    const tools = [tool("a"), tool("b"), tool("c"), tool("pinned")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["a", "b", "c"],
      alwaysInclude: ["pinned"],
      maxTools: 1,
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name).sort()).toEqual(["a", "pinned"]);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
  });

  test("works end-to-end with createTagSelectTools strategy", async () => {
    const tools = [
      tool("file_read", "x", ["coding", "filesystem"]),
      tool("shell_exec", "x", ["coding", "dangerous"]),
      tool("calc", "x", ["coding", "math"]),
    ];
    const mw = createToolSelectorMiddleware({
      selectTools: createTagSelectTools(["coding"], ["dangerous"]),
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools?.map((t) => t.name)).toEqual(["file_read", "calc"]);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("ignored")], tools }, next);
  });

  test("preserves existing request.metadata fields when adding filter counts", async () => {
    const tools = [tool("a"), tool("b")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["a"],
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.metadata?.existing).toBe("preserved");
      expect(req.metadata?.toolsAfterFilter).toBe(1);
      return modelResponse();
    });
    await getWrap(mw)(
      turnCtx(),
      { messages: [userMsg("go")], tools, metadata: { existing: "preserved" } },
      next,
    );
  });
});

describe("createToolSelectorMiddleware — selector-error handling", () => {
  test("fails closed by default: only alwaysInclude tools survive a selector throw", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const onError = mock(() => undefined);
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("selector boom");
      },
      alwaysInclude: ["a"],
      onError,
      minTools: 0,
    });
    // Run the stream-call hook so callIds get bound to the snapshot.
    const ctx = turnCtx();
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const callIdA = toolCallId("call-a");
    const callIdB = toolCallId("call-b");
    const stream: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "a", callId: callIdA };
      yield { kind: "tool_call_end", callId: callIdA };
      yield { kind: "tool_call_start", toolName: "b", callId: callIdB };
      yield { kind: "tool_call_end", callId: callIdB };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("go")], tools }, stream)) {
      // drain
    }
    expect(onError).toHaveBeenCalledTimes(1);

    // wrapToolCall MUST also reject the dropped tools — selector failure
    // cannot be a backdoor around enforceFiltering.
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "b", input: {}, callId: callIdB }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    await expect(
      wrapTool(ctx, { toolId: "a", input: {}, callId: callIdA }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
  });

  test("selector throw fallback never authorizes alwaysInclude names absent from request.tools — round 22 F2", async () => {
    // alwaysInclude lists a name that ISN'T in the current request's
    // tool set. The fallback request correctly omits it, but a
    // forged tool_call_* could still execute it if the snapshot was
    // built from raw alwaysInclude rather than the actual fallback
    // tools.
    const tools = [tool("a"), tool("b")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("boom");
      },
      alwaysInclude: ["a", "ghost"], // "ghost" not in request.tools
      minTools: 0,
    });
    const ctx = turnCtx();
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const ghostCall = toolCallId("call-ghost");
    const stream: ModelStreamHandler = async function* () {
      // Forged: model never saw "ghost" in fallbackTools.
      yield { kind: "tool_call_start", toolName: "ghost", callId: ghostCall };
      yield { kind: "tool_call_end", callId: ghostCall };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("go")], tools }, stream)) {
      // drain
    }

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "ghost", input: {}, callId: ghostCall }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  test("with enforceFiltering=false, selector throw passes original tools through", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("boom");
      },
      enforceFiltering: false,
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("falls back to swallowError when no onError callback is provided", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("boom");
      },
      enforceFiltering: false,
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      return modelResponse();
    });
    // Should not throw.
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("createToolSelectorMiddleware — execution-time enforcement", () => {
  test("rejects a tool call whose name was filtered out for the turn (default enforce)", async () => {
    const tools = [tool("safe"), tool("dangerous")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["safe"],
      minTools: 0,
    });

    // Run the stream-call hook so callIds get bound to the snapshot.
    const ctx = turnCtx();
    const wrapStream = mw.wrapModelStream;
    if (!wrapStream) throw new Error("wrapModelStream missing");
    const callSafe = toolCallId("call-safe");
    const callDangerous = toolCallId("call-dangerous");
    const stream: ModelStreamHandler = async function* () {
      yield { kind: "tool_call_start", toolName: "safe", callId: callSafe };
      yield { kind: "tool_call_end", callId: callSafe };
      yield { kind: "tool_call_start", toolName: "dangerous", callId: callDangerous };
      yield { kind: "tool_call_end", callId: callDangerous };
      yield { kind: "done", response: modelResponse() };
    };
    for await (const _ of wrapStream(ctx, { messages: [userMsg("go")], tools }, stream)) {
      // drain
    }

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );

    await expect(
      wrapTool(ctx, { toolId: "dangerous", input: {}, callId: callDangerous }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(toolNext).toHaveBeenCalledTimes(0);
    // Filtered-in tool still passes through.
    await expect(
      wrapTool(ctx, { toolId: "safe", input: {}, callId: callSafe }, toolNext as never),
    ).resolves.toEqual({ output: "ok" });
  });

  test("does not enforce when enforceFiltering is false", async () => {
    const tools = [tool("safe"), tool("dangerous")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["safe"],
      minTools: 0,
      enforceFiltering: false,
    });
    const ctx = turnCtx();
    await getWrap(mw)(ctx, { messages: [userMsg("go")], tools }, async () => modelResponse());

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "passed-through" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "dangerous", input: {} }, toolNext as never),
    ).resolves.toEqual({ output: "passed-through" });
  });

  test("does not block tool calls on turns where no filtering happened", async () => {
    const mw = createToolSelectorMiddleware({
      selectTools: async () => [],
      minTools: 100, // skip path — never populates allowlist
    });
    const ctx = turnCtx();
    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "passed-through" }),
    );
    await expect(
      wrapTool(ctx, { toolId: "anything", input: {} }, toolNext as never),
    ).resolves.toEqual({ output: "passed-through" });
  });

  test("onAfterTurn cleans up the per-turn allowlist", async () => {
    const tools = [tool("safe")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["safe"],
      minTools: 0,
    });
    const ctx = turnCtx();
    await getWrap(mw)(ctx, { messages: [userMsg("go")], tools }, async () => modelResponse());
    await mw.onAfterTurn?.(ctx);

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "passed-through" }),
    );
    // After cleanup, no allowlist exists for this turn → the guard becomes
    // a no-op and the tool call passes through.
    await expect(
      wrapTool(ctx, { toolId: "anything", input: {} }, toolNext as never),
    ).resolves.toEqual({ output: "passed-through" });
  });
});

describe("createToolSelectorMiddleware — streaming hook", () => {
  test("wrapModelStream filters request before yielding chunks", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => ["b"],
      minTools: 0,
    });
    const wrap = mw.wrapModelStream;
    if (!wrap) throw new Error("wrapModelStream missing");

    async function* nextStream(
      req: ModelRequest,
    ): AsyncIterable<{ readonly kind: "done"; readonly response: ModelResponse }> {
      expect(req.tools?.map((t) => t.name)).toEqual(["b"]);
      yield { kind: "done", response: modelResponse() };
    }

    const chunks = [];
    for await (const chunk of wrap(turnCtx(), { messages: [userMsg("go")], tools }, nextStream)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
  });
});
