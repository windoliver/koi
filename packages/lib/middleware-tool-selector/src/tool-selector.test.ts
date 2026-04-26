import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage, ToolDescriptor, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createTagSelectTools } from "./select-strategy.js";
import { createToolSelectorMiddleware } from "./tool-selector.js";

function turnCtx(): TurnContext {
  const rid = runId("run-1");
  return {
    session: { agentId: "a", sessionId: sessionId("s-1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
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

  test("passes request through when tool count is at or below minTools", async () => {
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({ selectTools: select, minTools: 5 });
    const tools = [tool("a"), tool("b"), tool("c"), tool("d"), tool("e")];
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("hi")], tools }, next);
    expect(select).not.toHaveBeenCalled();
  });

  test("passes request through when extracted query is empty", async () => {
    const select = mock(async () => []);
    const mw = createToolSelectorMiddleware({
      selectTools: select,
      minTools: 0,
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

describe("createToolSelectorMiddleware — fail-open", () => {
  test("passes original tools through when selectTools throws and reports onError", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const onError = mock(() => undefined);
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("selector boom");
      },
      onError,
      minTools: 0,
    });
    const next = mock<ModelHandler>(async (req) => {
      expect(req.tools).toBe(tools);
      // Metadata is NOT decorated when filtering is skipped via fail-open.
      expect(req.metadata).toBeUndefined();
      return modelResponse();
    });
    await getWrap(mw)(turnCtx(), { messages: [userMsg("go")], tools }, next);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("falls back to swallowError when no onError callback is provided", async () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const mw = createToolSelectorMiddleware({
      selectTools: async () => {
        throw new Error("boom");
      },
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

    // Run the model-call hook so the per-turn allowlist is populated.
    const ctx = turnCtx();
    const wrapModel = getWrap(mw);
    const next = mock<ModelHandler>(async () => modelResponse());
    await wrapModel(ctx, { messages: [userMsg("go")], tools }, next);

    const wrapTool = mw.wrapToolCall;
    if (!wrapTool) throw new Error("wrapToolCall missing");
    const toolNext = mock<(req: { readonly toolId: string }) => Promise<{ output: string }>>(
      async () => ({ output: "ok" }),
    );

    await expect(
      wrapTool(ctx, { toolId: "dangerous", input: {} }, toolNext as never),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(toolNext).toHaveBeenCalledTimes(0);
    // Filtered-in tool still passes through.
    await expect(wrapTool(ctx, { toolId: "safe", input: {} }, toolNext as never)).resolves.toEqual({
      output: "ok",
    });
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
