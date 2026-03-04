/**
 * Full gateway stack factory — wires core gateway, canvas, and webhook
 * into a single start/stop lifecycle.
 *
 * When `config.nexus` is provided, uses Nexus-backed session store
 * for HA multi-instance deployment.
 */

import { createGateway } from "@koi/gateway";
import { createCanvas } from "@koi/gateway-canvas";
import type { NexusSessionStoreHandle } from "@koi/gateway-nexus";
import { createNexusSessionStore, validateGatewayNexusConfig } from "@koi/gateway-nexus";
import { createWebhookServer } from "@koi/gateway-webhook";
import { createNexusClient } from "@koi/nexus-client";
import type { GatewayStack, GatewayStackConfig, GatewayStackDeps } from "./types.js";

export function createGatewayStack(
  config: GatewayStackConfig,
  deps: GatewayStackDeps,
): GatewayStack {
  let nexusHandle: NexusSessionStoreHandle | undefined;

  // Wire Nexus-backed session store if configured
  if (config.nexus !== undefined) {
    const validation = validateGatewayNexusConfig(config.nexus);
    if (!validation.ok) {
      throw new Error(`Invalid gateway-nexus config: ${validation.error.message}`);
    }
    const client = createNexusClient({
      baseUrl: config.nexus.nexusUrl,
      apiKey: config.nexus.apiKey,
      fetch: config.nexus.fetch,
    });
    nexusHandle = createNexusSessionStore({
      client,
      config: config.nexus,
    });
  }

  const gateway = createGateway(config.gateway ?? {}, {
    ...deps,
    ...(nexusHandle !== undefined ? { store: nexusHandle.store } : {}),
  });

  const canvas =
    config.canvas !== undefined ? createCanvas(config.canvas, deps.canvasAuth) : undefined;

  const webhook =
    config.webhook !== undefined
      ? createWebhookServer(config.webhook, gateway.dispatch, deps.webhookAuth)
      : undefined;

  return {
    gateway,
    canvas,
    webhook,

    async start(port: number): Promise<void> {
      await gateway.start(port);
      if (canvas !== undefined) {
        await canvas.server.start();
      }
      if (webhook !== undefined) {
        await webhook.start();
      }
    },

    async stop(): Promise<void> {
      canvas?.sse.dispose();
      canvas?.server.stop();
      webhook?.stop();
      await gateway.stop();
      if (nexusHandle !== undefined) {
        await nexusHandle.dispose();
      }
    },
  };
}
