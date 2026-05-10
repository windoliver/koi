import type { AgentResolver, ComponentProvider, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness, SessionLease } from "@koi/long-running";
import type { SpawnFitnessWrapperConfig, SpawnFn } from "@koi/task-spawn";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly spawnFitness?: SpawnFitnessWrapperConfig | undefined;
  readonly extraMiddleware?: readonly KoiMiddleware[] | undefined;
}

export interface AutonomousAgent {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly middleware: () => readonly KoiMiddleware[];
  readonly providers: () => readonly ComponentProvider[];
  /**
   * Tear down the scheduler and harness in order. Pass the currently active
   * `SessionLease` so `harness.dispose(lease)` can revoke an active session;
   * omit when no session is active.
   */
  readonly dispose: (lease?: SessionLease) => Promise<void>;
  readonly agentResolver?: AgentResolver | undefined;
}
