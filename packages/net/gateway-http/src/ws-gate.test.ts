import { describe, expect, test } from "bun:test";
import { DEFAULT_GATEWAY_HTTP_CONFIG } from "./defaults.js";
import { createRateLimitStore } from "./rate-limit.js";
import type { GatewayHttpConfig } from "./types.js";
import { createWsGate } from "./ws-gate.js";

function makeConfig(overrides: Partial<GatewayHttpConfig> = {}): GatewayHttpConfig {
  return { ...DEFAULT_GATEWAY_HTTP_CONFIG, ...overrides };
}

describe("createWsGate", () => {
  test("admits when all caps and limits allow", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    expect(gate.pendingCount()).toBe(1);
    expect(gate.connectionCount()).toBe(0);
  });

  test("source limit rejected returns 429 with Retry-After", () => {
    const cfg = makeConfig({ sourceLimit: { capacity: 1, refillPerSec: 1 } });
    const gate = createWsGate({
      config: cfg,
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    // First admit consumes the only token.
    const r1 = gate.tryAdmit("1.2.3.4");
    expect(r1.ok).toBe(true);
    if (r1.ok) gate.onUpgradeComplete(r1.token, true);

    const r2 = gate.tryAdmit("1.2.3.4");
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.response.status).toBe(429);
      expect(r2.response.headers.get("Retry-After")).not.toBeNull();
    }
  });

  test("source limit disabled-acknowledged bypasses limiter", () => {
    let calls = 0;
    const rateLimits = {
      consumeSource: () => {
        calls++;
        return { allowed: false as const, retryAfterMs: 1000 };
      },
      consumeTenant: () => ({ allowed: true as const }),
    };
    const gate = createWsGate({
      config: makeConfig({ sourceLimit: "disabled-acknowledged" }),
      rateLimits,
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    expect(calls).toBe(0);
  });

  test("pending upgrade cap exceeded returns 503", () => {
    const gate = createWsGate({
      config: makeConfig({ maxPendingUpgrades: 1 }),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r1 = gate.tryAdmit("1.2.3.4");
    expect(r1.ok).toBe(true);
    const r2 = gate.tryAdmit("1.2.3.4");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.response.status).toBe(503);
  });

  test("active connection cap exceeded returns 503", () => {
    const gate = createWsGate({
      config: makeConfig({ maxWsConnections: 1, maxPendingUpgrades: 10 }),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r1 = gate.tryAdmit("1.2.3.4");
    expect(r1.ok).toBe(true);
    if (r1.ok) gate.onUpgradeComplete(r1.token, true);
    expect(gate.connectionCount()).toBe(1);

    const r2 = gate.tryAdmit("5.6.7.8");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.response.status).toBe(503);
  });

  test("onUpgradeComplete success increments connectionCount", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    if (r.ok) gate.onUpgradeComplete(r.token, true);
    expect(gate.connectionCount()).toBe(1);
    expect(gate.pendingCount()).toBe(0);
  });

  test("onUpgradeComplete failure does not increment connectionCount", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    if (r.ok) gate.onUpgradeComplete(r.token, false);
    expect(gate.connectionCount()).toBe(0);
    expect(gate.pendingCount()).toBe(0);
  });

  test("onUpgradeComplete is idempotent for same token", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    if (r.ok) {
      gate.onUpgradeComplete(r.token, true);
      gate.onUpgradeComplete(r.token, true);
      gate.onUpgradeComplete(r.token, false);
    }
    expect(gate.connectionCount()).toBe(1);
    expect(gate.pendingCount()).toBe(0);
  });

  test("onConnectionClose decrements connectionCount", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    const r = gate.tryAdmit("1.2.3.4");
    expect(r.ok).toBe(true);
    if (r.ok) gate.onUpgradeComplete(r.token, true);
    expect(gate.connectionCount()).toBe(1);
    gate.onConnectionClose();
    expect(gate.connectionCount()).toBe(0);
  });

  test("onConnectionClose clamps at 0", () => {
    const gate = createWsGate({
      config: makeConfig(),
      rateLimits: createRateLimitStore(() => 0),
      clock: () => 0,
    });
    gate.onConnectionClose();
    gate.onConnectionClose();
    expect(gate.connectionCount()).toBe(0);
  });
});
