import {
  type BunTransport,
  createBunTransport,
  type GatewayAuthenticator,
  type Transport,
} from "@koi/gateway";
import { createHttpTransport, type NexusTransport } from "@koi/nexus-client";
import { createGatewayStack } from "./create-gateway-stack.js";
import type { GatewayStack } from "./types.js";

export interface LocalGatewayLauncherConfig {
  readonly port: number;
  readonly hostname?: string;
  readonly nexusUrl?: string;
  readonly nexusApiKey?: string;
  readonly instanceId?: string;
}

export interface GatewayUpStartedEvent {
  readonly kind: "gateway_up_started";
  readonly instanceId: string;
  readonly ws: string;
  readonly health: string;
  readonly nexus: string | null;
}

export interface GatewayUpStoppedEvent {
  readonly kind: "gateway_up_stopped";
  readonly signal: string;
}

export interface LocalGatewayLaunchHandle {
  readonly started: GatewayUpStartedEvent;
  readonly stop: (signal: string) => Promise<GatewayUpStoppedEvent>;
}

export interface LocalGatewayLauncher {
  readonly start: (config: LocalGatewayLauncherConfig) => Promise<LocalGatewayLaunchHandle>;
}

const DEFAULT_HOSTNAME = "127.0.0.1";

const auth: GatewayAuthenticator = {
  authenticate: async (frame) => {
    const clientId = frame.client?.id ?? "default-agent";
    const sessionId = `sess-${Buffer.from(clientId).toString("hex")}`;
    return {
      ok: true,
      sessionId,
      agentId: clientId,
      metadata: { unsafeDevAuth: true },
    };
  },
};

export function createLocalGatewayLauncher(): LocalGatewayLauncher {
  return {
    async start(config) {
      if (config.nexusUrl !== undefined && config.nexusApiKey === undefined) {
        throw new Error("NEXUS_URL set but NEXUS_API_KEY missing");
      }
      if (config.nexusApiKey !== undefined && config.nexusUrl === undefined) {
        throw new Error("NEXUS_API_KEY set but NEXUS_URL missing");
      }

      const hostname = config.hostname ?? DEFAULT_HOSTNAME;
      const instanceId = config.instanceId ?? `gw-${process.pid}`;
      const transport = createBunTransport({ hostname });
      const nexusTransport: NexusTransport | undefined =
        config.nexusUrl !== undefined && config.nexusApiKey !== undefined
          ? createHttpTransport({ url: config.nexusUrl, apiKey: config.nexusApiKey })
          : undefined;

      const stack: GatewayStack = createGatewayStack(
        {
          ...(nexusTransport !== undefined ? { nexus: { instanceId } } : {}),
        },
        {
          transport: transport as Transport,
          auth,
          ...(nexusTransport !== undefined ? { nexusTransport } : {}),
        },
      );

      await stack.start(config.port);

      const healthServer = Bun.serve({
        port: config.port + 1,
        hostname,
        fetch: (req) => stack.healthHandler(req),
      });

      let stopped = false;

      return {
        started: {
          kind: "gateway_up_started",
          instanceId,
          ws: `ws://${hostname}:${resolvePort(transport)}`,
          health: `http://${hostname}:${healthServer.port}/health`,
          nexus: nexusTransport !== undefined ? (config.nexusUrl ?? null) : null,
        },
        async stop(signal) {
          if (stopped) {
            return { kind: "gateway_up_stopped", signal };
          }

          stopped = true;
          healthServer.stop();
          await stack.stop();
          nexusTransport?.close();
          return { kind: "gateway_up_stopped", signal };
        },
      };
    },
  };
}

function resolvePort(transport: BunTransport): number {
  return transport.port();
}
