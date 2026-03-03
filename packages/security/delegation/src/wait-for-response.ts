/**
 * waitForResponse — subscribes to a mailbox and resolves when a response
 * with a matching correlationId arrives, or rejects on timeout/abort.
 */

import type { AgentMessage, MailboxComponent, MessageId } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WaitForResponseConfig {
  readonly mailbox: MailboxComponent;
  readonly correlationId: MessageId;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export type WaitResult =
  | { readonly ok: true; readonly message: AgentMessage }
  | { readonly ok: false; readonly reason: "timeout" | "aborted" };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function waitForResponse(config: WaitForResponseConfig): Promise<WaitResult> {
  const { mailbox, correlationId, timeoutMs, signal } = config;

  return new Promise<WaitResult>((resolve) => {
    let settled = false;
    // Mutable holder — unsubscribe may not yet be assigned when handler fires synchronously
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      settled = true;
      if (unsub !== undefined) unsub();
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      cleanup();
      resolve({ ok: false, reason: "aborted" });
    };

    // Check pre-aborted signal before subscribing
    if (signal?.aborted) {
      settled = true;
      resolve({ ok: false, reason: "aborted" });
      return;
    }

    // Subscribe to mailbox for matching response
    unsub = mailbox.onMessage((message: AgentMessage) => {
      if (settled) return;
      if (message.kind !== "response") return;
      if (message.correlationId !== correlationId) return;

      cleanup();
      resolve({ ok: true, message });
    });

    // If handler fired synchronously and already settled, clean up timer/signal
    if (settled) return;

    // Timeout handler
    timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort);
    }
  });
}
