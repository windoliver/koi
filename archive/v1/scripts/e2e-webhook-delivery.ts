#!/usr/bin/env bun

/**
 * E2E test script for @koi/webhook-delivery — validates the full outbound
 * webhook pipeline with a real Anthropic LLM call through createKoi + createPiAdapter.
 *
 * Full stack:
 *   createPiAdapter (real Claude API)
 *     → createKoi (L1 runtime assembly)
 *       → WebhookMiddleware (captures session/tool events → EventBackend)
 *         → InMemoryEventBackend (persists events)
 *           → WebhookDeliveryService (subscribes → signs → delivers)
 *             → Bun.serve mock HTTP server (receives + verifies)
 *
 * Key insight: createKoi generates a random UUID as SessionContext.agentId,
 * so the delivery service must subscribe AFTER learning the real agentId.
 * We use a middleware hook to capture it and start the delivery service
 * before the first turn begins.
 *
 * Validates:
 *   1. Middleware fires onSessionStart/onSessionEnd during real LLM session
 *   2. Events flow through EventBackend to delivery service
 *   3. HTTP POST arrives at mock server with correct headers + payload
 *   4. HMAC-SHA256 signature is valid (Standard Webhooks spec)
 *   5. Multiple webhook endpoints receive fan-out delivery
 *   6. Non-matching event kinds are filtered out
 *   7. Per-endpoint secret isolation (secret A cannot verify signature B)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-webhook-delivery.ts
 *
 * Cost: ~$0.02-0.05 per run (haiku model, minimal prompts).
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import { createInMemoryEventBackend } from "../packages/fs/events-memory/src/memory-backend.js";
import type { EngineEvent } from "../packages/kernel/core/src/engine.js";
import type { EventBackend } from "../packages/kernel/core/src/event-backend.js";
import type { KoiMiddleware, SessionContext } from "../packages/kernel/core/src/middleware.js";
import type { WebhookPayload } from "../packages/kernel/core/src/webhook.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG } from "../packages/net/webhook-delivery/src/config.js";
import type { WebhookDeliveryService } from "../packages/net/webhook-delivery/src/delivery-service.js";
import { createWebhookDeliveryService } from "../packages/net/webhook-delivery/src/delivery-service.js";
import { createWebhookMiddleware } from "../packages/net/webhook-delivery/src/middleware.js";
import { verifySignature } from "../packages/net/webhook-delivery/src/signing.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting webhook-delivery E2E tests...");
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
}

const results: TestResult[] = []; // let justified: test accumulator

function assert(name: string, condition: boolean): void {
  results.push({ name, passed: condition });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Mock HTTP servers — receive webhook deliveries
// ---------------------------------------------------------------------------

interface ReceivedRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const receivedA: ReceivedRequest[] = []; // let justified: test accumulator
const receivedB: ReceivedRequest[] = []; // let justified: test accumulator

const serverA = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    receivedA.push({ method: req.method, headers, body });
    return new Response("OK", { status: 200 });
  },
});

const serverB = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    receivedB.push({ method: req.method, headers, body });
    return new Response("OK", { status: 200 });
  },
});

const urlA = `http://localhost:${serverA.port}/webhook-a`;
const urlB = `http://localhost:${serverB.port}/webhook-b`;
const SECRET_A = "e2e-secret-alpha";
const SECRET_B = "e2e-secret-beta";
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5-20251001";

console.log(`[e2e] Mock server A: ${urlA}`);
console.log(`[e2e] Mock server B: ${urlB}\n`);

// ---------------------------------------------------------------------------
// Fast delivery config (no real delays)
// ---------------------------------------------------------------------------

const FAST_CONFIG = {
  ...DEFAULT_WEBHOOK_DELIVERY_CONFIG,
  maxRetries: 1,
  retryConfig: {
    ...DEFAULT_WEBHOOK_DELIVERY_CONFIG.retryConfig,
    maxRetries: 1,
    initialDelayMs: 1,
    maxBackoffMs: 5,
    jitter: false,
  },
} as const;

// ---------------------------------------------------------------------------
// Test 1 — Full pipeline: Pi agent → webhook middleware → delivery → HTTP
//
// Key: createKoi assigns a random UUID as SessionContext.agentId.
// The webhook middleware writes to stream "webhook:{agentId}".
// So the delivery service must subscribe with that same agentId.
//
// Strategy: use a "delivery-wiring" middleware that captures the agentId
// from onSessionStart and starts the delivery service dynamically.
// ---------------------------------------------------------------------------

console.log(
  "[test 1] Full pipeline: createPiAdapter → createKoi → WebhookMiddleware → EventBackend → DeliveryService → HTTP\n",
);

await withTimeout(
  async () => {
    // 1. Wire up event infrastructure
    const eventBackend: EventBackend = createInMemoryEventBackend();
    const webhookMiddleware = createWebhookMiddleware(eventBackend);

    // 2. Delivery service holder — started dynamically once we learn the agentId
    let deliveryService: WebhookDeliveryService | undefined; // let justified: assigned in middleware
    let resolvedAgentId = ""; // let justified: captured from session context

    // Middleware that wires up the delivery service on session start.
    // Must run at lower priority than webhook middleware (900) so that
    // webhook middleware's onSessionStart fires first (appending the event),
    // then this middleware starts the delivery service to pick it up.
    //
    // Actually: we need the delivery service subscribed BEFORE the event
    // is emitted so it can receive it. So this must run BEFORE the webhook
    // middleware (lower priority number).
    const deliveryWiringMiddleware: KoiMiddleware = {
      name: "e2e-delivery-wiring",
      priority: 50, // Runs before webhook middleware (priority 900)

      async onSessionStart(ctx: SessionContext): Promise<void> {
        resolvedAgentId = ctx.agentId;
        console.log(`  [e2e] Captured agentId from SessionContext: ${resolvedAgentId}`);

        // Start delivery service subscribed to the real agentId stream
        deliveryService = createWebhookDeliveryService({
          eventBackend,
          webhooks: [
            { url: urlA, events: ["session.started", "session.ended"], secret: SECRET_A },
            { url: urlB, events: ["session.started"], secret: SECRET_B },
          ],
          agentId: resolvedAgentId,
          config: FAST_CONFIG,
          logger: {
            warn: (msg) => console.log(`  [delivery:warn] ${msg}`),
            info: (msg) => console.log(`  [delivery:info] ${msg}`),
          },
        });
        await deliveryService.start();
        console.log(`  [e2e] Delivery service started for agentId: ${resolvedAgentId}`);
      },
    };

    // 3. Create real Pi adapter with Anthropic API
    const adapter = createPiAdapter({
      model: PI_MODEL,
      systemPrompt: "You are a concise test agent. Reply in 5 words or fewer.",
      getApiKey: async () => API_KEY,
      thinkingLevel: "off",
    });

    // 4. Wire through createKoi (full L1 runtime assembly)
    const runtime = await createKoi({
      manifest: {
        name: "e2e-webhook-agent",
        version: "0.0.1",
        model: { name: MODEL_NAME },
      },
      adapter,
      middleware: [deliveryWiringMiddleware, webhookMiddleware],
    });

    // 5. Run agent with real LLM call
    try {
      const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

      // Agent completed
      const doneEvent = events.find((e) => e.kind === "done");
      assert("Pi agent completed (done event emitted)", doneEvent !== undefined);
      if (doneEvent?.kind === "done") {
        assert('stopReason is "completed"', doneEvent.output.stopReason === "completed");
      }
    } finally {
      // Wait for async delivery (fire-and-forget emitEvent + delivery service)
      await new Promise((r) => setTimeout(r, 1000));

      deliveryService?.dispose();
      await runtime.dispose?.();
    }
  },
  60_000,
  "Test 1",
);

// ---------------------------------------------------------------------------
// Verify: Server A received session.started + session.ended
// ---------------------------------------------------------------------------

console.log("\n[verify] Server A (session.started + session.ended):");

assert("Server A received >= 1 request", receivedA.length >= 1);

const sessionStartA = receivedA.find((r) => {
  try {
    return (JSON.parse(r.body) as WebhookPayload).kind === "session.started";
  } catch {
    return false;
  }
});

const sessionEndA = receivedA.find((r) => {
  try {
    return (JSON.parse(r.body) as WebhookPayload).kind === "session.ended";
  } catch {
    return false;
  }
});

assert("Server A received session.started", sessionStartA !== undefined);
assert("Server A received session.ended", sessionEndA !== undefined);

if (sessionStartA !== undefined) {
  assert("session.started is POST", sessionStartA.method === "POST");

  // Standard Webhooks headers
  assert("webhook-id header present", (sessionStartA.headers["webhook-id"] ?? "").length > 0);
  assert(
    "webhook-timestamp header present",
    (sessionStartA.headers["webhook-timestamp"] ?? "").length > 0,
  );
  assert(
    "webhook-signature starts with v1,",
    (sessionStartA.headers["webhook-signature"] ?? "").startsWith("v1,"),
  );
  assert(
    "content-type is application/json",
    sessionStartA.headers["content-type"] === "application/json",
  );

  // Payload structure
  const payload = JSON.parse(sessionStartA.body) as WebhookPayload;
  assert("payload.kind is session.started", payload.kind === "session.started");
  assert(
    "payload.webhookId is non-empty string",
    typeof payload.webhookId === "string" && payload.webhookId.length > 0,
  );
  assert(
    "payload.timestamp is positive number",
    typeof payload.timestamp === "number" && payload.timestamp > 0,
  );
  assert("payload.data is object", typeof payload.data === "object" && payload.data !== null);

  // HMAC-SHA256 signature verification
  const webhookId = sessionStartA.headers["webhook-id"] ?? "";
  const timestampSeconds = Number(sessionStartA.headers["webhook-timestamp"]);
  const signature = sessionStartA.headers["webhook-signature"] ?? "";

  const isValid = verifySignature(
    webhookId,
    timestampSeconds,
    sessionStartA.body,
    signature,
    SECRET_A,
    300,
    () => timestampSeconds * 1000,
  );
  assert("HMAC-SHA256 signature verifies with correct secret", isValid);
}

// ---------------------------------------------------------------------------
// Verify: Server B received session.started but NOT session.ended (filtering)
// ---------------------------------------------------------------------------

console.log("\n[verify] Server B (fan-out + event filtering):");

const sessionStartB = receivedB.find((r) => {
  try {
    return (JSON.parse(r.body) as WebhookPayload).kind === "session.started";
  } catch {
    return false;
  }
});

const sessionEndB = receivedB.find((r) => {
  try {
    return (JSON.parse(r.body) as WebhookPayload).kind === "session.ended";
  } catch {
    return false;
  }
});

assert("Server B received session.started (fan-out works)", sessionStartB !== undefined);
assert("Server B did NOT receive session.ended (event filtering works)", sessionEndB === undefined);

if (sessionStartB !== undefined) {
  // Verify Server B's own HMAC signature
  const webhookId = sessionStartB.headers["webhook-id"] ?? "";
  const timestampSeconds = Number(sessionStartB.headers["webhook-timestamp"]);
  const signature = sessionStartB.headers["webhook-signature"] ?? "";

  const isValidB = verifySignature(
    webhookId,
    timestampSeconds,
    sessionStartB.body,
    signature,
    SECRET_B,
    300,
    () => timestampSeconds * 1000,
  );
  assert("Server B signature verifies with its own secret", isValidB);

  // Verify secret isolation: Server A's secret must NOT verify Server B's signature
  const crossValid = verifySignature(
    webhookId,
    timestampSeconds,
    sessionStartB.body,
    signature,
    SECRET_A,
    300,
    () => timestampSeconds * 1000,
  );
  assert("Server A secret does NOT verify Server B signature (secret isolation)", !crossValid);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

serverA.stop();
serverB.stop();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}`);
    }
  }
  process.exit(1);
}

console.log("[e2e] All webhook delivery E2E tests passed!");
