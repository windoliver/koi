/**
 * sendAndWait — composes mailbox.send() with waitForResponse() into a single
 * request-reply operation. Sends a message and waits for a correlated response.
 */

import type { AgentMessageInput, MailboxComponent } from "@koi/core";
import type { WaitResult } from "./wait-for-response.js";
import { waitForResponse } from "./wait-for-response.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendAndWaitConfig {
  readonly mailbox: MailboxComponent;
  readonly message: AgentMessageInput;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/** Extended WaitResult that also includes send failures. */
export type SendAndWaitResult = WaitResult | { readonly ok: false; readonly reason: "send_failed" };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function sendAndWait(config: SendAndWaitConfig): Promise<SendAndWaitResult> {
  const { mailbox, message, timeoutMs, signal } = config;

  // Send the message — catch both Result errors and thrown exceptions
  let sendResult: Awaited<ReturnType<MailboxComponent["send"]>>;
  try {
    sendResult = await mailbox.send(message);
  } catch (_e: unknown) {
    return { ok: false, reason: "send_failed" };
  }

  if (!sendResult.ok) {
    return { ok: false, reason: "send_failed" };
  }

  // Wait for correlated response using the sent message's ID
  return waitForResponse({
    mailbox,
    correlationId: sendResult.value.id,
    timeoutMs,
    signal,
  });
}
