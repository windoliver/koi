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
  // Loop bound tracks observed work (initial queue + signals appended after start),
  // not an iteration count. Each new message via signal raises the cap so bursts cannot
  // exhaust the budget. The maxStopRetries gate still catches genuine non-progress.
  let observedWork = queue.length;
  let processedTurns = 0;
  const maxStopRetriesValue = Math.max(config.maxStopRetries ?? 0, 0);
  const turnHeadroom = maxStopRetriesValue * 2 + 16;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const previousStateRefs = stateRefs;
    // Snapshot queue length before the turn so we can detect signals that arrive
    // concurrently with runAgentTurn. The "messages" handler appends to `queue` from
    // outside the turn, so post-turn growth is the signal-arrival flag.
    const queueLengthBeforeTurn = queue.length;
    const result = await agentWorkflowDeps.runAgentTurn({
      ...config,
      stateRefs,
      initialMessage: undefined,
      initialMessages: queue,
    });

    stateRefs = result.updatedStateRefs;
    processedTurns += 1;

    // Account for any new messages that arrived during the turn so the runaway guard
    // grows with observed work rather than being bypassed by bursts.
    if (queue.length > queueLengthBeforeTurn) {
      observedWork += queue.length - queueLengthBeforeTurn;
    }

    if (result.next.kind === "complete") {
      // If signals arrived during the turn, new work is queued — keep processing so
      // dispatch messages that landed mid-turn aren't dropped. Otherwise the agent has
      // finished everything it saw and the workflow can exit.
      if (queue.length > queueLengthBeforeTurn) {
        continue;
      }
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

    // Hard upper bound provable from observed inputs only: turns may not exceed
    // (work seen so far) * 4 + headroom for stop-retries. This is reachable because
    // observedWork does NOT include processedTurns — it counts messages, not iterations.
    if (processedTurns > observedWork * 4 + turnHeadroom) {
      throw new Error("agent workflow exceeded turn budget relative to observed work");
    }
  }
}
