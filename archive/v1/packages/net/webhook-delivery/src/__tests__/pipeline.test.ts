/**
 * Integration test — full pipeline: WebhookMiddleware → EventBackend → DeliveryService → HTTP.
 *
 * Uses a real in-process HTTP server (Bun.serve) to verify end-to-end delivery.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  EventBackend,
  EventEnvelope,
  EventInput,
  KoiError,
  ReadResult,
  Result,
  SubscribeOptions,
  SubscriptionHandle,
} from "@koi/core";
import { runId, sessionId } from "@koi/core";
import type { WebhookDeliveryConfig } from "../config.js";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG } from "../config.js";
import type { DnsResolver } from "../deliver.js";
import { createWebhookDeliveryService } from "../delivery-service.js";

/** No-op DNS resolver — returns a safe public IP so localhost tests bypass SSRF checks. */
const noopResolver: DnsResolver = async () => ({ address: "93.184.216.34" });

import { createWebhookMiddleware } from "../middleware.js";
import { verifySignature } from "../signing.js";

// ── In-memory EventBackend for integration tests ──

type SubscribeHandler = (event: EventEnvelope) => void | Promise<void>;

function createMemoryEventBackend(): EventBackend & {
  readonly handlers: Map<string, SubscribeHandler>;
} {
  const streams = new Map<string, EventEnvelope[]>();
  const handlers = new Map<string, SubscribeHandler>();
  let globalSeq = 0;

  return {
    handlers,

    append(streamId: string, event: EventInput): Result<EventEnvelope, KoiError> {
      globalSeq++;
      const existing = streams.get(streamId) ?? [];
      const envelope: EventEnvelope = {
        id: `evt_${globalSeq}`,
        streamId,
        type: event.type,
        timestamp: Date.now(),
        sequence: existing.length + 1,
        data: event.data,
      };
      streams.set(streamId, [...existing, envelope]);

      // Notify subscriber synchronously
      const handler = handlers.get(streamId);
      if (handler !== undefined) {
        void handler(envelope);
      }

      return { ok: true, value: envelope };
    },

    read(streamId: string): Result<ReadResult, KoiError> {
      const events = streams.get(streamId) ?? [];
      return { ok: true, value: { events, hasMore: false } };
    },

    subscribe(options: SubscribeOptions): SubscriptionHandle {
      handlers.set(options.streamId, options.handler);
      return {
        subscriptionName: options.subscriptionName,
        streamId: options.streamId,
        unsubscribe: () => handlers.delete(options.streamId),
        position: () => 0,
      };
    },

    queryDeadLetters: mock(() => ({ ok: true as const, value: [] as const })),
    retryDeadLetter: mock(() => ({ ok: true as const, value: true })),
    purgeDeadLetters: mock(() => ({ ok: true as const, value: undefined })),
    streamLength: mock(() => 0),
    firstSequence: mock(() => 0),
    close: mock(() => {}),
  };
}

// ── Test setup ──

const WEBHOOK_SECRET = "integration-test-secret";
const AGENT_ID = "integration-agent";

const FAST_CONFIG: WebhookDeliveryConfig = {
  ...DEFAULT_WEBHOOK_DELIVERY_CONFIG,
  maxRetries: 1,
  retryConfig: {
    ...DEFAULT_WEBHOOK_DELIVERY_CONFIG.retryConfig,
    maxRetries: 1,
    initialDelayMs: 1,
    maxBackoffMs: 5,
    jitter: false,
  },
};

interface ReceivedRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;
const received: ReceivedRequest[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0, // Random available port
    async fetch(req) {
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      received.push({ method: req.method, headers, body });
      return new Response("OK", { status: 200 });
    },
  });
  serverUrl = `http://localhost:${server.port}/webhook`;
});

afterAll(() => {
  server.stop();
});

describe("webhook delivery pipeline", () => {
  test("end-to-end: middleware → events → delivery → HTTP with valid signature", async () => {
    // Clear received requests
    received.length = 0;

    // Wire up the full pipeline
    const eventBackend = createMemoryEventBackend();

    // 1. Create middleware that emits events
    const middleware = createWebhookMiddleware(eventBackend);

    // 2. Create delivery service that subscribes and delivers
    const service = createWebhookDeliveryService({
      eventBackend,
      webhooks: [
        {
          url: serverUrl,
          events: ["session.started"],
          secret: WEBHOOK_SECRET,
        },
      ],
      agentId: AGENT_ID,
      config: FAST_CONFIG,
      dnsResolver: noopResolver,
    });

    await service.start();

    // 3. Trigger middleware event
    await middleware.onSessionStart?.({
      agentId: AGENT_ID,
      sessionId: sessionId("sess-integration-001"),
      runId: runId("run-integration-001"),
      metadata: {},
    });

    // Wait for async delivery
    await new Promise((r) => setTimeout(r, 200));

    // 4. Verify HTTP request was received
    expect(received.length).toBeGreaterThanOrEqual(1);

    const req = received[0];
    expect(req).toBeDefined();
    if (req === undefined) throw new Error("No request received");

    expect(req.method).toBe("POST");

    // Verify headers
    expect(req.headers["webhook-id"]).toBeDefined();
    expect(req.headers["webhook-timestamp"]).toBeDefined();
    expect(req.headers["webhook-signature"]).toBeDefined();
    expect(req.headers["content-type"]).toBe("application/json");

    // Verify payload
    const payload = JSON.parse(req.body) as {
      readonly kind: string;
      readonly agentId: string;
      readonly webhookId: string;
      readonly timestamp: number;
    };
    expect(payload.kind).toBe("session.started");
    expect(payload.agentId).toBe(AGENT_ID);
    expect(typeof payload.webhookId).toBe("string");
    expect(typeof payload.timestamp).toBe("number");

    // Verify HMAC signature
    const webhookId = req.headers["webhook-id"] ?? "";
    const timestampSeconds = Number(req.headers["webhook-timestamp"]);
    const signature = req.headers["webhook-signature"] ?? "";

    const isValid = verifySignature(
      webhookId,
      timestampSeconds,
      req.body,
      signature,
      WEBHOOK_SECRET,
      300,
      () => timestampSeconds * 1000, // Use same timestamp for verification
    );
    expect(isValid).toBe(true);

    service.dispose();
  });
});
