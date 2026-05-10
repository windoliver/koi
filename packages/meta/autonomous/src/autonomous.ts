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
      ? [createTaskSpawnProvider({ agentResolver: parts.agentResolver, spawn })]
      : [],
  ) as readonly ComponentProvider[];

  let schedulerDisposed = false;
  let harnessDisposed = false;
  let inFlight: Promise<void> | undefined;
  let pendingLease: SessionLease | undefined;

  async function runDispose(): Promise<void> {
    let schedulerError: unknown;

    if (!schedulerDisposed) {
      try {
        await parts.scheduler.dispose();
        schedulerDisposed = true;
      } catch (error) {
        schedulerError = error;
      }
    }

    while (!harnessDisposed) {
      const leaseAtCall = pendingLease;
      try {
        assertOk(await parts.harness.dispose(leaseAtCall));
        harnessDisposed = true;
        pendingLease = undefined;
      } catch (error) {
        if (pendingLease !== leaseAtCall) {
          // A concurrent caller supplied a newer lease while the in-flight
          // harness.dispose was running with a stale/undefined one. Retry once
          // with the updated lease so the live session is actually revoked.
          continue;
        }
        if (schedulerError !== undefined) {
          throw new AggregateError(
            [schedulerError, error],
            "autonomous dispose failed during scheduler and harness cleanup",
          );
        }
        throw error;
      }
    }

    if (schedulerError !== undefined) {
      throw schedulerError;
    }
  }

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware: () => middleware,
    providers: () => providers,
    dispose: (lease?: SessionLease) => {
      if (lease !== undefined) {
        pendingLease = lease;
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
