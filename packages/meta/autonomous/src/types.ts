import type { AgentResolver, ComponentProvider, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness, SessionLease } from "@koi/long-running";
import type { MessageFn, SpawnFitnessWrapperConfig, SpawnFn } from "@koi/task-spawn";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly spawnFitness?: SpawnFitnessWrapperConfig | undefined;
  /** Default agent type used when the model omits `agent_type`. */
  readonly defaultAgent?: string | undefined;
  /** Optional live-agent message callback for routing to existing idle copilots. */
  readonly message?: MessageFn | undefined;
  /** Optional per-task wall-clock budget forwarded to the task tool. */
  readonly maxDurationMs?: number | undefined;
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
