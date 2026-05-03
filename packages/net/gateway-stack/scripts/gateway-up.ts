#!/usr/bin/env bun
/**
 * Standalone gateway-stack runner for E2E tmux validation.
 *
 * Boots createGatewayStack with optional Nexus HA, binds the WebSocket
 * gateway + a sibling /health HTTP server on loopback, and prints a
 * machine-friendly "started" line so a tmux harness can wait on readiness.
 *
 * NOT a production entrypoint — uses an unsafe permissive authenticator
 * (any client). Loopback-only by construction.
 *
 * Env:
 *   PORT             gateway WS port            (default 19500)
 *   NEXUS_URL        Nexus base URL             (optional → in-memory)
 *   NEXUS_API_KEY    Nexus API key              (required iff NEXUS_URL)
 *   INSTANCE_ID      gateway instance id        (default: gw-<pid>)
 */

import { createBunTransport, type GatewayAuthenticator, type Transport } from "@koi/gateway";
import { createHttpTransport, type NexusTransport } from "@koi/nexus-client";
import { createGatewayStack, type GatewayStack } from "../src/index.js";

const PORT = Number.parseInt(process.env.PORT ?? "19500", 10);
const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;
const INSTANCE_ID = process.env.INSTANCE_ID ?? `gw-${process.pid}`;
const HOSTNAME = "127.0.0.1";

if (NEXUS_URL !== undefined && NEXUS_API_KEY === undefined) {
  console.error("NEXUS_URL set but NEXUS_API_KEY missing");
  process.exit(1);
}

const auth: GatewayAuthenticator = {
  authenticate: async (frame) => {
    const clientId = frame.client?.id ?? "default-agent";
    // Derive a deterministic sessionId from the client id so reconnects (even
    // against a different gateway instance sharing a Nexus store) land back on
    // the same session record. Production authenticators MUST NOT do this.
    const sessionId = `sess-${Buffer.from(clientId).toString("hex")}`;
    return {
      ok: true,
      sessionId,
      agentId: clientId,
      metadata: { unsafeDevAuth: true },
    };
  },
};

const nexusTransport: NexusTransport | undefined =
  NEXUS_URL !== undefined && NEXUS_API_KEY !== undefined
    ? createHttpTransport({ url: NEXUS_URL, apiKey: NEXUS_API_KEY })
    : undefined;

const stack: GatewayStack = createGatewayStack(
  {
    ...(nexusTransport !== undefined ? { nexus: { instanceId: INSTANCE_ID } } : {}),
  },
  {
    transport: createBunTransport({ hostname: HOSTNAME }) as Transport,
    auth,
    ...(nexusTransport !== undefined ? { nexusTransport } : {}),
  },
);

await stack.start(PORT);

const healthServer = Bun.serve({
  port: PORT + 1,
  hostname: HOSTNAME,
  fetch: (req) => stack.healthHandler(req),
});

console.log(
  JSON.stringify({
    kind: "gateway_up_started",
    instanceId: INSTANCE_ID,
    ws: `ws://${HOSTNAME}:${PORT}`,
    health: `http://${HOSTNAME}:${healthServer.port}/health`,
    nexus: nexusTransport !== undefined ? NEXUS_URL : null,
  }),
);

let stopped = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopped) return;
  stopped = true;
  console.log(JSON.stringify({ kind: "gateway_up_stopping", signal }));
  healthServer.stop();
  await stack.stop();
  console.log(JSON.stringify({ kind: "gateway_up_stopped" }));
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await new Promise<void>(() => {});
