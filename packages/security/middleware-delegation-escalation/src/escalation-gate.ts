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

export interface EscalationGateOptions {
  /** AbortSignal to cancel the escalation. */
  readonly signal?: AbortSignal;
  /** Maximum time in ms before the escalation times out. */
  readonly timeoutMs?: number;
  /**
   * Correlation token to filter inbound messages.
   * Only messages whose metadata.correlationToken or threadId matches
   * this value will be considered. Without this, in shared channels
   * unrelated traffic can accidentally resolve the gate.
   */
  readonly correlationToken?: string;
}

export function createEscalationGate(
  channel: ChannelAdapter,
  signalOrOptions?: AbortSignal | EscalationGateOptions,
  timeoutMs?: number,
): EscalationGate {
  // Support both old positional args and new options object
  const opts: EscalationGateOptions | undefined =
    signalOrOptions === undefined ? undefined
    : signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions as AbortSignal }
    : signalOrOptions as EscalationGateOptions;
  const signal: AbortSignal | undefined = opts?.signal;
  const resolvedTimeoutMs: number | undefined = opts?.timeoutMs ?? timeoutMs;
  const correlationToken: string | undefined = opts?.correlationToken;
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

    // Listen for human response — filter by correlationToken when set
    unsubscribe = channel.onMessage(async (message: InboundMessage) => {
      if (!pending) return;
      if (correlationToken !== undefined) {
        const meta = message.metadata as Record<string, unknown> | undefined;
        const matchesThread = message.threadId === correlationToken;
        const matchesMeta = meta?.correlationToken === correlationToken;
        if (!matchesThread && !matchesMeta) return; // Not our escalation — ignore
      }
      const decision = parseHumanResponse(message);
      cleanup();
      resolve(decision);
    });

    // Timeout race
    if (resolvedTimeoutMs !== undefined && resolvedTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!pending) return;
        cleanup();
        resolve({
          kind: "abort",
          reason: `Escalation timed out after ${String(resolvedTimeoutMs)}ms`,
        });
      }, resolvedTimeoutMs);
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
