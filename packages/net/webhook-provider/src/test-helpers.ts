/**
 * Shared test helpers for @koi/webhook-provider tests.
 */

import type { WebhookComponent, WebhookEndpointHealth, WebhookSummary } from "@koi/core";

export { createMockAgent } from "@koi/test-utils";

export function createMockWebhookComponent(): WebhookComponent {
  const summaries: readonly WebhookSummary[] = [
    {
      url: "https://example.com/hook1",
      events: ["session.started", "session.ended"],
      description: "Test webhook 1",
      enabled: true,
    },
    {
      url: "https://example.com/hook2",
      events: ["tool.failed"],
      enabled: true,
    },
  ];

  const healthData: readonly WebhookEndpointHealth[] = [
    {
      url: "https://example.com/hook1",
      ok: true,
      consecutiveFailures: 0,
      circuitBreakerOpen: false,
      lastDeliveryAt: 1700000000000,
    },
    {
      url: "https://example.com/hook2",
      ok: false,
      consecutiveFailures: 3,
      circuitBreakerOpen: true,
      lastError: "Connection refused",
    },
  ];

  return {
    list: () => summaries,
    health: () => healthData,
  };
}
