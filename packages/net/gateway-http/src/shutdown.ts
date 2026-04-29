/**
 * Shutdown orchestrator for gateway-http.
 *
 * Coordinates graceful drain across HTTP in-flight requests and WS
 * connections. Calls `pauseIngress()` immediately so external WS frames are
 * silenced, but `gateway.ingest()` from admitted HTTP requests still works.
 * Falls back to `forceClose()` once the shared grace budget expires.
 *
 * See `docs/superpowers/specs/2026-04-29-gateway-http-1639-design.md`,
 * "Graceful Shutdown" for the canonical 7-step ordering.
 */

import type { Gateway } from "@koi/gateway-types";

export type ShutdownState = "running" | "draining-http" | "draining-ws" | "force-closed" | "closed";

export interface ShutdownController {
  readonly state: () => ShutdownState;
  readonly isDraining: () => boolean;
  readonly start: () => Promise<void>;
}

export interface ShutdownDeps {
  readonly gateway: Gateway;
  readonly getInFlight: () => number;
  readonly graceMs: number;
  readonly clock: () => number;
  readonly pollIntervalMs?: number;
  readonly stopListener: (force: boolean) => void;
}

const DEFAULT_POLL_MS = 10;

export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;

  let currentState: ShutdownState = "running";
  let draining = false;
  let inflight: Promise<void> | null = null;

  const remaining = (startedAt: number): number =>
    Math.max(0, deps.graceMs - (deps.clock() - startedAt));

  const waitFor = async (
    counter: () => number | Promise<number>,
    startedAt: number,
  ): Promise<boolean> => {
    while (true) {
      const value = await counter();
      if (value <= 0) return true;
      if (remaining(startedAt) <= 0) return false;
      await sleep(Math.min(pollMs, remaining(startedAt)));
    }
  };

  const finalize = (forced: boolean): void => {
    currentState = forced ? "force-closed" : "closed";
    if (forced) {
      void deps.gateway.forceClose();
    }
    deps.stopListener(true);
  };

  const run = async (): Promise<void> => {
    const startedAt = deps.clock();
    currentState = "draining-http";
    await deps.gateway.pauseIngress();

    const httpDrained = await waitFor(deps.getInFlight, startedAt);
    if (!httpDrained) {
      finalize(true);
      return;
    }

    currentState = "draining-ws";
    const wsDrained = await waitFor(deps.gateway.activeConnections, startedAt);
    finalize(!wsDrained);
  };

  return {
    state: () => currentState,
    isDraining: () => draining,
    start: () => {
      if (inflight !== null) return inflight;
      draining = true;
      inflight = run();
      return inflight;
    },
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
