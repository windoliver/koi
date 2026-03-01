/**
 * Unit tests for createEscalationGate and parseHumanResponse.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChannelAdapter, InboundMessage, MessageHandler } from "@koi/core";
import { createEscalationGate, parseHumanResponse } from "./escalation-gate.js";

// ---------------------------------------------------------------------------
// Mock channel
// ---------------------------------------------------------------------------

function createMockChannel(): ChannelAdapter & {
  readonly simulateMessage: (msg: InboundMessage) => Promise<void>;
} {
  const handlers: MessageHandler[] = [];

  return {
    name: "test-channel",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    onMessage: (handler: MessageHandler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    simulateMessage: async (msg: InboundMessage) => {
      for (const handler of [...handlers]) {
        await handler(msg);
      }
    },
  };
}

function createTextMessage(text: string): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "human",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// parseHumanResponse
// ---------------------------------------------------------------------------

describe("parseHumanResponse", () => {
  test("parses 'abort' as abort decision", () => {
    const result = parseHumanResponse(createTextMessage("abort"));
    expect(result.kind).toBe("abort");
    if (result.kind === "abort") {
      expect(result.reason).toContain("Human operator");
    }
  });

  test("parses 'ABORT' (case-insensitive) as abort decision", () => {
    const result = parseHumanResponse(createTextMessage("  ABORT  "));
    expect(result.kind).toBe("abort");
  });

  test("parses any other text as resume with instruction", () => {
    const result = parseHumanResponse(createTextMessage("Try using a different API endpoint"));
    expect(result.kind).toBe("resume");
    if (result.kind === "resume") {
      expect(result.instruction).toBe("Try using a different API endpoint");
    }
  });

  test("parses message with no text blocks as resume without instruction", () => {
    const msg: InboundMessage = {
      content: [{ kind: "image", url: "https://example.com/img.png" }],
      senderId: "human",
      timestamp: Date.now(),
    };
    const result = parseHumanResponse(msg);
    expect(result.kind).toBe("resume");
    if (result.kind === "resume") {
      expect(result.instruction).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// createEscalationGate
// ---------------------------------------------------------------------------

describe("createEscalationGate", () => {
  const channels: Array<ReturnType<typeof createMockChannel>> = [];

  afterEach(() => {
    channels.length = 0;
  });

  function channel(): ReturnType<typeof createMockChannel> {
    const ch = createMockChannel();
    channels.push(ch);
    return ch;
  }

  test("resolves on human message response", async () => {
    const ch = channel();
    const gate = createEscalationGate(ch);

    expect(gate.isPending()).toBe(true);

    await ch.simulateMessage(createTextMessage("Continue with plan B"));

    const decision = await gate.promise;
    expect(decision.kind).toBe("resume");
    if (decision.kind === "resume") {
      expect(decision.instruction).toBe("Continue with plan B");
    }
    expect(gate.isPending()).toBe(false);
  });

  test("resolves as abort on timeout", async () => {
    const ch = channel();
    const gate = createEscalationGate(ch, undefined, 50);

    const decision = await gate.promise;
    expect(decision.kind).toBe("abort");
    if (decision.kind === "abort") {
      expect(decision.reason).toContain("timed out");
    }
    expect(gate.isPending()).toBe(false);
  });

  test("resolves as abort on AbortSignal", async () => {
    const ch = channel();
    const controller = new AbortController();
    const gate = createEscalationGate(ch, controller.signal);

    expect(gate.isPending()).toBe(true);
    controller.abort();

    const decision = await gate.promise;
    expect(decision.kind).toBe("abort");
    if (decision.kind === "abort") {
      expect(decision.reason).toContain("aborted via signal");
    }
  });

  test("resolves as abort on already-aborted signal", async () => {
    const ch = channel();
    const controller = new AbortController();
    controller.abort();

    const gate = createEscalationGate(ch, controller.signal);
    const decision = await gate.promise;

    expect(decision.kind).toBe("abort");
    expect(gate.isPending()).toBe(false);
  });

  test("cancel resolves as abort", async () => {
    const ch = channel();
    const gate = createEscalationGate(ch);

    expect(gate.isPending()).toBe(true);
    gate.cancel();

    const decision = await gate.promise;
    expect(decision.kind).toBe("abort");
    if (decision.kind === "abort") {
      expect(decision.reason).toContain("cancelled");
    }
  });

  test("second message after resolution is ignored", async () => {
    const ch = channel();
    const gate = createEscalationGate(ch);

    await ch.simulateMessage(createTextMessage("first instruction"));
    const decision = await gate.promise;
    expect(decision.kind).toBe("resume");

    // Second message should not cause issues
    await ch.simulateMessage(createTextMessage("second instruction"));
    // Still resolved to first
    expect(gate.isPending()).toBe(false);
  });

  test("cleanup removes listener from channel", async () => {
    const ch = channel();
    const gate = createEscalationGate(ch);

    gate.cancel();
    await gate.promise;

    // After cancellation, the channel should have no listeners left.
    // Sending a message should not throw.
    await ch.simulateMessage(createTextMessage("should be ignored"));
    expect(gate.isPending()).toBe(false);
  });
});
