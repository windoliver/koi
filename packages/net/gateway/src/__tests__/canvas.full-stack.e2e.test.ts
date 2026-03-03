/**
 * Canvas full-stack E2E test: createKoi + createPiAdapter + Canvas Server + SSE.
 *
 * Validates the complete canvas rendering pipeline with real LLM calls:
 *   1. Agent generates HTML via the full Koi runtime (createKoi + Pi adapter)
 *   2. Content stored via canvas HTTP REST API (POST/GET/PATCH/DELETE)
 *   3. SSE delivers real-time update/deleted events to subscribers
 *   4. ETag / If-Match CAS prevents stale overwrites
 *   5. Middleware chain is exercised during LLM calls
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/canvas.full-stack.e2e.test.ts
 *
 * Or with .env at repo root:
 *   bun test --env-file=../../.env src/__tests__/canvas.full-stack.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentManifest, EngineEvent, KoiMiddleware, Result } from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { CanvasAuthenticator, CanvasAuthResult, CanvasServer } from "../canvas-routes.js";
import { createCanvasServer } from "../canvas-routes.js";
import type { CanvasSseManager } from "../canvas-sse.js";
import { createCanvasSseManager } from "../canvas-sse.js";
import type { SurfaceStore } from "../canvas-store.js";
import { createInMemorySurfaceStore } from "../canvas-store.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 90_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const PREFIX = "/gateway/canvas";

const MANIFEST: AgentManifest = {
  name: "canvas-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const acceptAllAuth: CanvasAuthenticator = async (
  request: Request,
): Promise<Result<CanvasAuthResult>> => {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return { ok: false, error: { code: "PERMISSION", message: "Unauthorized", retryable: false } };
  }
  return { ok: true, value: { agentId: "e2e-agent" } };
};

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer e2e-token", "Content-Type": "application/json" };
}

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Extract concatenated text from text_delta events. */
function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/** Run a Koi runtime with a prompt and return the text response. */
async function askLlm(prompt: string, systemPrompt?: string): Promise<string> {
  const piAdapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: systemPrompt ?? "You are a helpful assistant that generates HTML content.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const runtime: KoiRuntime = await createKoi({
    manifest: MANIFEST,
    adapter: piAdapter,
    loopDetection: false,
    limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 2_000 },
  });

  const events = await collectEvents(runtime.run({ kind: "text", text: prompt }));
  const text = extractText(events);
  await runtime.dispose();
  return text;
}

interface SseEventParsed {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
}

/**
 * Collect SSE events from a streaming response.
 * Reads chunks from the body, parses SSE wire format, returns parsed events.
 */
async function collectSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs = 5000,
): Promise<readonly SseEventParsed[]> {
  const events: SseEventParsed[] = [];
  if (response.body === null) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // let: accumulates partial SSE data between reads
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
        const val = line.slice(colonIdx + 2);
        event[field] = val;
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
// Tests
// ---------------------------------------------------------------------------

describeE2E("canvas full-stack e2e: createKoi + Pi adapter + Canvas server + SSE", () => {
  // let: assigned in beforeAll, cleaned up in afterAll
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

  // -----------------------------------------------------------------
  // Test 1: LLM generates HTML → stored in canvas → read back
  // -----------------------------------------------------------------

  test(
    "LLM-generated content round-trips through canvas CRUD",
    async () => {
      // 1. Ask LLM to generate HTML via full Koi runtime
      const html = await askLlm(
        "Generate a simple HTML snippet with a <div> containing the text 'Hello from Koi'. " +
          "Return ONLY the HTML, no markdown fences, no explanation.",
      );
      expect(html.length).toBeGreaterThan(0);
      expect(html.toLowerCase()).toContain("hello");

      // 2. POST the LLM-generated content to canvas server
      const createRes = await fetch(`${baseUrl}/llm-surface-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: html }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { ok: boolean; surfaceId: string };
      expect(createBody.ok).toBe(true);
      expect(createBody.surfaceId).toBe("llm-surface-1");

      // 3. Verify ETag was returned
      const etag = createRes.headers.get("ETag");
      expect(etag).toBeTruthy();

      // 4. GET the surface and verify content round-tripped
      const getRes = await fetch(`${baseUrl}/llm-surface-1`);
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        ok: boolean;
        surface: { content: string; surfaceId: string };
      };
      expect(getBody.ok).toBe(true);
      expect(getBody.surface.content).toBe(html);
      expect(getBody.surface.surfaceId).toBe("llm-surface-1");

      // 5. Verify If-None-Match caching works with real content hash
      const cachedRes = await fetch(`${baseUrl}/llm-surface-1`, {
        headers: { "If-None-Match": etag ?? "" },
      });
      expect(cachedRes.status).toBe(304);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 2: SSE delivers real-time events from LLM content updates
  // -----------------------------------------------------------------

  test(
    "SSE delivers update events when LLM content is patched",
    async () => {
      // 1. Create initial surface
      const initialHtml = "<div>Initial content</div>";
      await fetch(`${baseUrl}/sse-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: initialHtml }),
      });

      // 2. Open SSE connection
      const sseRes = await fetch(`${baseUrl}/sse-e2e-1/events`);
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("Content-Type")).toBe("text/event-stream");

      // 3. Ask LLM to generate updated content via full Koi runtime
      const updatedHtml = await askLlm(
        "Generate a simple HTML snippet with a <div> containing 'Updated by Koi Agent'. " +
          "Return ONLY the HTML, no markdown fences, no explanation.",
      );
      expect(updatedHtml.length).toBeGreaterThan(0);

      // 4. PATCH with LLM-generated content
      const patchRes = await fetch(`${baseUrl}/sse-e2e-1`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ content: updatedHtml }),
      });
      expect(patchRes.status).toBe(200);

      // 5. Collect SSE events — should have "updated" event with new content
      const events = await collectSseEvents(sseRes, 2, 3000);
      const updatedEvent = events.find((e) => e.event === "updated");
      expect(updatedEvent).toBeDefined();

      if (updatedEvent?.data !== undefined) {
        const data = JSON.parse(updatedEvent.data) as {
          surfaceId: string;
          content: string;
        };
        expect(data.surfaceId).toBe("sse-e2e-1");
        expect(data.content).toBe(updatedHtml);
      }

      // 6. Verify GET returns updated content
      const getRes = await fetch(`${baseUrl}/sse-e2e-1`);
      const getBody = (await getRes.json()) as { surface: { content: string } };
      expect(getBody.surface.content).toBe(updatedHtml);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 3: CAS prevents stale overwrites with real content hashes
  // -----------------------------------------------------------------

  test(
    "ETag CAS prevents stale overwrites across LLM-generated versions",
    async () => {
      // 1. Create surface with v1 content
      const createRes = await fetch(`${baseUrl}/cas-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<p>Version 1</p>" }),
      });
      const originalEtag = createRes.headers.get("ETag") ?? "";
      expect(originalEtag).toBeTruthy();

      // 2. Ask LLM to generate v2 content
      const v2Html = await askLlm(
        "Generate HTML: <p>Version 2 by LLM</p>. Return ONLY the HTML, nothing else.",
      );

      // 3. PATCH with correct ETag succeeds
      const patch1 = await fetch(`${baseUrl}/cas-e2e-1`, {
        method: "PATCH",
        headers: { ...authHeaders(), "If-Match": originalEtag },
        body: JSON.stringify({ content: v2Html }),
      });
      expect(patch1.status).toBe(200);
      const newEtag = patch1.headers.get("ETag") ?? "";
      expect(newEtag).not.toBe(originalEtag);

      // 4. PATCH with stale ETag fails (412)
      const patch2 = await fetch(`${baseUrl}/cas-e2e-1`, {
        method: "PATCH",
        headers: { ...authHeaders(), "If-Match": originalEtag },
        body: JSON.stringify({ content: "<p>Version 3 - should fail</p>" }),
      });
      expect(patch2.status).toBe(412);

      // 5. PATCH with fresh ETag succeeds
      const patch3 = await fetch(`${baseUrl}/cas-e2e-1`, {
        method: "PATCH",
        headers: { ...authHeaders(), "If-Match": newEtag },
        body: JSON.stringify({ content: "<p>Version 3 - correct</p>" }),
      });
      expect(patch3.status).toBe(200);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 4: Middleware chain exercises during LLM call
  // -----------------------------------------------------------------

  test(
    "Koi middleware chain is exercised during canvas content generation",
    async () => {
      // let: tracks middleware interceptions
      let modelStreamHit = false;

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Return exactly: <div>middleware-test</div>",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const observerMiddleware: KoiMiddleware = {
        name: "e2e:canvas-observer",
        describeCapabilities: () => undefined,
        priority: 500,
        async *wrapModelStream(_ctx, req, next) {
          modelStreamHit = true;
          yield* next(req);
        },
      };

      const runtime = await createKoi({
        manifest: MANIFEST,
        adapter: piAdapter,
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 1_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Generate: <div>middleware-test</div>" }),
      );
      const html = extractText(events);
      await runtime.dispose();

      // Middleware was exercised
      expect(modelStreamHit).toBe(true);
      expect(html.length).toBeGreaterThan(0);

      // Store the middleware-generated content in canvas
      const res = await fetch(`${baseUrl}/middleware-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: html }),
      });
      expect(res.status).toBe(201);

      // Verify it was stored correctly
      const getRes = await fetch(`${baseUrl}/middleware-e2e-1`);
      const body = (await getRes.json()) as { surface: { content: string } };
      expect(body.surface.content).toBe(html);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 5: Full lifecycle with SSE — create → subscribe → update → delete
  // -----------------------------------------------------------------

  test(
    "full lifecycle: LLM create → SSE subscribe → LLM update → delete → SSE closed",
    async () => {
      // 1. LLM generates initial content
      const v1 = await askLlm(
        "Return exactly this HTML: <h1>Canvas E2E v1</h1>. " +
          "No markdown, no explanation, just the HTML tag.",
      );
      expect(v1).toContain("Canvas E2E");

      // 2. Create surface
      const createRes = await fetch(`${baseUrl}/lifecycle-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: v1, metadata: { author: "e2e-agent", version: 1 } }),
      });
      expect(createRes.status).toBe(201);

      // 3. Open SSE
      const sseRes = await fetch(`${baseUrl}/lifecycle-e2e-1/events`);
      expect(sseRes.status).toBe(200);

      // 4. LLM generates updated content
      const v2 = await askLlm(
        "Return exactly this HTML: <h1>Canvas E2E v2</h1>. " +
          "No markdown, no explanation, just the HTML tag.",
      );

      // 5. PATCH with v2
      const patchRes = await fetch(`${baseUrl}/lifecycle-e2e-1`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ content: v2 }),
      });
      expect(patchRes.status).toBe(200);

      // 6. DELETE surface
      const deleteRes = await fetch(`${baseUrl}/lifecycle-e2e-1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer e2e-token" },
      });
      expect(deleteRes.status).toBe(204);

      // 7. Collect SSE events — should have "updated" and "deleted"
      const events = await collectSseEvents(sseRes, 3, 3000);
      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain("updated");
      expect(eventTypes).toContain("deleted");

      // 8. Verify surface is gone
      const goneRes = await fetch(`${baseUrl}/lifecycle-e2e-1`);
      expect(goneRes.status).toBe(404);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 6: Auth boundary — public reads, gated writes
  // -----------------------------------------------------------------

  test(
    "auth boundary: public GET/SSE, 401 on writes without token",
    async () => {
      // Create a surface (with auth)
      await fetch(`${baseUrl}/auth-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<div>public</div>" }),
      });

      // Public GET — no auth required
      const getRes = await fetch(`${baseUrl}/auth-e2e-1`);
      expect(getRes.status).toBe(200);

      // Public SSE — no auth required
      const controller = new AbortController();
      const sseRes = await fetch(`${baseUrl}/auth-e2e-1/events`, {
        signal: controller.signal,
      });
      expect(sseRes.status).toBe(200);
      controller.abort();

      // Write without auth → 401
      const patchRes = await fetch(`${baseUrl}/auth-e2e-1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hacked" }),
      });
      expect(patchRes.status).toBe(401);

      const deleteRes = await fetch(`${baseUrl}/auth-e2e-1`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(401);
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 7: Metadata preserved through LLM content cycle
  // -----------------------------------------------------------------

  test(
    "metadata preserved alongside LLM-generated content",
    async () => {
      const html = await askLlm("Return: <p>metadata test</p>. Just the HTML tag, nothing else.");

      // Create with metadata
      await fetch(`${baseUrl}/meta-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          content: html,
          metadata: {
            author: "e2e-agent",
            generatedBy: "claude-haiku",
            timestamp: Date.now(),
          },
        }),
      });

      // Verify metadata round-trips
      const getRes = await fetch(`${baseUrl}/meta-e2e-1`);
      const body = (await getRes.json()) as {
        surface: {
          content: string;
          metadata: { author: string; generatedBy: string; timestamp: number };
        };
      };
      expect(body.surface.content).toBe(html);
      expect(body.surface.metadata.author).toBe("e2e-agent");
      expect(body.surface.metadata.generatedBy).toBe("claude-haiku");
      expect(typeof body.surface.metadata.timestamp).toBe("number");
    },
    TIMEOUT_MS,
  );

  // -----------------------------------------------------------------
  // Test 8: Multiple surfaces concurrently
  // -----------------------------------------------------------------

  test(
    "multiple surfaces managed concurrently with SSE isolation",
    async () => {
      // Create two surfaces
      await fetch(`${baseUrl}/multi-e2e-1`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<div>Surface A</div>" }),
      });
      await fetch(`${baseUrl}/multi-e2e-2`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<div>Surface B</div>" }),
      });

      // Subscribe to SSE on surface 1 only
      const sseRes = await fetch(`${baseUrl}/multi-e2e-1/events`);
      expect(sseRes.status).toBe(200);

      // Update surface 2 (should NOT appear in surface 1's SSE)
      await fetch(`${baseUrl}/multi-e2e-2`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<div>Surface B updated</div>" }),
      });

      // Update surface 1 (should appear in SSE)
      await fetch(`${baseUrl}/multi-e2e-1`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ content: "<div>Surface A updated</div>" }),
      });

      // Collect SSE — should only have surface 1's update
      const events = await collectSseEvents(sseRes, 1, 2000);
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("updated");
      if (events[0]?.data !== undefined) {
        const data = JSON.parse(events[0].data) as { surfaceId: string };
        expect(data.surfaceId).toBe("multi-e2e-1");
      }
    },
    TIMEOUT_MS,
  );
});
