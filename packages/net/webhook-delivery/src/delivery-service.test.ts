import { describe, expect, mock, test } from "bun:test";
import type {
  EventBackend,
  EventEnvelope,
  OutboundWebhookConfig,
  SubscribeOptions,
} from "@koi/core";
import type { WebhookDeliveryConfig } from "./config.js";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG } from "./config.js";
import type { DnsResolver } from "./deliver.js";
import { createWebhookDeliveryService } from "./delivery-service.js";

/** No-op DNS resolver that always returns a safe public IP (avoids real DNS in tests). */
const noopResolver: DnsResolver = async () => ({ address: "93.184.216.34" });

function makeWebhook(overrides?: Partial<OutboundWebhookConfig>): OutboundWebhookConfig {
  return {
    url: "https://hooks.example.com/events",
    events: ["session.started", "session.ended"],
    secret: "test-secret",
    ...overrides,
  };
}

/** Minimal fast config for tests — no real delays. */
const FAST_CONFIG: WebhookDeliveryConfig = {
  ...DEFAULT_WEBHOOK_DELIVERY_CONFIG,
  maxRetries: 2,
  retryConfig: {
    ...DEFAULT_WEBHOOK_DELIVERY_CONFIG.retryConfig,
    maxRetries: 2,
    initialDelayMs: 1,
    maxBackoffMs: 5,
    jitter: false,
  },
  circuitBreakerConfig: {
    failureThreshold: 3,
    cooldownMs: 100,
    failureWindowMs: 1000,
    failureStatusCodes: [429, 500, 502, 503, 504],
  },
};

type SubscribeHandler = (event: EventEnvelope) => void | Promise<void>;

function makeEventBackend(): EventBackend & {
  readonly handlers: Map<string, SubscribeHandler>;
  readonly emit: (streamId: string, event: Partial<EventEnvelope>) => void;
} {
  const handlers = new Map<string, SubscribeHandler>();

  const backend: EventBackend & {
    readonly handlers: Map<string, SubscribeHandler>;
    readonly emit: (streamId: string, event: Partial<EventEnvelope>) => void;
  } = {
    handlers,
    emit(streamId: string, event: Partial<EventEnvelope>) {
      const handler = handlers.get(streamId);
      if (handler !== undefined) {
        const envelope: EventEnvelope = {
          id: "evt_1",
          streamId,
          type: event.type ?? "unknown",
          timestamp: event.timestamp ?? Date.now(),
          sequence: event.sequence ?? 1,
          data: event.data ?? {},
        };
        void handler(envelope);
      }
    },
    append: mock(() => ({
      ok: true as const,
      value: {
        id: "evt_1",
        streamId: "test",
        type: "test",
        timestamp: Date.now(),
        sequence: 1,
        data: {},
      },
    })),
    read: mock(() => ({ ok: true as const, value: { events: [], hasMore: false } })),
    subscribe(options: SubscribeOptions) {
      handlers.set(options.streamId, options.handler);
      return {
        subscriptionName: options.subscriptionName,
        streamId: options.streamId,
        unsubscribe: () => handlers.delete(options.streamId),
        position: () => 0,
      };
    },
    queryDeadLetters: mock(() => ({ ok: true as const, value: [] })),
    retryDeadLetter: mock(() => ({ ok: true as const, value: true })),
    purgeDeadLetters: mock(() => ({ ok: true as const, value: undefined })),
    streamLength: mock(() => 0),
    firstSequence: mock(() => 0),
    close: mock(() => {}),
  };

  return backend;
}

function mockFetch(status: number): typeof fetch {
  return (async () => new Response("", { status })) as unknown as typeof fetch;
}

describe("createWebhookDeliveryService", () => {
  test("starts and subscribes to correct stream", async () => {
    const backend = makeEventBackend();
    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook()],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher: mockFetch(200),
      dnsResolver: noopResolver,
    });

    await service.start();

    expect(backend.handlers.has("webhook:agent-1")).toBe(true);

    service.dispose();
  });

  test("skips start when no active webhooks", async () => {
    const backend = makeEventBackend();
    const logs: string[] = [];
    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ enabled: false })],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher: mockFetch(200),
      logger: { warn: () => {}, info: (msg) => logs.push(msg) },
    });

    await service.start();

    expect(logs.some((l) => l.includes("No active webhooks"))).toBe(true);
    expect(backend.handlers.size).toBe(0);

    service.dispose();
  });

  test("delivers matching events to webhook endpoint", async () => {
    const backend = makeEventBackend();
    const fetchCalls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ events: ["session.started"] })],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher,
      dnsResolver: noopResolver,
    });

    await service.start();

    // Emit a matching event
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toBe("https://hooks.example.com/events");

    service.dispose();
  });

  test("does not deliver non-matching events", async () => {
    const backend = makeEventBackend();
    const fetchCalls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ events: ["tool.failed"] })],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher,
      dnsResolver: noopResolver,
    });

    await service.start();

    // Emit a non-matching event
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);

    service.dispose();
  });

  test("fans out to multiple webhook endpoints", async () => {
    const backend = makeEventBackend();
    const fetchCalls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [
        makeWebhook({ url: "https://hook-a.com/events", events: ["session.started"] }),
        makeWebhook({ url: "https://hook-b.com/events", events: ["session.started"] }),
      ],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher,
      dnsResolver: noopResolver,
    });

    await service.start();

    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls).toContain("https://hook-a.com/events");
    expect(fetchCalls).toContain("https://hook-b.com/events");

    service.dispose();
  });

  test("410 Gone is treated as permanent failure (no retry)", async () => {
    const backend = makeEventBackend();
    let callCount = 0;
    const fetcher = (async () => {
      callCount++;
      return new Response("", { status: 410 });
    }) as unknown as typeof fetch;

    const warnings: string[] = [];
    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ events: ["session.started"] })],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher,
      logger: { warn: (msg) => warnings.push(msg), info: () => {} },
      dnsResolver: noopResolver,
    });

    await service.start();

    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 100));

    // Should only try once — no retry for 410
    expect(callCount).toBe(1);
    expect(warnings.some((w) => w.includes("410 Gone"))).toBe(true);

    service.dispose();
  });

  test("dispose clears timers and unsubscribes", async () => {
    const backend = makeEventBackend();
    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook()],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher: mockFetch(500), // always fail → triggers retry timers
      dnsResolver: noopResolver,
    });

    await service.start();

    // Trigger events to create retry timers
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 20));

    // Dispose should clean up
    service.dispose();

    // Stream handler should be removed
    expect(backend.handlers.has("webhook:agent-1")).toBe(false);
  });

  test("signs with current time, not event timestamp (regression)", async () => {
    const backend = makeEventBackend();
    let capturedTimestamp = 0;
    const fetcher = (async (_url: string | URL | Request, init: RequestInit | undefined) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedTimestamp = Number(headers?.["webhook-timestamp"] ?? "0");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    // Clock returns a fixed "now" far from the event timestamp
    const clockNow = Math.floor(Date.now() / 1_000) * 1_000;
    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ events: ["session.started"] })],
      agentId: "agent-1",
      config: FAST_CONFIG,
      fetcher,
      clock: () => clockNow,
      dnsResolver: noopResolver,
    });

    await service.start();

    // Emit an event with a timestamp 10 minutes in the past
    const staleTimestamp = clockNow - 600_000;
    backend.emit("webhook:agent-1", {
      type: "session.started",
      timestamp: staleTimestamp,
      data: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    // Signature timestamp should match clock(), not event timestamp
    const expectedTimestampSeconds = Math.floor(clockNow / 1_000);
    expect(capturedTimestamp).toBe(expectedTimestampSeconds);

    service.dispose();
  });

  test("circuit breaker blocks after repeated failures", async () => {
    const backend = makeEventBackend();
    let callCount = 0;
    const fetcher = (async () => {
      callCount++;
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const service = createWebhookDeliveryService({
      eventBackend: backend,
      webhooks: [makeWebhook({ events: ["session.started"] })],
      agentId: "agent-1",
      config: {
        ...FAST_CONFIG,
        maxRetries: 0, // Don't retry, just fail fast
        circuitBreakerConfig: {
          failureThreshold: 2,
          cooldownMs: 60_000,
          failureWindowMs: 60_000,
          failureStatusCodes: [500],
        },
      },
      fetcher,
      dnsResolver: noopResolver,
    });

    await service.start();

    // Send enough events to trip the circuit breaker
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 20));
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 20));

    const callsAfterTrip = callCount;

    // Third event should be blocked by circuit breaker
    backend.emit("webhook:agent-1", { type: "session.started", data: {} });
    await new Promise((r) => setTimeout(r, 20));

    expect(callCount).toBe(callsAfterTrip);

    service.dispose();
  });
});
