import {
  // @ts-expect-error — getExternalWorkflowHandle/uuid4/ParentClosePolicy/inWorkflowContext
  // are exported at runtime from @temporalio/workflow but their type declarations are
  // dropped from index.d.ts in 1.16.x. See retry-workflow.ts for the same workaround.
  getExternalWorkflowHandle as getExternalWorkflowHandleUntyped,
  // @ts-expect-error
  inWorkflowContext as inWorkflowContextUntyped,
  // @ts-expect-error
  ParentClosePolicy as ParentClosePolicyUntyped,
  startChild,
  // @ts-expect-error
  uuid4 as uuid4Untyped,
} from "@temporalio/workflow";
import { materializeScheduledAgentWorkflowConfig } from "../activities/scheduled-task-activity.js";
import type {
  IncomingMessage,
  ScheduledTaskWorkflowArgs,
  ScheduledTaskWorkflowResult,
} from "../types.js";
import { agentWorkflow } from "./agent-workflow.js";

const uuid4 = uuid4Untyped as () => string;

interface ExternalSignalHandle {
  readonly signal: (name: string, ...args: readonly unknown[]) => Promise<void>;
}
const getExternalWorkflowHandle = getExternalWorkflowHandleUntyped as (
  workflowId: string,
) => ExternalSignalHandle;

const ParentClosePolicy = ParentClosePolicyUntyped as { readonly ABANDON: unknown };

const inWorkflowContext = inWorkflowContextUntyped as () => boolean;

interface ScheduledTaskWorkflowDeps {
  readonly startAgentExecution: (input: ScheduledTaskWorkflowArgs) => Promise<string>;
  readonly dispatchToAgent: (input: ScheduledTaskWorkflowArgs) => Promise<void>;
}

// Spawn: each cron firing creates a fresh agent workflow with a uuid-suffixed ID so
// concurrent firings never collide. workflowIdReusePolicy is unset because each ID is
// already unique per firing.
async function defaultStartAgentExecution(input: ScheduledTaskWorkflowArgs): Promise<string> {
  const workflowId = `scheduled:${String(input.agentId)}:${uuid4()}`;
  const config = materializeScheduledAgentWorkflowConfig(input, workflowId, Date.now());
  await startChild(agentWorkflow, {
    args: [config],
    workflowId,
    // ABANDON lets the spawned agent run independently after the wrapper completes;
    // wrapper exits quickly so SKIP overlap policy does not drop subsequent firings.
    parentClosePolicy: ParentClosePolicy.ABANDON,
  });
  return workflowId;
}

// Dispatch: target the long-running per-agent workflow at workflowId=agentId so cron
// firings join the SAME execution that direct submit-dispatch (signalWithStart) targets.
// This preserves ordering and shared state across cron and direct dispatch traffic.
async function defaultDispatchToAgent(input: ScheduledTaskWorkflowArgs): Promise<void> {
  // Workflow-context-only APIs (getExternalWorkflowHandle/startChild) throw outside the
  // Temporal worker. Allow direct invocation from unit tests by no-op'ing in that case;
  // the function is exercised end-to-end via the worker integration tests.
  if (!inWorkflowContext()) {
    return;
  }
  const agentWorkflowId = String(input.agentId);
  const sessionId = `dispatch:${agentWorkflowId}:${uuid4()}`;
  const messages: readonly IncomingMessage[] =
    materializeScheduledAgentWorkflowConfig(input, sessionId, Date.now()).initialMessages ?? [];

  // Try to signal the existing agent workflow first; on not-found, start it. This
  // mirrors the signalWithStart semantic used by submit-dispatch from the client side
  // but expressed via workflow-context APIs (Temporal Schedules cannot signalWithStart
  // directly). The wrapper exits as soon as delivery is acknowledged, keeping cron
  // firings short so SKIP overlap policy never drops ticks waiting on agent work.
  try {
    await getExternalWorkflowHandle(agentWorkflowId).signal("messages", messages);
    return;
  } catch {
    // fall through — workflow does not exist, start it with the messages as the
    // initial batch.
  }

  try {
    await startChild(agentWorkflow, {
      args: [
        {
          agentId: input.agentId,
          sessionId: sessionId as never,
          stateRefs: { lastTurnId: undefined, turnsProcessed: 0 },
          initialMessages: messages,
          ...(input.input.maxStopRetries !== undefined
            ? { maxStopRetries: input.input.maxStopRetries }
            : {}),
        },
      ],
      workflowId: agentWorkflowId,
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
  } catch {
    // Race: another firing started the workflow between our signal-attempt and
    // startChild. Retry the signal — it should now succeed against the running peer.
    await getExternalWorkflowHandle(agentWorkflowId).signal("messages", messages);
  }
}

const defaultScheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = {
  startAgentExecution: defaultStartAgentExecution,
  dispatchToAgent: defaultDispatchToAgent,
};

let scheduledTaskWorkflowDeps: ScheduledTaskWorkflowDeps = defaultScheduledTaskWorkflowDeps;

export function setScheduledTaskWorkflowDepsForTest(
  overrides: Partial<ScheduledTaskWorkflowDeps>,
): void {
  scheduledTaskWorkflowDeps = { ...defaultScheduledTaskWorkflowDeps, ...overrides };
}

export function resetScheduledTaskWorkflowDepsForTest(): void {
  scheduledTaskWorkflowDeps = defaultScheduledTaskWorkflowDeps;
}

export async function scheduledTaskWorkflow(
  args: ScheduledTaskWorkflowArgs,
): Promise<ScheduledTaskWorkflowResult> {
  if (args.mode === "spawn") {
    const workflowId = await scheduledTaskWorkflowDeps.startAgentExecution(args);
    return { kind: "spawned", workflowId };
  }

  await scheduledTaskWorkflowDeps.dispatchToAgent(args);
  return { kind: "dispatched" };
}
