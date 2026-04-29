import type { RateLimitStore } from "./rate-limit.js";
import type { GatewayHttpConfig } from "./types.js";

export interface WsGate {
  /** Try to admit a WS upgrade. Returns either an upgrade token (caller proceeds to server.upgrade()) or a Response to return immediately. */
  readonly tryAdmit: (
    sourceAddr: string,
  ) =>
    | { readonly ok: true; readonly token: symbol }
    | { readonly ok: false; readonly response: Response };

  /** Caller must call this after server.upgrade() succeeds, OR if it fails. */
  readonly onUpgradeComplete: (token: symbol, success: boolean) => void;

  /** Caller must call this when a WS connection closes (success or otherwise). */
  readonly onConnectionClose: () => void;

  /** Used by tests/diagnostics. */
  readonly pendingCount: () => number;
  readonly connectionCount: () => number;
}

export interface WsGateDeps {
  readonly config: GatewayHttpConfig;
  readonly rateLimits: RateLimitStore;
  readonly clock: () => number;
}

function rateLimitedResponse(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new Response("rate limited", {
    status: 429,
    headers: { "Retry-After": String(seconds) },
  });
}

function capacityResponse(reason: string): Response {
  return new Response(reason, {
    status: 503,
    headers: { "Retry-After": "1" },
  });
}

export function createWsGate(deps: WsGateDeps): WsGate {
  const { config, rateLimits } = deps;
  // `let` justified: counters mutate as upgrades flow through the gate.
  let pendingUpgrades = 0;
  let activeConnections = 0;
  const liveTokens = new Set<symbol>();

  function tryAdmit(
    sourceAddr: string,
  ):
    | { readonly ok: true; readonly token: symbol }
    | { readonly ok: false; readonly response: Response } {
    if (config.sourceLimit !== "disabled-acknowledged") {
      const r = rateLimits.consumeSource(sourceAddr, config.sourceLimit);
      if (!r.allowed) {
        return { ok: false, response: rateLimitedResponse(r.retryAfterMs) };
      }
    }

    if (pendingUpgrades >= config.maxPendingUpgrades) {
      return { ok: false, response: capacityResponse("ws upgrade cap exceeded") };
    }

    if (activeConnections >= config.maxWsConnections) {
      return { ok: false, response: capacityResponse("ws connection cap exceeded") };
    }

    const token = Symbol("ws-upgrade");
    liveTokens.add(token);
    pendingUpgrades += 1;
    return { ok: true, token };
  }

  function onUpgradeComplete(token: symbol, success: boolean): void {
    if (!liveTokens.has(token)) return;
    liveTokens.delete(token);
    pendingUpgrades -= 1;
    if (success) activeConnections += 1;
  }

  function onConnectionClose(): void {
    if (activeConnections > 0) activeConnections -= 1;
  }

  return {
    tryAdmit,
    onUpgradeComplete,
    onConnectionClose,
    pendingCount: () => pendingUpgrades,
    connectionCount: () => activeConnections,
  };
}
