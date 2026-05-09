import type { AgentResolver, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

export interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly agentResolver?: AgentResolver | undefined;
  readonly extraMiddleware?: readonly KoiMiddleware[] | undefined;
}

export interface AutonomousAgent {
  readonly harness: LongRunningHarness;
  readonly scheduler: HarnessScheduler;
  readonly middleware: () => readonly KoiMiddleware[];
  readonly dispose: () => Promise<void>;
  readonly agentResolver?: AgentResolver | undefined;
}
