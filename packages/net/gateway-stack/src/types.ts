/**
 * Public types for the gateway stack — config + dependencies + return shape.
 */

import type { Gateway, GatewayConfig, GatewayDeps } from "@koi/gateway";
import type { CanvasAuthenticator, CanvasConfig, CanvasWiring } from "@koi/gateway-canvas";
import type { GatewayNexusConfig, NexusSessionStoreHandle } from "@koi/gateway-nexus";
import type {
  ProviderSecrets,
  WebhookAuthenticator,
  WebhookConfig,
  WebhookDispatcher,
  WebhookServer,
} from "@koi/gateway-webhook";
import type { NexusTransport } from "@koi/nexus-client";

export interface GatewayStackConfig {
  /** Core gateway config overrides. */
  readonly gateway?: Partial<GatewayConfig> | undefined;
  /** Canvas config. Omit to disable canvas. */
  readonly canvas?: CanvasConfig | undefined;
  /** Webhook config. Omit to disable webhook. */
  readonly webhook?: WebhookConfig | undefined;
  /** Nexus session store config. Omit (or omit `nexusTransport`) for in-memory state. */
  readonly nexus?: GatewayNexusConfig | undefined;
}

export interface GatewayStackDeps extends GatewayDeps {
  readonly canvasAuth?: CanvasAuthenticator | undefined;
  readonly webhookAuth?: WebhookAuthenticator | undefined;
  readonly webhookDispatcher?: WebhookDispatcher | undefined;
  readonly webhookProviderSecrets?: ProviderSecrets | undefined;
  /**
   * Required to enable the Nexus-backed SessionStore. When omitted the stack
   * silently uses the in-memory store even if `config.nexus` is supplied —
   * Nexus HA is genuinely optional per the issue scope.
   */
  readonly nexusTransport?: NexusTransport | undefined;
}

export type GatewayStackHealthStatus = "ok" | "degraded";

export interface GatewayStackHealth {
  readonly status: GatewayStackHealthStatus;
  readonly gateway: { readonly activeConnections: number };
  readonly nexus?: { readonly mode: "healthy" | "degraded" } | undefined;
  readonly components: {
    readonly gateway: boolean;
    readonly canvas: boolean;
    readonly webhook: boolean;
    readonly nexus: boolean;
  };
}

export interface GatewayStack {
  readonly gateway: Gateway;
  readonly canvas: CanvasWiring | undefined;
  readonly webhook: WebhookServer | undefined;
  readonly nexus: NexusSessionStoreHandle | undefined;
  /** Aggregated stack health. Cheap to call; suitable for HTTP health endpoints. */
  readonly health: () => Promise<GatewayStackHealth>;
  /** Drop-in `Request → Response` handler for an HTTP `/health` route. */
  readonly healthHandler: (req: Request) => Promise<Response>;
  /** Start core gateway + every configured subsystem. */
  readonly start: (port: number) => Promise<void>;
  /** Stop every subsystem and dispose nexus state. */
  readonly stop: () => Promise<void>;
}
