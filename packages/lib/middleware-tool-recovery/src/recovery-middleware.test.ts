import { describe, expect, test } from "bun:test";
import type { ToolDescriptor, TurnContext } from "@koi/core";
import { runId, sessionId, toolCallId, turnId } from "@koi/core";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelResponse,
  ModelStreamHandler,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createToolRecoveryMiddleware } from "./recovery-middleware.js";
import type { RecoveryEvent, ToolCallPattern } from "./types.js";

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

function tool(name: string): ToolDescriptor {
  return { name, description: name, inputSchema: {} };
}

function modelResponse(content: string, extra?: Partial<ModelResponse>): ModelResponse {
  return { content, model: "test", ...extra };
}

function getStream(mw: KoiMiddleware): NonNullable<KoiMiddleware["wrapModelStream"]> {
  const w = mw.wrapModelStream;
  if (!w) throw new Error("wrapModelStream missing");
  return w;
}

async function collect(it: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function streamFromText(text: string): ModelStreamHandler {
  return async function* () {
    yield { kind: "text_delta", delta: text };
    yield { kind: "done", response: modelResponse(text) };
  };
}

function getToolCallChunks(
  chunks: readonly ModelChunk[],
): readonly Extract<
  ModelChunk,
  { readonly kind: "tool_call_start" | "tool_call_delta" | "tool_call_end" }
>[] {
  return chunks.filter(
    (
      c,
    ): c is Extract<
      ModelChunk,
      { readonly kind: "tool_call_start" | "tool_call_delta" | "tool_call_end" }
    > => c.kind === "tool_call_start" || c.kind === "tool_call_delta" || c.kind === "tool_call_end",
  );
}

describe("createToolRecoveryMiddleware — defaults & metadata", () => {
  test("emits resolve-phase middleware with priority 180", () => {
    const mw = createToolRecoveryMiddleware();
    expect(mw.phase).toBe("resolve");
    expect(mw.priority).toBe(180);
    expect(mw.name).toBe("koi:tool-recovery");
  });

  test("describeCapabilities lists the active pattern names", () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const cap = mw.describeCapabilities(turnCtx());
    expect(cap?.label).toBe("tool-recovery");
    expect(cap?.description).toContain("hermes");
  });

  test("default patterns omit json-fence to avoid promoting example JSON", () => {
    const mw = createToolRecoveryMiddleware();
    const cap = mw.describeCapabilities(turnCtx());
    expect(cap?.description).not.toContain("json-fence");
  });

  test("exposes both wrapModelCall and wrapModelStream", () => {
    const mw = createToolRecoveryMiddleware();
    expect(mw.wrapModelCall).toBeDefined();
    expect(mw.wrapModelStream).toBeDefined();
  });

  test("throws KoiRuntimeError when config is invalid", () => {
    expect(() => createToolRecoveryMiddleware({ patterns: ["nope"] })).toThrow(KoiRuntimeError);
  });
});

describe("createToolRecoveryMiddleware — pass-through paths", () => {
  test("forwards stream untouched when request.tools is undefined", async () => {
    const mw = createToolRecoveryMiddleware();
    const text = '<tool_call>{"name":"foo","arguments":{}}</tool_call>';
    const chunks = await collect(getStream(mw)(turnCtx(), { messages: [] }, streamFromText(text)));
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ kind: "text_delta", delta: text });
  });

  test("forwards stream untouched when no pattern matches", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText("plain text response")),
    );
    expect(getToolCallChunks(chunks).length).toBe(0);
    const done = chunks.find((c): c is Extract<ModelChunk, { kind: "done" }> => c.kind === "done");
    expect(done?.response.content).toBe("plain text response");
  });
});

describe("createToolRecoveryMiddleware — recovery behavior", () => {
  test("hermes tag is converted into synthesized tool_call_* chunks and stripped from text", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("get_weather")];
    const text =
      "I'll check the weather. " +
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText(text)),
    );

    const toolChunks = getToolCallChunks(chunks);
    expect(toolChunks.length).toBe(3);
    expect(toolChunks[0]?.kind).toBe("tool_call_start");
    expect(toolChunks[1]?.kind).toBe("tool_call_delta");
    expect(toolChunks[2]?.kind).toBe("tool_call_end");

    const start = toolChunks[0] as Extract<ModelChunk, { readonly kind: "tool_call_start" }>;
    expect(start.toolName).toBe("get_weather");
    expect(start.callId).toMatch(/^recovery-.+-0$/);

    const delta = toolChunks[1] as Extract<ModelChunk, { readonly kind: "tool_call_delta" }>;
    const args = JSON.parse(delta.delta) as { readonly city: string };
    expect(args.city).toBe("Tokyo");

    const text_chunks = chunks.filter(
      (c): c is Extract<ModelChunk, { kind: "text_delta" }> => c.kind === "text_delta",
    );
    expect(text_chunks.length).toBe(1);
    expect(text_chunks[0]?.delta).toBe("I'll check the weather.");

    const done = chunks[chunks.length - 1] as Extract<ModelChunk, { kind: "done" }>;
    expect(done.response.content).toBe("I'll check the weather.");
  });

  test("multiple tool calls produce one start/delta/end triplet each", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("a"), tool("b")];
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>';
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText(text)),
    );
    const toolChunks = getToolCallChunks(chunks);
    expect(toolChunks.length).toBe(6);
    const starts = toolChunks.filter((c) => c.kind === "tool_call_start");
    expect(
      starts.map((s) => (s as Extract<ModelChunk, { kind: "tool_call_start" }>).toolName),
    ).toEqual(["a", "b"]);
  });

  test("malformed pattern body falls back to passthrough", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const tools = [tool("foo")];
    const chunks = await collect(
      getStream(mw)(
        turnCtx(),
        { messages: [], tools },
        streamFromText("<tool_call>not json</tool_call>"),
      ),
    );
    expect(getToolCallChunks(chunks).length).toBe(0);
    const done = chunks[chunks.length - 1] as Extract<ModelChunk, { kind: "done" }>;
    expect(done.response.content).toBe("<tool_call>not json</tool_call>");
  });

  test("over-cap recovery fails closed: rejects entire batch + preserves raw markup", async () => {
    const events: RecoveryEvent[] = [];
    const mw = createToolRecoveryMiddleware({
      maxToolCallsPerResponse: 2,
      onRecoveryEvent: (e) => events.push(e),
    });
    const tools = [tool("a"), tool("b"), tool("c")];
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"c","arguments":{}}</tool_call>';
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText(text)),
    );
    // No partial execution — entire batch rejected.
    expect(getToolCallChunks(chunks).length).toBe(0);
    // Raw text is preserved so the model can re-issue with fewer calls.
    const done = chunks[chunks.length - 1] as Extract<ModelChunk, { kind: "done" }>;
    expect(done.response.content).toContain("<tool_call>");
    // One rejection event per dropped call.
    const rejections = events.filter((e) => e.kind === "rejected");
    expect(rejections.length).toBe(3);
    expect(rejections[0]?.kind === "rejected" && rejections[0].reason).toContain(
      "maxToolCallsPerResponse=2",
    );
  });

  test("custom pattern registered via config is honored", async () => {
    const reactPattern: ToolCallPattern = {
      name: "react",
      detect(text) {
        const m = /Action:\s*(\w+)\nAction Input:\s*(\{.*\})/s.exec(text);
        if (m === null) return undefined;
        const args = JSON.parse(m[2] ?? "{}") as Record<string, unknown>;
        return {
          toolCalls: [{ toolName: m[1] ?? "", arguments: args as { readonly [k: string]: never } }],
          remainingText: text.replace(m[0], "").trim(),
        };
      },
    };
    const mw = createToolRecoveryMiddleware({ patterns: [reactPattern] });
    const tools = [tool("search")];
    const chunks = await collect(
      getStream(mw)(
        turnCtx(),
        { messages: [], tools },
        streamFromText('thinking...\nAction: search\nAction Input: {"q":"koi"}'),
      ),
    );
    const start = getToolCallChunks(chunks).find((c) => c.kind === "tool_call_start") as Extract<
      ModelChunk,
      { kind: "tool_call_start" }
    >;
    expect(start.toolName).toBe("search");
  });

  test("rejects tool calls whose name is not in the request allowlist", async () => {
    const events: RecoveryEvent[] = [];
    const mw = createToolRecoveryMiddleware({ onRecoveryEvent: (e) => events.push(e) });
    const tools = [tool("good")];
    const text =
      '<tool_call>{"name":"good","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"bad","arguments":{}}</tool_call>';
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText(text)),
    );
    const starts = getToolCallChunks(chunks).filter((c) => c.kind === "tool_call_start");
    expect(starts.length).toBe(1);
    expect((starts[0] as Extract<ModelChunk, { kind: "tool_call_start" }>).toolName).toBe("good");
    expect(events.some((e) => e.kind === "rejected" && e.toolName === "bad")).toBe(true);
  });
});

describe("createToolRecoveryMiddleware — non-streaming wrapModelCall", () => {
  function getCall(mw: KoiMiddleware): NonNullable<KoiMiddleware["wrapModelCall"]> {
    const w = mw.wrapModelCall;
    if (!w) throw new Error("wrapModelCall missing");
    return w;
  }

  test("rewrites response.metadata.toolCalls and strips markup from content", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const text = 'thinking. <tool_call>{"name":"foo","arguments":{"k":1}}</tool_call> done.';
    const out = await getCall(mw)(turnCtx(), { messages: [], tools }, async () =>
      modelResponse(text),
    );
    expect(out.content).not.toContain("<tool_call>");
    const calls = out.metadata?.toolCalls as ReadonlyArray<{
      readonly toolName: string;
      readonly callId: string;
      readonly input: { readonly k: number };
    }>;
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolName).toBe("foo");
    expect(calls[0]?.input.k).toBe(1);
    expect(calls[0]?.callId).toMatch(/^recovery-/);
  });

  test("passes through when adapter already set metadata.toolCalls", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const native = [{ toolName: "foo", callId: "native-1", input: {} }];
    const out = await getCall(mw)(turnCtx(), { messages: [], tools }, async () =>
      modelResponse('<tool_call>{"name":"foo","arguments":{}}</tool_call>', {
        metadata: { toolCalls: native },
      }),
    );
    expect(out.metadata?.toolCalls).toBe(native);
  });

  test("passes through when no tools are advertised", async () => {
    const mw = createToolRecoveryMiddleware();
    const text = '<tool_call>{"name":"foo","arguments":{}}</tool_call>';
    const out = await getCall(mw)(turnCtx(), { messages: [] }, async () => modelResponse(text));
    expect(out.content).toBe(text);
    expect(out.metadata?.toolCalls).toBeUndefined();
  });
});

describe("createToolRecoveryMiddleware — streaming buffer & bypass", () => {
  test("does not leak raw markup as text_delta — original raw text never reaches consumers", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "thinking..." };
      yield { kind: "text_delta", delta: ' <tool_call>{"name":"foo","arguments":{}}' };
      yield { kind: "text_delta", delta: "</tool_call> done." };
      yield {
        kind: "done",
        response: modelResponse(
          'thinking... <tool_call>{"name":"foo","arguments":{}}</tool_call> done.',
        ),
      };
    };
    const chunks = await collect(getStream(mw)(turnCtx(), { messages: [], tools }, next));
    const textChunks = chunks.filter(
      (c): c is Extract<ModelChunk, { kind: "text_delta" }> => c.kind === "text_delta",
    );
    for (const t of textChunks) {
      expect(t.delta).not.toContain("<tool_call>");
      expect(t.delta).not.toContain("</tool_call>");
    }
  });

  test("native tool_call_start triggers bypass — buffered text + raw markup forwarded as-is", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const cid = toolCallId("native-1");
    const next: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: '<tool_call>{"name":"foo","arguments":{}}</tool_call>' };
      yield { kind: "tool_call_start", toolName: "foo", callId: cid };
      yield { kind: "tool_call_end", callId: cid };
      yield { kind: "done", response: modelResponse("") };
    };
    const chunks = await collect(getStream(mw)(turnCtx(), { messages: [], tools }, next));
    // Bypass means: buffered text_delta is replayed unchanged, then the
    // native chunks pass through. No synthesized recovery chunks added.
    const starts = getToolCallChunks(chunks).filter((c) => c.kind === "tool_call_start");
    expect(starts.length).toBe(1);
    const start = starts[0] as Extract<ModelChunk, { kind: "tool_call_start" }>;
    expect(start.callId).toBe(cid);
  });

  test("flushes buffered chunks and rethrows when upstream stream throws before done", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "partial assistant text " };
      yield { kind: "thinking_delta", delta: "considering..." };
      throw new Error("upstream timed out");
    };

    const out: ModelChunk[] = [];
    let caught: unknown;
    try {
      for await (const c of getStream(mw)(turnCtx(), { messages: [], tools }, next)) {
        out.push(c);
      }
    } catch (e: unknown) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream timed out");
    // Buffered chunks must be flushed so partial output is recoverable.
    expect(out.some((c) => c.kind === "text_delta")).toBe(true);
    expect(out.some((c) => c.kind === "thinking_delta")).toBe(true);
  });

  test("thinking_delta and usage chunks are preserved across the buffer", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next: ModelStreamHandler = async function* () {
      yield { kind: "thinking_delta", delta: "let me check..." };
      yield { kind: "text_delta", delta: '<tool_call>{"name":"foo","arguments":{}}</tool_call>' };
      yield { kind: "usage", inputTokens: 10, outputTokens: 5 };
      yield { kind: "done", response: modelResponse("") };
    };
    const chunks = await collect(getStream(mw)(turnCtx(), { messages: [], tools }, next));
    expect(chunks.some((c) => c.kind === "thinking_delta")).toBe(true);
    expect(chunks.some((c) => c.kind === "usage")).toBe(true);
    expect(getToolCallChunks(chunks).filter((c) => c.kind === "tool_call_start").length).toBe(1);
  });
});
