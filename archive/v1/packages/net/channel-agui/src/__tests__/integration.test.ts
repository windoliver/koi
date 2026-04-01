/**
 * Integration smoke test: real Bun.serve + SSE round-trip.
 *
 * Starts a real HTTP server, sends a POST with RunAgentInput, reads the SSE
 * stream, and verifies the event sequence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { createAguiHandler } from "../agui-channel.js";

// Use a random high port to avoid conflicts with other tests.
const PORT = 19371;

// let requires justification: server handle acquired in beforeAll, released in afterAll
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  const { handler } = createAguiHandler({ path: "/agent" });

  server = Bun.serve({
    port: PORT,
    fetch: async (req) => {
      const result = await handler(req);
      return result ?? new Response("Not Found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${PORT}`;
});

afterAll(() => {
  server.stop(true);
});

describe("AG-UI HTTP SSE integration", () => {
  test("POST /agent streams RUN_STARTED → STATE_SNAPSHOT → RUN_FINISHED", async () => {
    const input = {
      threadId: "thread-integration",
      runId: "run-integration",
      messages: [{ id: "m1", role: "user", content: "integration test message" }],
      tools: [],
      context: [],
    };

    const response = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Collect all SSE events
    const events: unknown[] = [];
    if (response.body === null) throw new Error("expected response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // let requires justification: partial frame buffer across stream chunks
    let buffer = "";

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
            events.push(JSON.parse(trimmed.slice(6)));
          } catch {
            // skip
          }
        }
      }

      const last = events.at(-1);
      if (
        last !== null &&
        typeof last === "object" &&
        "type" in last &&
        (last.type === EventType.RUN_FINISHED || last.type === EventType.RUN_ERROR)
      ) {
        break;
      }
    }

    const types = events.map((e) => (e as { type: string }).type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[1]).toBe(EventType.STATE_SNAPSHOT);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  });

  test("POST /agent with invalid body returns 400", async () => {
    const response = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"invalid": true}',
    });
    expect(response.status).toBe(400);
  });

  test("GET /agent returns 404", async () => {
    const response = await fetch(`${baseUrl}/agent`);
    expect(response.status).toBe(404);
  });

  test("POST /other returns 404", async () => {
    const response = await fetch(`${baseUrl}/other`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});
