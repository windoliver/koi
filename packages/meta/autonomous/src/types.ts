import type { AgentResolver, ComponentProvider, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { CompletionNotifier, LongRunningHarness } from "@koi/long-running";
import type { SpawnFitnessWrapperConfig, SpawnFn } from "@koi/task-spawn";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly spawn?: SpawnFn | undefined;
  readonly completionNotifier?: CompletionNotifier | undefined;
  readonly spawnFitness?: SpawnFitnessWrapperConfig | undefined;
  readonly extraMiddleware?: readonly KoiMiddleware[] | undefined;
}

export interface AutonomousAgent {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly middleware: () => readonly KoiMiddleware[];
  readonly providers: () => readonly ComponentProvider[];
  readonly dispose: () => Promise<void>;
  readonly agentResolver?: AgentResolver | undefined;
}
