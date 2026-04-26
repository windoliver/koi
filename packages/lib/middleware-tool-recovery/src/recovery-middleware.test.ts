import { describe, expect, mock, test } from "bun:test";
import type { ToolDescriptor, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
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

function getWrap(
  mw: KoiMiddleware,
): (ctx: TurnContext, req: ModelRequest, next: ModelHandler) => Promise<ModelResponse> {
  const wrap = mw.wrapModelCall;
  if (!wrap) throw new Error("wrapModelCall missing");
  return wrap;
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

  test("throws KoiRuntimeError when config is invalid", () => {
    expect(() => createToolRecoveryMiddleware({ patterns: ["nope"] })).toThrow(KoiRuntimeError);
  });
});

describe("createToolRecoveryMiddleware — pass-through paths", () => {
  test("passes request through when request.tools is undefined", async () => {
    const mw = createToolRecoveryMiddleware();
    const text = '<tool_call>{"name":"foo","arguments":{}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [] }, next);
    expect(out.content).toBe(text);
    expect(out.metadata?.toolCalls).toBeUndefined();
  });

  test("passes through when response already has metadata.toolCalls", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next = mock<ModelHandler>(async () =>
      modelResponse('<tool_call>{"name":"foo","arguments":{}}</tool_call>', {
        metadata: { toolCalls: [{ toolName: "foo", callId: "x", input: {} }] },
      }),
    );
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    // Original toolCalls preserved unchanged.
    const calls = out.metadata?.toolCalls;
    expect(Array.isArray(calls) ? calls.length : 0).toBe(1);
  });

  test("returns response unchanged when no pattern matches", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next = mock<ModelHandler>(async () => modelResponse("plain text response"));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    expect(out.content).toBe("plain text response");
    expect(out.metadata?.toolCalls).toBeUndefined();
  });
});

describe("createToolRecoveryMiddleware — recovery behavior", () => {
  test("hermes tag is converted into metadata.toolCalls and stripped from content", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("get_weather")];
    const text =
      "I'll check the weather. " +
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);

    expect(out.content).toBe("I'll check the weather.");
    const calls = out.metadata?.toolCalls as ReadonlyArray<{
      readonly toolName: string;
      readonly callId: string;
      readonly input: { readonly city: string };
    }>;
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolName).toBe("get_weather");
    expect(calls[0]?.input.city).toBe("Tokyo");
    expect(calls[0]?.callId).toMatch(/^recovery-.+-0$/);
  });

  test("multiple tool calls in one response yield deterministic indexed callIds", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("a"), tool("b")];
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    const calls = out.metadata?.toolCalls as ReadonlyArray<{ readonly callId: string }>;
    expect(calls.map((c) => c.callId)).toEqual([
      expect.stringMatching(/-0$/) as unknown as string,
      expect.stringMatching(/-1$/) as unknown as string,
    ]);
  });

  test("malformed pattern body falls back to next pattern (then to passthrough)", async () => {
    const mw = createToolRecoveryMiddleware({ patterns: ["hermes"] });
    const tools = [tool("foo")];
    const next = mock<ModelHandler>(async () => modelResponse("<tool_call>not json</tool_call>"));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    // Hermes returns undefined on malformed body — response passes through.
    expect(out.metadata?.toolCalls).toBeUndefined();
    expect(out.content).toBe("<tool_call>not json</tool_call>");
  });

  test("max-attempts limit caps recovered calls", async () => {
    const mw = createToolRecoveryMiddleware({ maxToolCallsPerResponse: 2 });
    const tools = [tool("a"), tool("b"), tool("c")];
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"c","arguments":{}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    const calls = out.metadata?.toolCalls as ReadonlyArray<{ readonly toolName: string }>;
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.toolName)).toEqual(["a", "b"]);
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
    const text = 'thinking...\nAction: search\nAction Input: {"q":"koi"}';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    const calls = out.metadata?.toolCalls as ReadonlyArray<{
      readonly toolName: string;
      readonly input: { readonly q: string };
    }>;
    expect(calls[0]?.toolName).toBe("search");
    expect(calls[0]?.input.q).toBe("koi");
  });

  test("downstream middleware (simulated by next response inspection) sees structured calls", async () => {
    // Compose two middleware: recovery wraps a downstream that inspects the
    // request → next call. We assert that the rewritten response is what
    // any subsequent middleware would observe coming back from `next`.
    const recovery = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const text = '<tool_call>{"name":"foo","arguments":{"k":1}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const downstreamResponse = await getWrap(recovery)(turnCtx(), { messages: [], tools }, next);
    const observed = downstreamResponse.metadata?.toolCalls;
    expect(observed).toBeDefined();
  });

  test("rejects tool calls whose name is not in the request allowlist", async () => {
    const events: RecoveryEvent[] = [];
    const mw = createToolRecoveryMiddleware({ onRecoveryEvent: (e) => events.push(e) });
    const tools = [tool("good")];
    const text =
      '<tool_call>{"name":"good","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"bad","arguments":{}}</tool_call>';
    const next = mock<ModelHandler>(async () => modelResponse(text));
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    const calls = out.metadata?.toolCalls as ReadonlyArray<{ readonly toolName: string }>;
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolName).toBe("good");
    expect(events.some((e) => e.kind === "rejected" && e.toolName === "bad")).toBe(true);
  });

  test("preserves existing response.metadata fields when injecting toolCalls", async () => {
    const mw = createToolRecoveryMiddleware();
    const tools = [tool("foo")];
    const next = mock<ModelHandler>(async () =>
      modelResponse('<tool_call>{"name":"foo","arguments":{}}</tool_call>', {
        metadata: { existing: "preserved" },
      }),
    );
    const out = await getWrap(mw)(turnCtx(), { messages: [], tools }, next);
    expect(out.metadata?.existing).toBe("preserved");
    expect(out.metadata?.toolCalls).toBeDefined();
  });
});
