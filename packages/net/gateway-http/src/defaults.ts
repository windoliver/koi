import type { GatewayHttpConfig } from "./types.js";

export const DEFAULT_GATEWAY_HTTP_CONFIG: GatewayHttpConfig = {
  bind: "127.0.0.1:8000",
  maxBodyBytes: 1_048_576,
  maxInFlight: 256,
  replayWindowSeconds: 300,
  nonceLruSize: 10_000,
  maxTenantsPerChannel: 10_000,
  idempotencyTtlSeconds: 86_400,
  idempotencyLruSize: 5_000,
  cors: {
    allowedOrigins: [],
    allowedMethods: ["POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAgeSeconds: 600,
  },
  shutdownGraceMs: 10_000,
  proxyTrust: { mode: "none" },
  sourceLimit: "disabled-acknowledged",
  maxPendingUpgrades: 64,
  maxWsConnections: 1024,
  wsHandshakeTimeoutMs: 5_000,
  wsIdleTimeoutSec: 120,
  lockFilePath: "/tmp/koi/gateway-http.lock",
} as const;
