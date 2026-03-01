/**
 * Tests for the ACP protocol handler.
 */

import { describe, expect, test } from "bun:test";
import type { AcpTransport } from "@koi/acp-protocol";
import { createProtocolHandler } from "./protocol-handler.js";
import type { AcpServerConfig } from "./types.js";

function createMockTransport(): AcpTransport & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(messageJson: string): void {
      sent.push(messageJson);
    },
    receive(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true as const, value: undefined as never };
            },
          };
        },
      };
    },
    close(): void {},
  };
}

const DEFAULT_CONFIG: AcpServerConfig = {
  agentInfo: { name: "test-agent", version: "1.0.0" },
};

function parseResponse(json: string): { id: unknown; result?: unknown; error?: unknown } {
  return JSON.parse(json) as { id: unknown; result?: unknown; error?: unknown };
}

describe("handleInitialize", () => {
  test("returns agent capabilities on valid initialize", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });

    expect(handler.getState().initialized).toBe(true);
    const response = parseResponse(transport.sent[0] as string);
    expect(response.id).toBe(1);
    const result = response.result as { protocolVersion: number; agentInfo: { name: string } };
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo.name).toBe("test-agent");
  });

  test("rejects double initialization", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    handler.handleInitialize(2, { protocolVersion: 1 });

    const response = parseResponse(transport.sent[1] as string);
    expect(response.error).toBeDefined();
  });

  test("rejects missing protocolVersion", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, {});

    const response = parseResponse(transport.sent[0] as string);
    expect(response.error).toBeDefined();
    expect(handler.getState().initialized).toBe(false);
  });
});

describe("handleSessionNew", () => {
  test("creates session after initialization", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    handler.handleSessionNew(2, { cwd: "/test" });

    const response = parseResponse(transport.sent[1] as string);
    const result = response.result as { sessionId: string };
    expect(result.sessionId).toMatch(/^sess_/);
    expect(handler.getState().session).toBeDefined();
  });

  test("rejects session/new before initialization", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleSessionNew(1, { cwd: "/test" });

    const response = parseResponse(transport.sent[0] as string);
    expect(response.error).toBeDefined();
  });
});

describe("handleSessionPrompt", () => {
  test("rejects prompt before initialization", async () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    await handler.handleSessionPrompt(1, { prompt: [{ type: "text", text: "hello" }] });

    const response = parseResponse(transport.sent[0] as string);
    expect(response.error).toBeDefined();
  });

  test("rejects prompt before session/new", async () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    await handler.handleSessionPrompt(2, {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "hello" }],
    });

    const response = parseResponse(transport.sent[1] as string);
    expect(response.error).toBeDefined();
  });

  test("rejects concurrent prompts", async () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    handler.handleSessionNew(2, { cwd: "/test" });

    // Set up a slow event streamer
    handler.setEventStreamer(async function* () {
      await new Promise((r) => setTimeout(r, 200));
      yield {
        kind: "done" as const,
        output: {
          content: [],
          stopReason: "completed" as const,
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
        },
      };
    });

    const p1 = handler.handleSessionPrompt(3, {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "first" }],
    });

    // Give first prompt time to start
    await new Promise((r) => setTimeout(r, 10));

    await handler.handleSessionPrompt(4, {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "second" }],
    });

    // Check that the second prompt was rejected
    const responses = transport.sent.map((s) => parseResponse(s));
    const errorResponses = responses.filter((r) => r.error !== undefined);
    expect(errorResponses.length).toBeGreaterThan(0);

    await p1;
  });

  test("rejects prompt with missing content", async () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    handler.handleSessionNew(2, { cwd: "/test" });
    await handler.handleSessionPrompt(3, { sessionId: "sess_1" });

    const response = parseResponse(transport.sent[2] as string);
    expect(response.error).toBeDefined();
  });

  test("completes prompt with engine events", async () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleInitialize(1, { protocolVersion: 1 });
    handler.handleSessionNew(2, { cwd: "/test" });

    handler.setEventStreamer(async function* () {
      yield { kind: "text_delta" as const, delta: "Hello" };
      yield {
        kind: "done" as const,
        output: {
          content: [],
          stopReason: "completed" as const,
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
        },
      };
    });

    await handler.handleSessionPrompt(3, {
      sessionId: "sess_1",
      prompt: [{ type: "text", text: "test" }],
    });

    // Should have: init response, session/new response, session/update notification, prompt result
    expect(transport.sent.length).toBeGreaterThanOrEqual(3);

    // Find the prompt result (last response with id=3)
    const promptResult = transport.sent.map((s) => parseResponse(s)).find((r) => r.id === 3);
    expect(promptResult?.result).toBeDefined();
    const result = promptResult?.result as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("handleSessionCancel", () => {
  test("responds to cancel even with no active prompt", () => {
    const transport = createMockTransport();
    const handler = createProtocolHandler(transport, DEFAULT_CONFIG);

    handler.handleSessionCancel(1);

    const response = parseResponse(transport.sent[0] as string);
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
  });
});
