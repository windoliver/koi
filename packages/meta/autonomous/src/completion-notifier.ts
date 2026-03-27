/**
 * Completion notifier — creates harness lifecycle callbacks that send
 * push notifications to the initiating copilot's inbox on plan
 * completion or failure.
 *
 * Usage:
 *   const notifier = createCompletionNotifier({ initiatorId, agentId, mailbox });
 *   const harness = createLongRunningHarness({
 *     ...config,
 *     onCompleted: notifier.onCompleted,
 *     onFailed: notifier.onFailed,
 *   });
 *
 * Follows the "thin event" pattern (Stripe, A2A): the notification carries
 * status + summary only. The copilot fetches full results via task_synthesize().
 */

import type {
  AgentId,
  AgentMessageInput,
  HarnessStatus,
  KoiError,
  MailboxComponent,
} from "@koi/core";
import type { OnCompletedCallback, OnFailedCallback } from "@koi/long-running";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CompletionNotifierConfig {
  /** AgentId of the copilot to notify. */
  readonly initiatorId: AgentId;
  /** AgentId of the autonomous agent sending the notification. */
  readonly agentId: AgentId;
  /** Mailbox used to deliver the notification message. */
  readonly mailbox: MailboxComponent;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface CompletionNotifierCallbacks {
  readonly onCompleted: OnCompletedCallback;
  readonly onFailed: OnFailedCallback;
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildCompletionMessage(
  config: CompletionNotifierConfig,
  status: HarnessStatus,
): AgentMessageInput {
  const { completedTaskCount, pendingTaskCount } = status.metrics;
  const total = completedTaskCount + pendingTaskCount;
  return {
    from: config.agentId,
    to: config.initiatorId,
    kind: "event",
    type: "autonomous.completed",
    payload: {
      harnessId: status.harnessId,
      phase: status.phase,
      completedTaskCount,
      totalTaskCount: total,
      summary: `Autonomous plan completed. ${String(completedTaskCount)}/${String(total)} tasks done.`,
    },
    metadata: { mode: "steer" },
  };
}

function buildFailureMessage(
  config: CompletionNotifierConfig,
  status: HarnessStatus,
  error: KoiError,
): AgentMessageInput {
  const { completedTaskCount, pendingTaskCount } = status.metrics;
  const total = completedTaskCount + pendingTaskCount;
  return {
    from: config.agentId,
    to: config.initiatorId,
    kind: "event",
    type: "autonomous.failed",
    payload: {
      harnessId: status.harnessId,
      phase: status.phase,
      completedTaskCount,
      totalTaskCount: total,
      errorCode: error.code,
      errorMessage: error.message,
      summary: `Autonomous plan failed: ${error.message}. ${String(completedTaskCount)}/${String(total)} tasks completed before failure.`,
    },
    metadata: { mode: "steer" },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create onCompleted/onFailed callbacks that send push notifications
 * to the initiating copilot's inbox via the mailbox.
 *
 * Designed to be spread into a `LongRunningConfig`:
 *
 *   const { onCompleted, onFailed } = createCompletionNotifier(notifierConfig);
 *   const harness = createLongRunningHarness({ ...config, onCompleted, onFailed });
 */
export function createCompletionNotifier(
  config: CompletionNotifierConfig,
): CompletionNotifierCallbacks {
  const onCompleted: OnCompletedCallback = async (status: HarnessStatus): Promise<void> => {
    const message = buildCompletionMessage(config, status);
    const result = await config.mailbox.send(message);
    if (!result.ok) {
      console.warn(
        `[autonomous] Failed to send completion notification to ${config.initiatorId}: ${result.error.message}`,
      );
    }
  };

  const onFailed: OnFailedCallback = async (
    status: HarnessStatus,
    error: KoiError,
  ): Promise<void> => {
    const message = buildFailureMessage(config, status, error);
    const result = await config.mailbox.send(message);
    if (!result.ok) {
      console.warn(
        `[autonomous] Failed to send failure notification to ${config.initiatorId}: ${result.error.message}`,
      );
    }
  };

  return { onCompleted, onFailed };
}
