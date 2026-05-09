import {
  // @ts-expect-error — defineSignal/setHandler/inWorkflowContext are exported at runtime
  // from @temporalio/workflow but their type declarations are dropped from index.d.ts in
  // 1.16.x. Type the results locally instead. See retry-workflow.ts for the same pattern.
  defineSignal as defineSignalUntyped,
  // @ts-expect-error
  inWorkflowContext as inWorkflowContextUntyped,
  // @ts-expect-error
  setHandler as setHandlerUntyped,
} from "@temporalio/workflow";
import {
  type AgentTurnResult,
  createDefaultAgentActivities,
  getAgentWorkflowMessages,
} from "../activities/agent-activity.js";
import type { AgentWorkflowConfig, IncomingMessage } from "../types.js";

interface SignalDef<T extends unknown[]> {
  readonly __signalArgs?: T;
}

const defineSignal = defineSignalUntyped as <T extends unknown[]>(name: string) => SignalDef<T>;

const setHandler = setHandlerUntyped as <T extends unknown[]>(
  signal: SignalDef<T>,
  handler: (...args: T) => void,
) => void;

const inWorkflowContext = inWorkflowContextUntyped as () => boolean;

interface AgentWorkflowDeps {
  readonly runAgentTurn: (input: AgentWorkflowConfig) => Promise<AgentTurnResult>;
}

const defaultAgentActivities = createDefaultAgentActivities();

const defaultAgentWorkflowDeps: AgentWorkflowDeps = {
  runAgentTurn: defaultAgentActivities.runAgentTurn,
};

let agentWorkflowDeps: AgentWorkflowDeps = defaultAgentWorkflowDeps;

export function setAgentWorkflowDepsForTest(overrides: Partial<AgentWorkflowDeps>): void {
  agentWorkflowDeps = { ...defaultAgentWorkflowDeps, ...overrides };
}

export function resetAgentWorkflowDepsForTest(): void {
  agentWorkflowDeps = defaultAgentWorkflowDeps;
}

// Signal contract used by the scheduler dispatch path (signalWithStart). signalWithStart
// buffers the signal payload and delivers it before workflow execution begins, so the
// "messages" handler appends the dispatched batch to the queue before the main loop runs.
// Subsequent dispatch calls re-invoke signalWithStart, starting a fresh workflow execution
// that absorbs the new batch via the same handler.
const messagesSignal = defineSignal<[readonly IncomingMessage[]]>("messages");

export async function agentWorkflow(config: AgentWorkflowConfig): Promise<void> {
  const queue: IncomingMessage[] = [...getAgentWorkflowMessages(config)];

  // Signal handlers are only valid in Temporal workflow context. Calling outside (in
  // unit tests that invoke the workflow function directly) would throw; skip cleanly so
  // the function remains testable as a plain async function.
  if (inWorkflowContext()) {
    setHandler(messagesSignal, (incoming) => {
      queue.push(...incoming);
    });
  }

  if (queue.length === 0) {
    return;
  }

  let stateRefs = config.stateRefs;
  let remainingStopRetries = Math.max(config.maxStopRetries ?? 0, 0);
  const maxTurns = queue.length + Math.max(config.maxStopRetries ?? 0, 0);

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const previousStateRefs = stateRefs;
    const result = await agentWorkflowDeps.runAgentTurn({
      ...config,
      stateRefs,
      initialMessage: undefined,
      initialMessages: queue,
    });

    stateRefs = result.updatedStateRefs;
    if (result.next.kind === "complete") {
      return;
    }

    const progressed =
      stateRefs.turnsProcessed > previousStateRefs.turnsProcessed ||
      stateRefs.lastTurnId !== previousStateRefs.lastTurnId;
    if (!progressed) {
      if (remainingStopRetries <= 0) {
        throw new Error("agent workflow requested retry without advancing state");
      }
      remainingStopRetries -= 1;
    }
  }

  throw new Error("agent workflow exhausted turn budget before completion");
}
