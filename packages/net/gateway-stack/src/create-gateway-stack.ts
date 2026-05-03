/**
 * Composes core gateway + canvas + webhook + optional Nexus session store
 * into a single start/stop lifecycle.
 *
 * Nexus HA is fully optional: omit `deps.nexusTransport` and the gateway
 * runs against an in-memory SessionStore — same behavior as plain
 * `createGateway()`. The stack still exposes a uniform `health()` so
 * operators get one endpoint regardless of which subsystems are enabled.
 */

import { createGateway } from "@koi/gateway";
import { createCanvas } from "@koi/gateway-canvas";
import {
  createNexusSessionStore,
  type NexusSessionStoreHandle,
  validateGatewayNexusConfig,
} from "@koi/gateway-nexus";
import { createWebhookServer } from "@koi/gateway-webhook";
import type {
  GatewayStack,
  GatewayStackConfig,
  GatewayStackDeps,
  GatewayStackHealth,
} from "./types.js";

const DEFAULT_WEBHOOK_DISPATCHER: NonNullable<GatewayStackDeps["webhookDispatcher"]> = (
  _session,
  _frame,
) => {
  /* swallow: stack consumer didn't wire a dispatcher */
};

export function createGatewayStack(
  config: GatewayStackConfig,
  deps: GatewayStackDeps,
): GatewayStack {
  if (deps.nexusTransport !== undefined && deps.store !== undefined) {
    // Refuse the ambiguous combination so we never silently pick one and
    // drop the other — both could be persistent stores with different
    // contracts and the caller has to disambiguate explicitly.
    throw new Error(
      "createGatewayStack: deps.store and deps.nexusTransport are mutually exclusive — provide one or the other.",
    );
  }

  const nexus = wireNexus(config, deps);

  // When backed by Nexus the session store is shared/persistent across gateway
  // instances. stop() must NOT delete owned sessions or a SIGTERM/rolling
  // restart would erase the HA records meant to survive for reconnect.
  const gatewayConfig =
    nexus !== undefined
      ? { ...(config.gateway ?? {}), preserveSessionsOnStop: true }
      : (config.gateway ?? {});

  // Prefer nexus.store, then a caller-supplied deps.store (custom persistent
  // backend), then fall back to the in-memory default inside createGateway.
  const storeOverride = nexus !== undefined ? nexus.store : deps.store;

  const gateway = createGateway(gatewayConfig, {
    transport: deps.transport,
    auth: deps.auth,
    ...(storeOverride !== undefined ? { store: storeOverride } : {}),
  });

  const canvas =
    config.canvas !== undefined && deps.canvasAuth !== undefined
      ? createCanvas(config.canvas, deps.canvasAuth)
      : undefined;

  const webhook =
    config.webhook !== undefined
      ? createWebhookServer(
          config.webhook,
          deps.webhookDispatcher ?? DEFAULT_WEBHOOK_DISPATCHER,
          deps.webhookAuth,
          deps.webhookProviderSecrets,
        )
      : undefined;

  async function health(): Promise<GatewayStackHealth> {
    const active = await Promise.resolve(gateway.activeConnections());
    const nexusMode = nexus?.degradation().mode;
    return {
      status: nexusMode === "degraded" ? "degraded" : "ok",
      gateway: { activeConnections: active },
      ...(nexusMode !== undefined ? { nexus: { mode: nexusMode } } : {}),
      components: {
        gateway: true,
        canvas: canvas !== undefined,
        webhook: webhook !== undefined,
        nexus: nexus !== undefined,
      },
    };
  }

  return {
    gateway,
    canvas,
    webhook,
    nexus,
    health,
    healthHandler: async (_req: Request): Promise<Response> => {
      const h = await health();
      return new Response(JSON.stringify(h), {
        status: h.status === "ok" ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    },
    async start(port: number): Promise<void> {
      await gateway.start(port);
      if (canvas !== undefined) await canvas.server.start();
      if (webhook !== undefined) await webhook.start();
    },
    async stop(): Promise<void> {
      canvas?.server.stop();
      webhook?.stop();
      await gateway.stop();
      if (nexus !== undefined) await nexus.dispose();
    },
  };
}

function wireNexus(
  config: GatewayStackConfig,
  deps: GatewayStackDeps,
): NexusSessionStoreHandle | undefined {
  if (deps.nexusTransport === undefined) return undefined;
  const cfg = config.nexus ?? {};
  const v = validateGatewayNexusConfig(cfg);
  if (!v.ok) {
    throw new Error(`Invalid gateway-nexus config: ${v.error.message}`, { cause: v.error });
  }
  return createNexusSessionStore({ transport: deps.nexusTransport, config: cfg });
}
