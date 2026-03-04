/**
 * Full gateway stack factory — wires core gateway, canvas, and webhook
 * into a single start/stop lifecycle.
 */

import { createGateway } from "@koi/gateway";
import { createCanvas } from "@koi/gateway-canvas";
import { createWebhookServer } from "@koi/gateway-webhook";
import type { GatewayStack, GatewayStackConfig, GatewayStackDeps } from "./types.js";

export function createGatewayStack(
  config: GatewayStackConfig,
  deps: GatewayStackDeps,
): GatewayStack {
  const gateway = createGateway(config.gateway ?? {}, deps);

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
    },
  };
}
