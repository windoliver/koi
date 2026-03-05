/**
 * Integration tests for createAguiChannel — standalone Bun.serve mode.
 *
 * Tests platformConnect/Disconnect, platformSend, and onPlatformEvent by
 * operating the channel via its public ChannelAdapter interface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { ChannelAdapter, OutboundMessage } from "@koi/core";
import { createAguiChannel } from "../agui-channel.js";
import type { RunContextStore, SseWriter } from "../run-context-store.js";

// Use a dedicated port that doesn't conflict with integration.test.ts (19371).
const PORT = 19373;
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeInput(runId = "run-channel-test"): RunAgentInput {
  return {
    threadId: "thread-chan",
    runId,
    messages: [{ id: "m1", role: "user", content: "hello" }],
    tools: [],
    context: [],
  };
}

/** Read SSE events from a ReadableStream until RUN_FINISHED/RUN_ERROR or EOF. */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 3000,
): Promise<readonly BaseEvent[]> {
  const events: BaseEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // let requires justification: partial frame buffer across chunks
  let buffer = "";

  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const trimmed = frame.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            events.push(JSON.parse(trimmed.slice(6)) as BaseEvent);
          } catch {
            // skip malformed frame
          }
        }
      }

      const last = events.at(-1);
      if (
        last !== undefined &&
        (last.type === EventType.RUN_FINISHED || last.type === EventType.RUN_ERROR)
      ) {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.cancel();
    } catch {
      // already cancelled
    }
  }

  return events;
}

/**
 * Lightweight mock SSE writer for direct store injection tests.
 * Avoids real WritableStream backpressure issues.
 */
function makeMockSseWriter(): { writer: SseWriter; capturedEvents: () => readonly BaseEvent[] } {
  const events: BaseEvent[] = [];
  const decoder = new TextDecoder();

  const writer = {
    write: async (chunk: Uint8Array): Promise<void> => {
      const text = decoder.decode(chunk);
      for (const frame of text.split("\n\n")) {
        const trimmed = frame.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            events.push(JSON.parse(trimmed.slice(6)) as BaseEvent);
          } catch {
            // ignore malformed frames
          }
        }
      }
    },
    close: async (): Promise<void> => {},
    abort: async (): Promise<void> => {},
    releaseLock: (): void => {},
    get closed(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    get ready(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    get desiredSize(): number | null {
      return 1;
    },
  } as unknown as SseWriter;

  return { writer, capturedEvents: () => [...events] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAguiChannel — standalone server", () => {
  let channel: ChannelAdapter;
  let store: RunContextStore;

  beforeEach(() => {
    ({ channel, store } = createAguiChannel({ port: PORT }));
  });

  afterEach(async () => {
    try {
      await channel.disconnect();
    } catch {
      // already disconnected
    }
  });

  test("GET /agent returns 404", async () => {
    await channel.connect();
    const res = await fetch(`${BASE}/agent`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test("POST to non-matching path returns 404", async () => {
    await channel.connect();
    const res = await fetch(`${BASE}/other`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test("POST /agent with invalid body returns 400", async () => {
    await channel.connect();
    const res = await fetch(`${BASE}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"not": "valid"}',
    });
    expect(res.status).toBe(400);
  });

  test("POST /agent streams RUN_STARTED + STATE_SNAPSHOT lifecycle events", async () => {
    // No onMessage handlers — dispatch resolves after a tick, .then() closes stream.
    await channel.connect();
    const res = await fetch(`${BASE}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeInput("run-lifecycle")),
    });

    if (res.body === null) throw new Error("expected non-null body");
    const events = await readSseStream(res.body);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[1]).toBe(EventType.STATE_SNAPSHOT);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  });

  test("send() emits TEXT events and RUN_FINISHED via platformSend", async () => {
    await channel.connect();

    // Manually inject a mock SSE writer into the store to simulate an active request.
    const runId = "run-send-text";
    const { writer, capturedEvents } = makeMockSseWriter();
    const ac = new AbortController();
    store.register(runId, writer, ac.signal);

    const msg: OutboundMessage = {
      threadId: "thread-chan",
      content: [{ kind: "text", text: "hello from agent" }],
      metadata: { runId },
    };
    await channel.send(msg);

    // platformSend deregisters the run after sending.
    expect(store.get(runId)).toBeUndefined();

    const events = capturedEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  test("send() skips TEXT events when textStreamed flag is set", async () => {
    await channel.connect();

    const runId = "run-send-skip-text";
    const { writer, capturedEvents } = makeMockSseWriter();
    const ac = new AbortController();
    store.register(runId, writer, ac.signal);
    store.markTextStreamed(runId); // simulate middleware already streamed

    await channel.send({
      content: [{ kind: "text", text: "already streamed" }],
      metadata: { runId },
    });

    const types = capturedEvents().map((e) => e.type);

    // No TEXT events — middleware already handled them.
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  test("send() emits STATE_DELTA for koi:state custom block", async () => {
    await channel.connect();

    const runId = "run-send-state";
    const { writer, capturedEvents } = makeMockSseWriter();
    const ac = new AbortController();
    store.register(runId, writer, ac.signal);

    await channel.send({
      content: [{ kind: "custom", type: "koi:state", data: { count: 7 } }],
      metadata: { runId },
    });

    const types = capturedEvents().map((e) => e.type);

    expect(types).toContain(EventType.STATE_DELTA);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  test("send() without runId in metadata drops message silently", async () => {
    await channel.connect();

    // Should not throw — just logs a warning and returns.
    await expect(
      channel.send({ content: [{ kind: "text", text: "orphan" }], metadata: {} }),
    ).resolves.toBeUndefined();
  });

  test("send() when writer is gone (already disconnected run) returns silently", async () => {
    await channel.connect();

    // Do NOT register anything in the store — simulates a disconnected client.
    await expect(
      channel.send({
        content: [{ kind: "text", text: "ghost" }],
        metadata: { runId: "run-gone" },
      }),
    ).resolves.toBeUndefined();
  });

  test("disconnect() stops the Bun server", async () => {
    await channel.connect();
    await channel.disconnect();

    // Subsequent requests should fail (connection refused).
    await expect(fetch(`${BASE}/agent`)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // P0 Bug #2 regression — dispatch race: setTimeout(0) fired before engine
  // -------------------------------------------------------------------------

  test("onMessage handler receives POST requests", async () => {
    await channel.connect();
    let callCount = 0;
    channel.onMessage(async (_msg) => {
      callCount++;
    });

    const res = await fetch(`${BASE}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeInput("run-onmsg-ch")),
    });
    if (res.body === null) throw new Error("expected non-null body");
    await readSseStream(res.body);

    expect(callCount).toBe(1);
  });

  test("RUN_FINISHED only after onMessage handler completes (dispatch race regression)", async () => {
    await channel.connect();
    const order: string[] = [];

    channel.onMessage(async (_msg) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      order.push("handler");
    });

    const res = await fetch(`${BASE}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeInput("run-race-check")),
    });
    if (res.body === null) throw new Error("expected non-null body");
    const events = await readSseStream(res.body);
    order.push("run-finished");

    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(order).toEqual(["handler", "run-finished"]);
  });

  test("unsubscribed channel.onMessage handler is not called", async () => {
    await channel.connect();
    let callCount = 0;
    const unsub = channel.onMessage(async (_msg) => {
      callCount++;
    });
    unsub();

    const res = await fetch(`${BASE}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeInput("run-unsub-ch")),
    });
    if (res.body === null) throw new Error("expected non-null body");
    await readSseStream(res.body);

    expect(callCount).toBe(0);
  });
});
