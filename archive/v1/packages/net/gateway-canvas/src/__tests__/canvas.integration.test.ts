/**
 * Canvas rendering integration test: full lifecycle via HTTP.
 *
 * Starts a real canvas server, exercises CRUD + SSE live updates,
 * and verifies end-to-end correctness through fetch().
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Result } from "@koi/core";
import type { CanvasAuthenticator, CanvasAuthResult, CanvasServer } from "../canvas-routes.js";
import { createCanvasServer } from "../canvas-routes.js";
import type { CanvasSseManager } from "../canvas-sse.js";
import { createCanvasSseManager } from "../canvas-sse.js";
import type { SurfaceStore } from "../canvas-store.js";
import { createInMemorySurfaceStore } from "../canvas-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREFIX = "/gateway/canvas";

const acceptAllAuth: CanvasAuthenticator = async (
  request: Request,
): Promise<Result<CanvasAuthResult>> => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return { ok: false, error: { code: "PERMISSION", message: "Unauthorized", retryable: false } };
  }
  return { ok: true, value: { agentId: "integration-agent" } };
};

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer integration-token", "Content-Type": "application/json" };
}

interface SseEventParsed {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
}

/**
 * Collect SSE events from a streaming response.
 * Reads chunks from the body, parses SSE wire format, and returns parsed events.
 */
async function collectSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs = 3000,
): Promise<readonly SseEventParsed[]> {
  const events: SseEventParsed[] = [];
  if (response.body === null) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  while (events.length < maxEvents && Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);

    if (done) break;
    if (value === undefined) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const parts = buffer.split("\n\n");
    // Last part is incomplete (no trailing \n\n yet)
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      const event: Record<string, string> = {};
      for (const line of lines) {
        if (line.startsWith(":")) continue; // comment
        const colonIdx = line.indexOf(": ");
        if (colonIdx === -1) continue;
        const field = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 2);
        event[field] = value;
      }
      if (Object.keys(event).length > 0) {
        events.push(event as SseEventParsed);
      }
    }
  }

  reader.cancel();
  return events;
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe("canvas integration", () => {
  let store: SurfaceStore;
  let sse: CanvasSseManager;
  let server: CanvasServer;
  let baseUrl: string;

  beforeAll(async () => {
    store = createInMemorySurfaceStore();
    sse = createCanvasSseManager({ keepAliveIntervalMs: 60_000 });
    server = createCanvasServer({ port: 0, pathPrefix: PREFIX }, store, sse, acceptAllAuth);
    await server.start();
    baseUrl = `http://localhost:${server.port()}${PREFIX}`;
  });

  afterAll(() => {
    server.stop();
    sse.dispose();
  });

  test("full lifecycle: create → SSE subscribe → update → delete", async () => {
    // 1. POST create surface
    const createRes = await fetch(`${baseUrl}/lifecycle-1`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "<div>Hello</div>" }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { ok: boolean; surfaceId: string };
    expect(createBody.ok).toBe(true);
    expect(createBody.surfaceId).toBe("lifecycle-1");

    // 2. Open SSE connection
    const sseRes = await fetch(`${baseUrl}/lifecycle-1/events`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("Content-Type")).toBe("text/event-stream");

    // 3. PATCH update surface
    const patchRes = await fetch(`${baseUrl}/lifecycle-1`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ content: "<div>Updated</div>" }),
    });
    expect(patchRes.status).toBe(200);
    const newEtag = patchRes.headers.get("ETag");
    expect(newEtag).toBeTruthy();

    // 4. Verify GET returns updated content
    const getRes = await fetch(`${baseUrl}/lifecycle-1`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { surface: { content: string } };
    expect(getBody.surface.content).toBe("<div>Updated</div>");

    // 5. Collect SSE events (should have "updated" event)
    const events = await collectSseEvents(sseRes, 2, 1000);
    const updatedEvent = events.find((e) => e.event === "updated");
    expect(updatedEvent).toBeDefined();
    if (updatedEvent?.data !== undefined) {
      const data = JSON.parse(updatedEvent.data) as { surfaceId: string; content: string };
      expect(data.surfaceId).toBe("lifecycle-1");
      expect(data.content).toBe("<div>Updated</div>");
    }
  });

  test("delete surface triggers SSE deleted event", async () => {
    // Setup: create surface + open SSE
    await fetch(`${baseUrl}/delete-sse-1`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "to-be-deleted" }),
    });

    const sseRes = await fetch(`${baseUrl}/delete-sse-1/events`);
    expect(sseRes.status).toBe(200);

    // Delete the surface
    const delRes = await fetch(`${baseUrl}/delete-sse-1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer integration-token" },
    });
    expect(delRes.status).toBe(204);

    // Collect SSE events — should have "deleted" event
    const events = await collectSseEvents(sseRes, 1, 1000);
    const deletedEvent = events.find((e) => e.event === "deleted");
    expect(deletedEvent).toBeDefined();
  });

  test("SSE subscribe to nonexistent surface → 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent/events`);
    expect(res.status).toBe(404);
  });

  test("ETag caching: If-None-Match returns 304", async () => {
    await fetch(`${baseUrl}/etag-test`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "cached" }),
    });

    // Get the ETag
    const getRes = await fetch(`${baseUrl}/etag-test`);
    const etag = getRes.headers.get("ETag") ?? "";
    await getRes.text(); // consume body

    // Request with matching ETag
    const cachedRes = await fetch(`${baseUrl}/etag-test`, {
      headers: { "If-None-Match": etag },
    });
    expect(cachedRes.status).toBe(304);
  });

  test("CAS update: If-Match prevents stale overwrites", async () => {
    const createRes = await fetch(`${baseUrl}/cas-test`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "v1" }),
    });
    const originalEtag = createRes.headers.get("ETag") ?? "";

    // First update succeeds with correct ETag
    const patch1 = await fetch(`${baseUrl}/cas-test`, {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": originalEtag },
      body: JSON.stringify({ content: "v2" }),
    });
    expect(patch1.status).toBe(200);

    // Second update with stale ETag fails
    const patch2 = await fetch(`${baseUrl}/cas-test`, {
      method: "PATCH",
      headers: { ...authHeaders(), "If-Match": originalEtag },
      body: JSON.stringify({ content: "v3" }),
    });
    expect(patch2.status).toBe(412);
  });
});
