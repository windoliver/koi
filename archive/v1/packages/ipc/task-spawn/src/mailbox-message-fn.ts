/**
 * Mailbox-backed MessageFn factory.
 *
 * Creates a MessageFn that sends a task request to a live copilot agent
 * via MailboxComponent + sendAndWait from @koi/delegation.
 */

import type { AgentId, MailboxComponent } from "@koi/core";
import { sendAndWait } from "@koi/delegation";
import type { MessageFn, TaskMessageRequest, TaskSpawnResult } from "./types.js";

/** Default timeout for waiting on copilot response (60 seconds). */
const DEFAULT_MESSAGE_TIMEOUT_MS = 60_000;

export interface MailboxMessageFnConfig {
  readonly mailbox: MailboxComponent;
  readonly senderId: AgentId;
  readonly timeoutMs?: number | undefined;
}

/**
 * Create a MessageFn backed by MailboxComponent IPC.
 *
 * Sends a task request to the target agent and waits for a correlated response.
 * Extracts the output from the response payload.
 */
export function createMailboxMessageFn(config: MailboxMessageFnConfig): MessageFn {
  const { mailbox, senderId, timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS } = config;

  return async (request: TaskMessageRequest): Promise<TaskSpawnResult> => {
    const result = await sendAndWait({
      mailbox,
      message: {
        from: senderId,
        to: request.agentId,
        kind: "request",
        type: "task",
        payload: { description: request.description },
      },
      timeoutMs,
      signal: request.signal,
    });

    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    // Extract output from response payload
    const payload = result.message.payload;
    const output =
      typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output ?? payload);

    return { ok: true, output };
  };
}
