/**
 * Shared test helpers for @koi/webhook-provider tests.
 */

import type {
  Agent,
  SubsystemToken,
  WebhookComponent,
  WebhookEndpointHealth,
  WebhookSummary,
} from "@koi/core";
import { agentId } from "@koi/core";

export function createMockAgent(id = "test-agent"): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id: agentId(id), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: id,
      version: "0.0.0",
      model: { name: "test-model" },
    },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

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
