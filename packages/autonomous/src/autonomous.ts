/**
 * Autonomous agent factory — composes harness + scheduler + optional compactor
 * into a coordinated autonomous agent.
 *
 * Disposal order: stop scheduler first (prevents new resumes), then dispose harness.
 */

import type { KoiMiddleware } from "@koi/core";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  let disposed = false;

  // Cache middleware to avoid re-creating harness middleware on every call
  const cachedMiddleware: readonly KoiMiddleware[] =
    parts.compactorMiddleware !== undefined
      ? [parts.harness.createMiddleware(), parts.compactorMiddleware]
      : [parts.harness.createMiddleware()];

  const middleware = (): readonly KoiMiddleware[] => cachedMiddleware;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Order: stop scheduler first (prevents new resumes), then dispose harness
    await parts.scheduler.dispose();
    await parts.harness.dispose();
  };

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware,
    dispose,
  };
}
