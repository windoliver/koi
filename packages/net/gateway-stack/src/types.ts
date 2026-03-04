/**
 * Gateway stack types — config and return types for the full gateway bundle.
 */

import type { Gateway, GatewayDeps } from "@koi/gateway";
import type { CanvasAuthenticator, CanvasConfig, CanvasWiring } from "@koi/gateway-canvas";
import type { GatewayNexusConfig } from "@koi/gateway-nexus";
import type { GatewayConfig } from "@koi/gateway-types";
import type { WebhookAuthenticator, WebhookConfig, WebhookServer } from "@koi/gateway-webhook";

/**
 * Full gateway stack configuration — core gateway + optional canvas and webhook.
 */
export interface GatewayStackConfig {
  /** Core gateway config overrides. */
  readonly gateway?: Partial<GatewayConfig>;
  /** Canvas config. Omit to disable canvas. */
  readonly canvas?: CanvasConfig;
  /** Webhook config. Omit to disable webhook. */
  readonly webhook?: WebhookConfig;
  /** Nexus config for HA state stores. Omit to use in-memory stores. */
  readonly nexus?: GatewayNexusConfig;
}

/**
 * Full gateway stack dependencies — core deps + optional subsystem authenticators.
 */
export interface GatewayStackDeps extends GatewayDeps {
  readonly webhookAuth?: WebhookAuthenticator;
  readonly canvasAuth?: CanvasAuthenticator;
}

/**
 * Full gateway stack — core gateway + optional canvas wiring + optional webhook server.
 */
export interface GatewayStack {
  readonly gateway: Gateway;
  readonly canvas: CanvasWiring | undefined;
  readonly webhook: WebhookServer | undefined;
  /** Start all configured subsystems. */
  readonly start: (port: number) => Promise<void>;
  /** Stop all subsystems. */
  readonly stop: () => Promise<void>;
}
