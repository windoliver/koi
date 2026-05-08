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

      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65534) {
        throw new Error(
          `port must be an integer in [1, 65534] (health server binds to port+1); got ${config.port}`,
        );
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

      let started = false;
      let pendingHealthServer: ReturnType<typeof Bun.serve> | undefined;
      try {
        pendingHealthServer = Bun.serve({
          port: config.port + 1,
          hostname,
          fetch: (req) =>
            started
              ? stack.healthHandler(req)
              : new Response(JSON.stringify({ status: "starting" }), {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
        });
        await stack.start(config.port);
        started = true;
      } catch (err) {
        try {
          await stack.stop();
        } catch {
          // best-effort teardown; preserve original startup error
        }
        try {
          transport.close();
        } catch {
          // ensure listener is released even if stack.stop() failed mid-shutdown
        }
        pendingHealthServer?.stop();
        nexusTransport?.close();
        throw err;
      }
      if (pendingHealthServer === undefined) {
        throw new Error("invariant: health server not initialized after successful startup");
      }
      const healthServer = pendingHealthServer;

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
