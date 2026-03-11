/**
 * useAguiChat hook tests — sendMessage, cancel, event→store mapping, error handling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store.js";
import { useAguiChat } from "./use-agui-chat.js";

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a ReadableStream from an array of SSE chunks. */
function makeSSEStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        if (chunk !== undefined) {
          controller.enqueue(encoder.encode(chunk));
        }
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/** Format an AG-UI event as an SSE chunk string. */
function sseEvent(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Store original fetch for cleanup. */
const originalFetch = globalThis.fetch;
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

beforeEach(() => {
  // Mock requestAnimationFrame to execute immediately (synchronous flush)
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  useChatStore.setState({
    messages: [],
    session: null,
    isStreaming: false,
    pendingText: "",
    activeToolCalls: {},
    error: null,
  });
});

describe("useAguiChat", () => {
  test("sendMessage adds user message and starts streaming", async () => {
    globalThis.fetch = async () =>
      new Response(makeSSEStream([sseEvent("RUN_STARTED"), sseEvent("RUN_FINISHED")]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("hello");
      // Allow microtasks to complete
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    // Should have a user message
    const userMsgs = state.messages.filter((m) => m.kind === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    // Streaming should be off after RUN_FINISHED
    expect(state.isStreaming).toBe(false);
  });

  test("text message events produce assistant message", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
          sseEvent("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello " }),
          sseEvent("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world" }),
          sseEvent("TEXT_MESSAGE_END", { messageId: "m1" }),
          sseEvent("RUN_FINISHED"),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("greet me");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    const assistantMsgs = state.messages.filter((m) => m.kind === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    // The accumulated text should contain "Hello world"
    const fullText = assistantMsgs.map((m) => (m.kind === "assistant" ? m.text : "")).join("");
    expect(fullText).toContain("Hello ");
    expect(fullText).toContain("world");
  });

  test("tool call events produce tool_call message", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
          sseEvent("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"test"}' }),
          sseEvent("TOOL_CALL_END", { toolCallId: "tc1" }),
          sseEvent("TOOL_CALL_RESULT", { toolCallId: "tc1", result: '["found"]' }),
          sseEvent("RUN_FINISHED"),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("search something");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    const toolMsgs = state.messages.filter((m) => m.kind === "tool_call");
    expect(toolMsgs.length).toBe(1);
    if (toolMsgs[0]?.kind === "tool_call") {
      expect(toolMsgs[0].name).toBe("search");
      expect(toolMsgs[0].args).toBe('{"q":"test"}');
      expect(toolMsgs[0].result).toBe('["found"]');
    }
  });

  test("STEP_STARTED produces lifecycle message", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("STEP_STARTED", { stepName: "planning" }),
          sseEvent("RUN_FINISHED"),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("plan");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    const lifecycleMsgs = state.messages.filter((m) => m.kind === "lifecycle");
    expect(lifecycleMsgs.length).toBe(1);
    if (lifecycleMsgs[0]?.kind === "lifecycle") {
      expect(lifecycleMsgs[0].event).toBe("Step: planning");
    }
  });

  test("RUN_ERROR sets error on store", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("RUN_ERROR", { message: "Model rate limited" }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("fail");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBe("Model rate limited");
  });

  test("HTTP error sets error message", async () => {
    globalThis.fetch = async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("fail");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBe("Internal Server Error");
  });

  test("network error sets 'Connection refused'", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("fail");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBe("Connection refused");
  });

  test("cancel aborts the stream and clears streaming state", async () => {
    let streamStarted = false;
    globalThis.fetch = async () => {
      streamStarted = true;
      // Return a stream that never ends
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sseEvent("RUN_STARTED")));
            // Never close — waits for cancel
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("hello");
      await new Promise((r) => {
        setTimeout(r, 20);
      });
    });

    expect(streamStarted).toBe(true);

    act(() => {
      result.current.cancel();
    });

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
  });

  test("cancel flushes remaining token buffer", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
          sseEvent("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "partial" }),
          // No TEXT_MESSAGE_END — user cancels mid-stream
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("hello");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    act(() => {
      result.current.cancel();
    });

    // The partial text should have been flushed
    const state = useChatStore.getState();
    // Should have at least attempted to flush tokens
    expect(state.pendingText).toBe("");
  });

  test("reasoning events are silently ignored", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("REASONING_MESSAGE_START", {}),
          sseEvent("REASONING_MESSAGE_CONTENT", { delta: "thinking..." }),
          sseEvent("REASONING_MESSAGE_END", {}),
          sseEvent("RUN_FINISHED"),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("think");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    // Only the user message — no assistant/lifecycle from reasoning
    const nonUserMsgs = state.messages.filter((m) => m.kind !== "user");
    expect(nonUserMsgs.length).toBe(0);
  });

  test("STATE_SNAPSHOT and CUSTOM events are silently ignored", async () => {
    globalThis.fetch = async () =>
      new Response(
        makeSSEStream([
          sseEvent("RUN_STARTED"),
          sseEvent("STATE_SNAPSHOT", { snapshot: { key: "value" } }),
          sseEvent("STATE_DELTA", { delta: [{ op: "add", path: "/key", value: "v" }] }),
          sseEvent("CUSTOM", { name: "debug", value: {} }),
          sseEvent("RUN_FINISHED"),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const { result } = renderHook(() => useAguiChat({ agentId: "a1" }));

    await act(async () => {
      result.current.sendMessage("test");
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    });

    const state = useChatStore.getState();
    const nonUserMsgs = state.messages.filter((m) => m.kind !== "user");
    expect(nonUserMsgs.length).toBe(0);
  });
});
