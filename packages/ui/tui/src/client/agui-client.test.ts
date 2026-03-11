import { afterEach, describe, expect, test } from "bun:test";
import { type AguiClientConfig, type AguiEvent, startChatStream } from "./agui-client.js";

// ─── Mock fetch ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

function sseResponse(...events: readonly Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  const chunks = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);

  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const chunk of chunks) {
        ctrl.enqueue(encoder.encode(chunk));
      }
      ctrl.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const CONFIG: AguiClientConfig = {
  baseUrl: "http://localhost:3100",
  path: "/agent",
  authToken: "test-token",
  timeoutMs: 10_000,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startChatStream", () => {
  test("sends correct POST body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    mockFetch((input, init) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedInit = init;
      return sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      );
    });

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hello",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;
    expect(events).toHaveLength(2);
    expect(capturedUrl).toBe("http://localhost:3100/agent");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  test("streams text message deltas", async () => {
    mockFetch(() =>
      sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hello" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: " world" },
        { type: "TEXT_MESSAGE_END", messageId: "m1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      ),
    );

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;

    const deltas = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(deltas).toHaveLength(2);

    const firstDelta = deltas[0];
    if (firstDelta?.type === "TEXT_MESSAGE_CONTENT") {
      expect(firstDelta.delta).toBe("Hello");
    }

    const secondDelta = deltas[1];
    if (secondDelta?.type === "TEXT_MESSAGE_CONTENT") {
      expect(secondDelta.delta).toBe(" world");
    }
  });

  test("streams tool call events", async () => {
    mockFetch(() =>
      sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TOOL_CALL_START", toolCallId: "tc1", toolCallName: "search_web" },
        { type: "TOOL_CALL_ARGS", toolCallId: "tc1", delta: '{"q":"test"}' },
        { type: "TOOL_CALL_END", toolCallId: "tc1" },
        { type: "TOOL_CALL_RESULT", toolCallId: "tc1", result: '["result1"]' },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      ),
    );

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "search",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;

    const toolStart = events.find((e) => e.type === "TOOL_CALL_START");
    expect(toolStart).toBeDefined();
    if (toolStart?.type === "TOOL_CALL_START") {
      expect(toolStart.toolCallName).toBe("search_web");
    }

    const toolResult = events.find((e) => e.type === "TOOL_CALL_RESULT");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "TOOL_CALL_RESULT") {
      expect(toolResult.result).toBe('["result1"]');
    }
  });

  test("handles RUN_ERROR", async () => {
    mockFetch(() =>
      sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "RUN_ERROR", message: "Model failed" },
      ),
    );

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;

    const error = events.find((e) => e.type === "RUN_ERROR");
    expect(error).toBeDefined();
    if (error?.type === "RUN_ERROR") {
      expect(error.message).toBe("Model failed");
    }
  });

  test("calls onClose when stream completes", async () => {
    mockFetch(() =>
      sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      ),
    );

    let closed = false;
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: () => {},
        onClose: () => {
          closed = true;
        },
      },
    );

    await handle.done;
    expect(closed).toBe(true);
  });

  test("calls onError for HTTP errors", async () => {
    mockFetch(() => new Response("Internal Server Error", { status: 500 }));

    let receivedError: unknown;
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: () => {},
        onError: (e) => {
          receivedError = e;
        },
      },
    );

    await handle.done;
    expect(receivedError).toBeDefined();
    expect((receivedError as { kind: string }).kind).toBe("api_error");
  });

  test("calls onError for network failures", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });

    let receivedError: unknown;
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: () => {},
        onError: (e) => {
          receivedError = e;
        },
      },
    );

    await handle.done;
    expect(receivedError).toBeDefined();
    expect((receivedError as { kind: string }).kind).toBe("connection_refused");
  });

  test("includes history messages in POST body", async () => {
    let capturedBody: string | undefined;
    mockFetch((_input, init) => {
      if (typeof init?.body === "string") {
        capturedBody = init.body;
      }
      return sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      );
    });

    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "follow-up",
        history: [
          { id: "h1", role: "user", content: "first" },
          { id: "h2", role: "assistant", content: "response" },
        ],
      },
      {
        onEvent: () => {},
      },
    );

    await handle.done;

    const body = JSON.parse(capturedBody ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.messages[1]?.role).toBe("assistant");
    expect(body.messages[2]?.role).toBe("user");
    expect(body.messages[2]?.content).toBe("follow-up");
  });

  test("skips malformed SSE events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode('data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n'),
        );
        ctrl.enqueue(encoder.encode("data: not-json\n\n"));
        ctrl.enqueue(
          encoder.encode('data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}\n\n'),
        );
        ctrl.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    mockFetch(() => response);

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "hi",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;
    // Malformed event should be skipped
    expect(events).toHaveLength(2);
  });

  test("handles reasoning events", async () => {
    mockFetch(() =>
      sseResponse(
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "REASONING_MESSAGE_START", messageId: "r1" },
        { type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "thinking..." },
        { type: "REASONING_MESSAGE_END", messageId: "r1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      ),
    );

    const events: AguiEvent[] = [];
    const handle = startChatStream(
      CONFIG,
      {
        threadId: "t1",
        runId: "r1",
        message: "think hard",
      },
      {
        onEvent: (e) => {
          events.push(e);
        },
      },
    );

    await handle.done;

    const reasoning = events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT");
    expect(reasoning).toHaveLength(1);
  });
});
