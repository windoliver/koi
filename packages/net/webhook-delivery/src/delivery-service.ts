/**
 * Webhook delivery service — subscribes to EventBackend and delivers to endpoints.
 *
 * Core loop: subscribe → filter → serialize → sign → fan-out → retry → dead-letter.
 */

import type {
  EventBackend,
  EventEnvelope,
  OutboundWebhookConfig,
  WebhookDeliveryStatus,
  WebhookEndpointHealth,
  WebhookEventKind,
  WebhookPayload,
} from "@koi/core";
import { type CircuitBreaker, computeBackoff, createCircuitBreaker } from "@koi/errors";
import { generateUlid } from "@koi/hash";
import type { WebhookDeliveryConfig } from "./config.js";
import { DEFAULT_WEBHOOK_DELIVERY_CONFIG } from "./config.js";
import type { DnsResolver } from "./deliver.js";
import { deliverWebhook } from "./deliver.js";
import { createSemaphore } from "./semaphore.js";
import { createSignatureHeaders } from "./signing.js";

/** All valid webhook event kinds for filtering. */
const VALID_EVENT_KINDS: ReadonlySet<string> = new Set<WebhookEventKind>([
  "session.started",
  "session.ended",
  "tool.failed",
  "tool.succeeded",
  "budget.warning",
  "budget.exhausted",
  "security.violation",
]);

export interface WebhookDeliveryServiceDeps {
  readonly eventBackend: EventBackend;
  readonly webhooks: readonly OutboundWebhookConfig[];
  readonly agentId: string;
  readonly config?: WebhookDeliveryConfig | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly logger?: WebhookDeliveryServiceLogger | undefined;
  /** DNS resolver for SSRF checks (injectable for testing). */
  readonly dnsResolver?: DnsResolver | undefined;
}

export interface WebhookDeliveryServiceLogger {
  readonly warn: (msg: string) => void;
  readonly info: (msg: string) => void;
}

export interface WebhookDeliveryService {
  readonly start: () => Promise<void>;
  readonly dispose: () => void;
  readonly health: () => readonly WebhookEndpointHealth[];
}

/**
 * Creates a webhook delivery service that subscribes to an EventBackend stream
 * and delivers matching events to registered webhook endpoints.
 */
export function createWebhookDeliveryService(
  deps: WebhookDeliveryServiceDeps,
): WebhookDeliveryService {
  const config = deps.config ?? DEFAULT_WEBHOOK_DELIVERY_CONFIG;
  const clock = deps.clock ?? Date.now;
  const fetcher = deps.fetcher ?? fetch;
  const logger = deps.logger;
  const dnsResolver = deps.dnsResolver;

  // Filter to only enabled webhooks
  const activeWebhooks = deps.webhooks.filter((w) => w.enabled !== false);

  // Per-endpoint circuit breakers
  const circuitBreakers = new Map<string, CircuitBreaker>();
  for (const webhook of activeWebhooks) {
    circuitBreakers.set(webhook.url, createCircuitBreaker(config.circuitBreakerConfig, clock));
  }

  // Bounded concurrency
  const semaphore = createSemaphore(config.maxConcurrentDeliveries);

  // Track active retry timers for cleanup
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  // Track subscription for cleanup
  let unsubscribe: (() => void) | undefined;

  function getCircuitBreaker(url: string): CircuitBreaker {
    let cb = circuitBreakers.get(url);
    if (cb === undefined) {
      cb = createCircuitBreaker(config.circuitBreakerConfig, clock);
      circuitBreakers.set(url, cb);
    }
    return cb;
  }

  /** Persist a terminal delivery failure to an auditable event stream. */
  function recordDeadLetter(
    webhook: OutboundWebhookConfig,
    envelope: EventEnvelope,
    errorMessage: string,
    attempts: number,
  ): void {
    deps.eventBackend.append(`dlq:webhook:${deps.agentId}`, {
      type: "webhook.dead_letter",
      data: {
        id: generateUlid(),
        webhookUrl: webhook.url,
        event: envelope,
        error: errorMessage,
        attempts,
        deadLetteredAt: Date.now(),
      } satisfies {
        readonly id: string;
        readonly webhookUrl: string;
        readonly event: EventEnvelope;
        readonly error: string;
        readonly attempts: number;
        readonly deadLetteredAt: number;
      },
    });
  }

  /**
   * Delivers a single webhook with retry logic.
   */
  async function deliverWithRetry(
    webhook: OutboundWebhookConfig,
    payload: WebhookPayload,
    body: string,
    envelope: EventEnvelope,
    attempt: number = 0,
  ): Promise<void> {
    const cb = getCircuitBreaker(webhook.url);

    if (!cb.isAllowed()) {
      logger?.warn(`Circuit breaker OPEN for ${webhook.url}, skipping delivery`);
      return;
    }

    const timestampSeconds = Math.floor(clock() / 1_000);
    const headers = createSignatureHeaders(
      payload.webhookId,
      timestampSeconds,
      body,
      webhook.secret,
    );

    await semaphore.acquire();
    let result: WebhookDeliveryStatus;
    try {
      result = await deliverWebhook(
        webhook.url,
        body,
        { ...headers },
        {
          timeoutMs: config.requestTimeoutMs,
          maxResponseBodyBytes: config.maxResponseBodyBytes,
          dnsResolver,
        },
        fetcher,
      );
    } finally {
      semaphore.release();
    }

    if (result.ok) {
      cb.recordSuccess();
      lastDeliveryTimes.set(webhook.url, clock());
      logger?.info(`Webhook delivered to ${webhook.url} (${result.latencyMs}ms)`);
      return;
    }

    // 410 Gone — permanent failure, no retry
    if (result.statusCode === 410) {
      lastErrors.set(webhook.url, "410 Gone — permanent failure");
      logger?.warn(`Webhook endpoint ${webhook.url} returned 410 Gone — permanent failure`);
      recordDeadLetter(webhook, envelope, "410 Gone — permanent failure", attempt + 1);
      return;
    }

    cb.recordFailure(result.statusCode);
    lastErrors.set(webhook.url, result.error);

    if (attempt >= config.maxRetries) {
      logger?.warn(
        `Webhook delivery to ${webhook.url} failed after ${config.maxRetries} retries: ${result.error}`,
      );
      recordDeadLetter(webhook, envelope, result.error, attempt + 1);
      return;
    }

    // Schedule retry with backoff
    const delay = computeBackoff(attempt, config.retryConfig);
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      void deliverWithRetry(webhook, payload, body, envelope, attempt + 1).catch((err: unknown) => {
        logger?.warn(`Webhook retry failed: ${String(err)}`);
      });
    }, delay);
    activeTimers.add(timer);
  }

  /**
   * Handles a single event from the EventBackend subscription.
   */
  function handleEvent(event: EventEnvelope): void {
    const eventKind = event.type;

    // Only process known webhook event kinds
    if (!VALID_EVENT_KINDS.has(eventKind)) {
      return;
    }

    // Build payload once (Decision #16: serialize once)
    const payload: WebhookPayload = {
      kind: eventKind as WebhookEventKind,
      webhookId: generateUlid(),
      agentId: deps.agentId,
      timestamp: event.timestamp,
      data: event.data,
    };
    const body = JSON.stringify(payload);

    // Fan out to matching webhooks
    for (const webhook of activeWebhooks) {
      if (!webhook.events.includes(eventKind as WebhookEventKind)) {
        continue;
      }

      void deliverWithRetry(webhook, payload, body, event).catch((err: unknown) => {
        logger?.warn(`Webhook delivery error: ${String(err)}`);
      });
    }
  }

  // Per-endpoint last successful delivery tracking
  const lastDeliveryTimes = new Map<string, number>();
  // Per-endpoint last error tracking
  const lastErrors = new Map<string, string>();

  return {
    health(): readonly WebhookEndpointHealth[] {
      return activeWebhooks.map((webhook): WebhookEndpointHealth => {
        const cb = circuitBreakers.get(webhook.url);
        const snapshot = cb?.getSnapshot();
        const isOpen = snapshot?.state === "OPEN";
        return {
          url: webhook.url,
          ok: snapshot?.state === "CLOSED",
          consecutiveFailures: snapshot?.failureCount ?? 0,
          circuitBreakerOpen: isOpen,
          lastDeliveryAt: lastDeliveryTimes.get(webhook.url),
          lastError: lastErrors.get(webhook.url),
        };
      });
    },

    async start(): Promise<void> {
      if (activeWebhooks.length === 0) {
        logger?.info("No active webhooks configured, skipping delivery service");
        return;
      }

      const streamId = `webhook:${deps.agentId}`;
      const handle = await deps.eventBackend.subscribe({
        streamId,
        subscriptionName: `webhook-delivery:${deps.agentId}`,
        handler: handleEvent,
      });
      unsubscribe = handle.unsubscribe;

      logger?.info(
        `Webhook delivery service started for ${activeWebhooks.length} endpoint(s) on stream ${streamId}`,
      );
    },

    dispose(): void {
      unsubscribe?.();
      for (const timer of activeTimers) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    },
  };
}
