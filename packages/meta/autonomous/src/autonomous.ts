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
  // All leases supplied by callers, ordered: highest-epoch first. The harness
  // validates lease identity (WeakSet) so a higher-epoch lease may still be
  // poisoned/stale; on STALE_REF we discard the failed candidate and fall
  // through to the next, preserving real lower-epoch leases that callers
  // supplied concurrently.
  const candidateLeases: SessionLease[] = [];

  function recordLease(lease: SessionLease): void {
    if (candidateLeases.some((l) => l === lease)) return;
    let i = 0;
    while (i < candidateLeases.length) {
      const existing = candidateLeases[i];
      if (existing === undefined || existing.epoch < lease.epoch) break;
      i += 1;
    }
    candidateLeases.splice(i, 0, lease);
  }

  async function runDispose(): Promise<void> {
    if (!schedulerDisposed) {
      // Fail fast: if the scheduler cannot confirm shutdown, do not touch the
      // harness — a still-active scheduler can resume() against an already
      // disposed harness, breaking the stop-before-dispose invariant.
      await parts.scheduler.dispose();
      schedulerDisposed = true;
    }

    while (!harnessDisposed) {
      const leaseAtCall = candidateLeases[0];
      const candidateCountAtCall = candidateLeases.length;
      try {
        assertOk(await parts.harness.dispose(leaseAtCall));
        harnessDisposed = true;
        candidateLeases.length = 0;
      } catch (error) {
        const isStaleRef =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code: unknown }).code === "STALE_REF";
        if (isStaleRef && leaseAtCall !== undefined) {
          // The harness rejected this specific lease. Try the next candidate
          // (a real lower-epoch lease may have been suppressed behind a
          // poisoned higher-epoch one).
          const idx = candidateLeases.indexOf(leaseAtCall);
          if (idx >= 0) candidateLeases.splice(idx, 1);
          continue;
        }
        if (candidateLeases.length !== candidateCountAtCall) {
          // A concurrent caller supplied a newer lease while the in-flight
          // harness.dispose was running with a stale/undefined one. Retry
          // with the new candidate so the live session is actually revoked.
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
      if (lease !== undefined) recordLease(lease);
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
