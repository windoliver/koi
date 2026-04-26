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

  test("does not expose a wrapModelCall hook (streaming-only)", () => {
    const mw = createToolRecoveryMiddleware();
    expect(mw.wrapModelCall).toBeUndefined();
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

  test("max-attempts limit caps recovered calls", async () => {
    const mw = createToolRecoveryMiddleware({ maxToolCallsPerResponse: 2 });
    const tools = [tool("a"), tool("b"), tool("c")];
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"c","arguments":{}}</tool_call>';
    const chunks = await collect(
      getStream(mw)(turnCtx(), { messages: [], tools }, streamFromText(text)),
    );
    const starts = getToolCallChunks(chunks).filter((c) => c.kind === "tool_call_start");
    expect(starts.length).toBe(2);
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
