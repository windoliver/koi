/**
 * Promise-based pause mechanism that awaits a human response via channel.
 *
 * Registers a one-time channel.onMessage() listener and races against
 * an AbortSignal and a timeout. The resolved value is an EscalationDecision.
 */

import type { ChannelAdapter, InboundMessage } from "@koi/core";
import type { EscalationDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EscalationGate {
  /** Promise that resolves to the human's decision. */
  readonly promise: Promise<EscalationDecision>;
  /** Returns true if the gate has not yet resolved. */
  readonly isPending: () => boolean;
  /** Cancel the gate (resolves as abort). */
  readonly cancel: () => void;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parses a human's inbound message into an EscalationDecision.
 * - Text containing only "abort" (case-insensitive, trimmed) → abort
 * - Anything else → resume with the text as instruction
 */
export function parseHumanResponse(message: InboundMessage): EscalationDecision {
  const firstText = message.content.find((block) => block.kind === "text");
  if (firstText === undefined) {
    return { kind: "resume" };
  }

  const text = firstText.text.trim();

  if (text.toLowerCase() === "abort") {
    return { kind: "abort", reason: "Human operator requested abort" };
  }

  return { kind: "resume", instruction: text };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEscalationGate(
  channel: ChannelAdapter,
  signal?: AbortSignal,
  timeoutMs?: number,
): EscalationGate {
  // let: mutable — gate state is inherently stateful (pending → resolved)
  let pending = true;
  // let: mutable — cleanup references cleared on resolution
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // let: mutable — abort listener reference cleared on resolution to prevent leak
  let abortListener: (() => void) | undefined;
  // let: mutable — cancel function wired to resolve
  let cancelFn: (() => void) | undefined;

  function cleanup(): void {
    pending = false;
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (abortListener !== undefined && signal !== undefined) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  }

  const promise = new Promise<EscalationDecision>((resolve) => {
    // Wire cancel to resolve as abort
    cancelFn = () => {
      if (!pending) return;
      cleanup();
      resolve({ kind: "abort", reason: "Escalation cancelled" });
    };

    // Listen for human response
    unsubscribe = channel.onMessage(async (message: InboundMessage) => {
      if (!pending) return;
      const decision = parseHumanResponse(message);
      cleanup();
      resolve(decision);
    });

    // Timeout race
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!pending) return;
        cleanup();
        resolve({ kind: "abort", reason: `Escalation timed out after ${String(timeoutMs)}ms` });
      }, timeoutMs);
    }

    // AbortSignal race
    if (signal !== undefined) {
      if (signal.aborted) {
        cleanup();
        resolve({ kind: "abort", reason: "Escalation aborted via signal" });
        return;
      }
      abortListener = () => {
        if (!pending) return;
        cleanup();
        resolve({ kind: "abort", reason: "Escalation aborted via signal" });
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  return {
    promise,
    isPending: () => pending,
    cancel: () => cancelFn?.(),
  };
}
