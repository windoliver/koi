import { describe, expect, test } from "bun:test";
import { DEFAULT_GATEWAY_HTTP_CONFIG } from "./defaults.js";
import type { GatewayHttpConfig } from "./types.js";

describe("public types", () => {
  test("DEFAULT_GATEWAY_HTTP_CONFIG has all required fields with the documented defaults", () => {
    const c: GatewayHttpConfig = DEFAULT_GATEWAY_HTTP_CONFIG;
    expect(c.maxBodyBytes).toBe(1_048_576);
    expect(c.maxInFlight).toBe(256);
    expect(c.replayWindowSeconds).toBe(300);
    expect(c.nonceLruSize).toBe(10_000);
    expect(c.idempotencyTtlSeconds).toBe(86_400);
    expect(c.idempotencyLruSize).toBe(5_000);
    expect(c.maxTenantsPerChannel).toBe(10_000);
    expect(c.maxPendingUpgrades).toBe(64);
    expect(c.maxWsConnections).toBe(1024);
    expect(c.shutdownGraceMs).toBe(10_000);
    expect(c.wsHandshakeTimeoutMs).toBe(5_000);
    expect(c.wsIdleTimeoutSec).toBe(120);
    expect(c.cors.allowedOrigins).toEqual([]);
    expect(c.proxyTrust.mode).toBe("none");
    expect(c.sourceLimit).toBe("disabled-acknowledged");
  });
});
