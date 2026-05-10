import type { ComponentProvider, KoiError, KoiMiddleware, Result } from "@koi/core";
import type { SessionLease } from "@koi/long-running";
import { createSpawnFitnessWrapper, createTaskSpawnProvider, type SpawnFn } from "@koi/task-spawn";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

function assertOk(result: Result<void, KoiError>): void {
  if (!result.ok) {
    throw result.error;
  }
}

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  const spawn: SpawnFn | undefined =
    parts.spawn !== undefined && parts.spawnFitness !== undefined
      ? createSpawnFitnessWrapper(parts.spawn, parts.spawnFitness)
      : parts.spawn;

  const middleware = Object.freeze([
    parts.harness.createMiddleware(),
    ...(parts.extraMiddleware ?? []),
  ]) as readonly KoiMiddleware[];

  const providers = Object.freeze(
    spawn !== undefined && parts.agentResolver !== undefined
      ? [
          createTaskSpawnProvider({
            agentResolver: parts.agentResolver,
            spawn,
            ...(parts.defaultAgent !== undefined ? { defaultAgent: parts.defaultAgent } : {}),
            ...(parts.message !== undefined ? { message: parts.message } : {}),
            ...(parts.maxDurationMs !== undefined ? { maxDurationMs: parts.maxDurationMs } : {}),
          }),
        ]
      : [],
  ) as readonly ComponentProvider[];

  let schedulerDisposed = false;
  let harnessDisposed = false;
  let inFlight: Promise<void> | undefined;
  let pendingLease: SessionLease | undefined;

  async function runDispose(): Promise<void> {
    if (!schedulerDisposed) {
      // Fail fast: if the scheduler cannot confirm shutdown, do not touch the
      // harness — a still-active scheduler can resume() against an already
      // disposed harness, breaking the stop-before-dispose invariant.
      await parts.scheduler.dispose();
      schedulerDisposed = true;
    }

    while (!harnessDisposed) {
      const leaseAtCall = pendingLease;
      try {
        assertOk(await parts.harness.dispose(leaseAtCall));
        harnessDisposed = true;
        pendingLease = undefined;
      } catch (error) {
        // STALE_REF means the harness rejected the lease (poisoned
        // high-epoch / fabricated / from a previous session). Drop it so a
        // later caller's real lease isn't blocked by epoch comparison from
        // ever replacing the bad one.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: unknown }).code === "STALE_REF"
        ) {
          if (pendingLease === leaseAtCall) pendingLease = undefined;
        }
        if (pendingLease !== leaseAtCall) {
          // A concurrent caller supplied a newer lease while the in-flight
          // harness.dispose was running with a stale/undefined one, or we
          // just cleared a poisoned lease above. Retry with the updated
          // value so the live session is actually revoked.
          continue;
        }
        throw error;
      }
    }
  }

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware: () => middleware,
    providers: () => providers,
    dispose: (lease?: SessionLease) => {
      if (lease !== undefined) {
        // Only accept a strictly newer lease. SessionLease.epoch is monotonic
        // per harness instance across sessions, so the higher epoch always
        // wins regardless of sessionId. Equal-epoch leases keep the existing
        // pending value so a stale caller cannot clobber the active one.
        if (pendingLease === undefined || lease.epoch > pendingLease.epoch) {
          pendingLease = lease;
        }
      }
      if (inFlight !== undefined) return inFlight;
      const attempt = runDispose().finally(() => {
        if (inFlight === attempt) inFlight = undefined;
      });
      inFlight = attempt;
      return attempt;
    },
    agentResolver: parts.agentResolver,
  };
}
