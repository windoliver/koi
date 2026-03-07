/**
 * Integration tests for the ACP server protocol flow.
 *
 * Uses a mock in-memory transport pair (client <-> server) to test
 * the full JSON-RPC round-trip without real stdin/stdout.
 */

import { describe, expect, test } from "bun:test";
import type { AcpTransport, RpcMessage } from "@koi/acp-protocol";
import { createAsyncQueue, createLineParser, RPC_ERROR_CODES } from "@koi/acp-protocol";
import type { EngineOutput } from "@koi/core";
import type { ProtocolHandler } from "../protocol-handler.js";
import { createProtocolHandler } from "../protocol-handler.js";
import { createRequestTracker } from "../request-tracker.js";
import type { AcpServerConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Test helpers: in-memory transport pair
// ---------------------------------------------------------------------------

type TestTransport = AcpTransport & {
  readonly sent: string[];
};

interface TransportPair {
  readonly client: TestTransport;
  readonly server: TestTransport;
}

function createTransportPair(): TransportPair {
  const toClientParser = createLineParser();
  const toServerParser = createLineParser();
  const clientQueue = createAsyncQueue<RpcMessage>("client-in");
  const serverQueue = createAsyncQueue<RpcMessage>("server-in");

  function createSide(
    inQueue: ReturnType<typeof createAsyncQueue<RpcMessage>>,
    outQueue: ReturnType<typeof createAsyncQueue<RpcMessage>>,
    outParser: ReturnType<typeof createLineParser>,
    sent: string[],
  ): TestTransport {
    // let: lifecycle flag
    let closed = false;

    return {
      sent,
      send(messageJson: string): void {
        if (closed) return;
        sent.push(messageJson);
        // Parse and deliver to peer's incoming queue
        const messages = outParser.feed(`${messageJson}\n`);
        for (const msg of messages) {
          outQueue.push(msg);
        }
      },
      receive(): AsyncIterable<RpcMessage> {
        return inQueue;
      },
      close(): void {
        closed = true;
        inQueue.end();
      },
    };
  }

  const clientSent: string[] = [];
  const serverSent: string[] = [];

  // server reads from serverQueue, sends (via toClientParser) to clientQueue
  const server = createSide(serverQueue, clientQueue, toClientParser, serverSent);
  // client reads from clientQueue, sends (via toServerParser) to serverQueue
  const client = createSide(clientQueue, serverQueue, toServerParser, clientSent);

  return { client, server };
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function createDoneOutput(stopReason: "completed" | "error" = "completed"): EngineOutput {
  return {
    content: [],
    stopReason,
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 100 },
  };
}

const DEFAULT_CONFIG: AcpServerConfig = {
  agentInfo: { name: "test-agent", version: "1.0.0" },
};

type RequestTracker = ReturnType<typeof createRequestTracker>;

/**
 * Starts the two receive loops needed for the round-trip:
 * 1. Server loop: reads client requests from server.receive(), dispatches to protocol handler
 * 2. Client loop: reads server responses from client.receive(), routes to tracker
 */
function startReceiveLoops(
  client: TestTransport,
  server: TestTransport,
  protocol: ProtocolHandler,
  tracker: RequestTracker,
): void {
  // Server receive loop — handles inbound requests from the IDE (client)
  void (async () => {
    for await (const msg of server.receive()) {
      if (msg.kind === "inbound_request") {
        switch (msg.method) {
          case "initialize":
            protocol.handleInitialize(msg.id, msg.params);
            break;
          case "session/new":
            protocol.handleSessionNew(msg.id, msg.params);
            break;
          case "session/prompt":
            void protocol.handleSessionPrompt(msg.id, msg.params);
            break;
          case "session/cancel":
            protocol.handleSessionCancel(msg.id);
            break;
        }
      }
    }
  })();

  // Client receive loop — handles responses/notifications from the server
  void (async () => {
    for await (const msg of client.receive()) {
      if (msg.kind === "success_response") {
        tracker.resolveResponse(msg.id, msg.result);
      }
      if (msg.kind === "error_response") {
        tracker.rejectResponse(msg.id, msg.error);
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("protocol flow — happy path", () => {
  test("init -> session/new -> prompt -> events -> result", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);
    const protocol = createProtocolHandler(server, DEFAULT_CONFIG);

    // Set up engine streamer that emits text events
    protocol.setEventStreamer(async function* () {
      yield { kind: "text_delta" as const, delta: "Hello" };
      yield { kind: "text_delta" as const, delta: " World" };
      yield { kind: "done" as const, output: createDoneOutput() };
    });

    startReceiveLoops(client, server, protocol, tracker);

    // Client flow
    const initResult = await tracker.sendRequest("initialize", { protocolVersion: 1 }, 5000);
    expect(initResult).toBeDefined();

    const sessionResult = (await tracker.sendRequest("session/new", { cwd: "/test" }, 5000)) as {
      sessionId: string;
    };
    expect(sessionResult.sessionId).toMatch(/^sess_/);

    const promptResult = (await tracker.sendRequest(
      "session/prompt",
      { sessionId: sessionResult.sessionId, prompt: [{ type: "text", text: "Hi" }] },
      10000,
    )) as { stopReason: string };
    expect(promptResult.stopReason).toBe("end_turn");

    // Verify session/update notifications were sent
    const notifications = server.sent
      .map((s) => JSON.parse(s) as { method?: string })
      .filter((m) => m.method === "session/update");
    expect(notifications.length).toBeGreaterThan(0);

    server.close();
    client.close();
  });
});

describe("protocol flow — error paths", () => {
  test("prompt before init returns error", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);
    const protocol = createProtocolHandler(server, DEFAULT_CONFIG);

    // Server loop — only handle session/prompt (no init)
    void (async () => {
      for await (const msg of server.receive()) {
        if (msg.kind === "inbound_request") {
          if (msg.method === "session/prompt") {
            await protocol.handleSessionPrompt(msg.id, msg.params);
          }
        }
      }
    })();

    // Client loop — route responses to tracker
    void (async () => {
      for await (const msg of client.receive()) {
        if (msg.kind === "success_response") tracker.resolveResponse(msg.id, msg.result);
        if (msg.kind === "error_response") tracker.rejectResponse(msg.id, msg.error);
      }
    })();

    await expect(
      tracker.sendRequest("session/prompt", { prompt: [{ type: "text", text: "Hi" }] }, 5000),
    ).rejects.toThrow();

    server.close();
    client.close();
  });

  test("engine error mid-stream results in error stop reason", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);
    const protocol = createProtocolHandler(server, DEFAULT_CONFIG);

    protocol.setEventStreamer(async function* () {
      yield { kind: "text_delta" as const, delta: "Start" };
      throw new Error("Engine crashed");
    });

    startReceiveLoops(client, server, protocol, tracker);

    await tracker.sendRequest("initialize", { protocolVersion: 1 }, 5000);
    const sessionResult = (await tracker.sendRequest("session/new", { cwd: "/test" }, 5000)) as {
      sessionId: string;
    };

    const result = (await tracker.sendRequest(
      "session/prompt",
      { sessionId: sessionResult.sessionId, prompt: [{ type: "text", text: "test" }] },
      10000,
    )) as { stopReason: string };
    expect(result.stopReason).toBe("error");

    server.close();
    client.close();
  });
});

describe("protocol flow — cancel", () => {
  test("session/cancel during active prompt", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);
    const protocol = createProtocolHandler(server, DEFAULT_CONFIG);

    // Slow engine that checks abort signal
    protocol.setEventStreamer(async function* (input) {
      yield { kind: "text_delta" as const, delta: "Start" };
      // Wait for abort
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { kind: "done" as const, output: createDoneOutput() };
    });

    startReceiveLoops(client, server, protocol, tracker);

    await tracker.sendRequest("initialize", { protocolVersion: 1 }, 5000);
    const cancelSessionResult = (await tracker.sendRequest(
      "session/new",
      { cwd: "/test" },
      5000,
    )) as { sessionId: string };

    // Start prompt and cancel after a brief delay
    const promptPromise = tracker.sendRequest(
      "session/prompt",
      {
        sessionId: cancelSessionResult.sessionId,
        prompt: [{ type: "text", text: "test" }],
      },
      10000,
    );

    await new Promise((r) => setTimeout(r, 50));
    await tracker.sendRequest("session/cancel", {}, 5000);

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");

    server.close();
    client.close();
  });
});

describe("protocol flow — sequential sessions", () => {
  test("new session after first completes", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);
    const protocol = createProtocolHandler(server, DEFAULT_CONFIG);

    protocol.setEventStreamer(async function* () {
      yield { kind: "text_delta" as const, delta: "Response" };
      yield { kind: "done" as const, output: createDoneOutput() };
    });

    startReceiveLoops(client, server, protocol, tracker);

    await tracker.sendRequest("initialize", { protocolVersion: 1 }, 5000);

    // First session
    const session1 = (await tracker.sendRequest("session/new", { cwd: "/test" }, 5000)) as {
      sessionId: string;
    };
    const result1 = (await tracker.sendRequest(
      "session/prompt",
      { sessionId: session1.sessionId, prompt: [{ type: "text", text: "first" }] },
      10000,
    )) as { stopReason: string };
    expect(result1.stopReason).toBe("end_turn");

    // Second session
    const session2 = (await tracker.sendRequest("session/new", { cwd: "/test2" }, 5000)) as {
      sessionId: string;
    };
    expect(session2.sessionId).not.toBe(session1.sessionId);

    const result2 = (await tracker.sendRequest(
      "session/prompt",
      { sessionId: session2.sessionId, prompt: [{ type: "text", text: "second" }] },
      10000,
    )) as { stopReason: string };
    expect(result2.stopReason).toBe("end_turn");

    server.close();
    client.close();
  });
});

describe("protocol flow — unknown method", () => {
  test("returns method_not_found for unknown methods", async () => {
    const { client, server } = createTransportPair();
    const tracker = createRequestTracker(client);

    // Server loop — return method_not_found for any request
    void (async () => {
      for await (const msg of server.receive()) {
        if (msg.kind === "inbound_request") {
          server.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: "Not found" },
            }),
          );
        }
      }
    })();

    // Client loop — route responses to tracker
    void (async () => {
      for await (const msg of client.receive()) {
        if (msg.kind === "success_response") tracker.resolveResponse(msg.id, msg.result);
        if (msg.kind === "error_response") tracker.rejectResponse(msg.id, msg.error);
      }
    })();

    await expect(tracker.sendRequest("unknown/method", {}, 5000)).rejects.toThrow("RPC error");

    server.close();
    client.close();
  });
});
