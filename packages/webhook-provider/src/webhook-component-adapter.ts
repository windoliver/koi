/**
 * Adapter to create a WebhookComponent from manifest configs + delivery service.
 *
 * Strips secrets from OutboundWebhookConfig to produce WebhookSummary[].
 */

import type {
  OutboundWebhookConfig,
  WebhookComponent,
  WebhookEndpointHealth,
  WebhookSummary,
} from "@koi/core";

/**
 * Creates a WebhookComponent by adapting from manifest webhook configs
 * and a service that provides health data.
 */
export function createWebhookComponentFromService(
  configs: readonly OutboundWebhookConfig[],
  service: {
    readonly health: () =>
      | readonly WebhookEndpointHealth[]
      | Promise<readonly WebhookEndpointHealth[]>;
  },
): WebhookComponent {
  const summaries: readonly WebhookSummary[] = configs.map(
    (c): WebhookSummary => ({
      url: c.url,
      events: c.events,
      description: c.description,
      enabled: c.enabled !== false,
    }),
  );

  return {
    list: () => summaries,
    health: () => service.health(),
  };
}
