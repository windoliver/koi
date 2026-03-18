/**
 * Tests for AG-UI event handler — verifies that streaming AG-UI events
 * are correctly mapped to TUI store dispatches (token appending, tool call
 * accumulation, lifecycle messages, streaming state).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AguiEvent } from "@koi/dashboard-client";
import { createStore, type TuiStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import { createAguiEventHandler } from "./agui-event-handler.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeStore(): TuiStore {
  return createStore(createInitialState("http://localhost:3100"));
}

/** Set up the store with an active session so message dispatches work. */
function withSession(store: TuiStore): void {
  store.dispatch({
    kind: "set_session",
    session: { agentId: "a1", sessionId: "s1", messages: [], pendingText: "", isStreaming: false },
  });
}

// ─── AG-UI Event Factories ────────────────────────────────────────────

function textContent(delta: string): AguiEvent {
  return { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta } as AguiEvent;
}

function textEnd(): AguiEvent {
  return { type: "TEXT_MESSAGE_END", messageId: "m1" } as AguiEvent;
}

function toolCallStart(toolCallId: string, toolCallName: string): AguiEvent {
  return { type: "TOOL_CALL_START", toolCallId, toolCallName } as AguiEvent;
}

function toolCallArgs(toolCallId: string, delta: string): AguiEvent {
  return { type: "TOOL_CALL_ARGS", toolCallId, delta } as AguiEvent;
}

function toolCallEnd(toolCallId: string): AguiEvent {
  return { type: "TOOL_CALL_END", toolCallId } as AguiEvent;
}

function toolCallResult(toolCallId: string, result: string): AguiEvent {
  return { type: "TOOL_CALL_RESULT", toolCallId, result } as AguiEvent;
}

function runStarted(): AguiEvent {
  return { type: "RUN_STARTED", threadId: "t1", runId: "r1" } as AguiEvent;
}

function runFinished(): AguiEvent {
  return { type: "RUN_FINISHED", threadId: "t1", runId: "r1" } as AguiEvent;
}

function runError(message: string): AguiEvent {
  return { type: "RUN_ERROR", message } as AguiEvent;
}

function stepStarted(stepName: string): AguiEvent {
  return { type: "STEP_STARTED", stepName } as AguiEvent;
}

function reasoningContent(delta: string): AguiEvent {
  return { type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta } as AguiEvent;
}

function reasoningEnd(): AguiEvent {
  return { type: "REASONING_MESSAGE_END", messageId: "r1" } as AguiEvent;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("createAguiEventHandler", () => {
  let store: TuiStore;
  let handler: ReturnType<typeof createAguiEventHandler>;

  beforeEach(() => {
    store = makeStore();
    withSession(store);
    handler = createAguiEventHandler(store);
  });

  describe("text message events", () => {
    test("TEXT_MESSAGE_CONTENT dispatches append_tokens", () => {
      handler.handle(textContent("Hello "));
      handler.handle(textContent("world"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.pendingText).toBe("Hello world");
    });

    test("TEXT_MESSAGE_END dispatches flush_tokens", () => {
      handler.handle(textContent("Complete message"));
      handler.handle(textEnd());

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.pendingText).toBe("");
      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.kind).toBe("assistant");
      expect((session?.messages[0] as { readonly text: string }).text).toBe("Complete message");
    });
  });

  describe("tool call lifecycle", () => {
    test("TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END creates a tool_call message", () => {
      handler.handle(toolCallStart("tc1", "readFile"));
      handler.handle(toolCallArgs("tc1", '{"path":'));
      handler.handle(toolCallArgs("tc1", '"/tmp/f"}'));
      handler.handle(toolCallEnd("tc1"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(1);

      const msg = session?.messages[0];
      if (msg === undefined) return;
      expect(msg.kind).toBe("tool_call");
      if (msg.kind === "tool_call") {
        expect(msg.name).toBe("readFile");
        expect(msg.args).toBe('{"path":"/tmp/f"}');
        expect(msg.result).toBeUndefined();
        expect(msg.toolCallId).toBe("tc1");
      }
    });

    test("TOOL_CALL_RESULT updates the tool call message with a result", () => {
      handler.handle(toolCallStart("tc1", "readFile"));
      handler.handle(toolCallArgs("tc1", '{"path":"/tmp/f"}'));
      handler.handle(toolCallEnd("tc1"));
      handler.handle(toolCallResult("tc1", "file contents here"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(1);

      const msg = session?.messages[0];
      if (msg === undefined) return;
      expect(msg.kind).toBe("tool_call");
      if (msg.kind === "tool_call") {
        expect(msg.result).toBe("file contents here");
      }
    });

    test("TOOL_CALL_ARGS for unknown toolCallId is silently ignored", () => {
      handler.handle(toolCallArgs("unknown-id", "some args"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(0);
    });

    test("TOOL_CALL_END for unknown toolCallId does not create a message", () => {
      handler.handle(toolCallEnd("unknown-id"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(0);
    });
  });

  describe("run lifecycle events", () => {
    test("RUN_STARTED sets streaming true and adds lifecycle message", () => {
      handler.handle(runStarted());

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.isStreaming).toBe(true);
      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.kind).toBe("lifecycle");
      if (session?.messages[0]?.kind === "lifecycle") {
        expect(session?.messages[0]?.event).toBe("Run started");
      }
    });

    test("RUN_FINISHED sets streaming false and adds lifecycle message", () => {
      // Start first so streaming is true
      handler.handle(runStarted());
      handler.handle(runFinished());

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.isStreaming).toBe(false);
      expect(session?.messages).toHaveLength(2);
      expect(session?.messages[1]?.kind).toBe("lifecycle");
      if (session?.messages[1]?.kind === "lifecycle") {
        expect(session?.messages[1]?.event).toBe("Run finished");
      }
    });

    test("RUN_ERROR sets streaming false and adds lifecycle message with error", () => {
      handler.handle(runStarted());
      handler.handle(runError("Model rate limited"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.isStreaming).toBe(false);
      expect(session?.messages).toHaveLength(2);
      expect(session?.messages[1]?.kind).toBe("lifecycle");
      if (session?.messages[1]?.kind === "lifecycle") {
        expect(session?.messages[1]?.event).toBe("Error: Model rate limited");
      }
    });
  });

  describe("step events", () => {
    test("STEP_STARTED adds lifecycle message with step name", () => {
      handler.handle(stepStarted("planning"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.kind).toBe("lifecycle");
      if (session?.messages[0]?.kind === "lifecycle") {
        expect(session?.messages[0]?.event).toBe("Step: planning");
      }
    });
  });

  describe("reasoning message events", () => {
    test("REASONING_MESSAGE_CONTENT appends tokens", () => {
      handler.handle(reasoningContent("Let me think"));
      handler.handle(reasoningContent(" about this"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.pendingText).toBe("Let me think about this");
    });

    test("REASONING_MESSAGE_END flushes tokens", () => {
      handler.handle(reasoningContent("Reasoning complete"));
      handler.handle(reasoningEnd());

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.pendingText).toBe("");
      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.kind).toBe("assistant");
    });
  });

  describe("unknown events", () => {
    test("unknown event types are silently ignored", () => {
      const beforeState = store.getState();

      handler.handle({ type: "CUSTOM", name: "debug", value: 42 } as AguiEvent);
      handler.handle({ type: "STATE_SNAPSHOT", snapshot: {} } as AguiEvent);
      handler.handle({
        type: "TEXT_MESSAGE_START",
        messageId: "m1",
        role: "assistant",
      } as AguiEvent);

      const afterState = store.getState();
      // State should be unchanged — these events are not handled
      expect(afterState.activeSession?.messages).toHaveLength(0);
      expect(afterState.activeSession?.pendingText).toBe("");
      expect(afterState.activeSession?.isStreaming).toBe(beforeState.activeSession?.isStreaming);
    });
  });

  describe("clear", () => {
    test("clear() empties pending tool calls so subsequent END is a no-op", () => {
      handler.handle(toolCallStart("tc1", "readFile"));
      handler.handle(toolCallArgs("tc1", '{"path":"/tmp"}'));

      // Clear pending state
      handler.clear();

      // TOOL_CALL_END after clear should not create a message
      handler.handle(toolCallEnd("tc1"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(0);
    });

    test("clear() allows fresh tool call tracking after reset", () => {
      handler.handle(toolCallStart("tc1", "readFile"));
      handler.clear();

      // Start a new tool call with a different ID
      handler.handle(toolCallStart("tc2", "writeFile"));
      handler.handle(toolCallArgs("tc2", '{"data":"hi"}'));
      handler.handle(toolCallEnd("tc2"));

      const session = store.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.messages).toHaveLength(1);

      const msg = session?.messages[0];
      if (msg === undefined) return;
      expect(msg.kind).toBe("tool_call");
      if (msg.kind === "tool_call") {
        expect(msg.name).toBe("writeFile");
        expect(msg.toolCallId).toBe("tc2");
      }
    });
  });
});
