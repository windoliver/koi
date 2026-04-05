/**
 * Callback harness: timeout + AbortSignal + error hook wrapping for
 * user-supplied `isDrifting` / `detectCompletions` callbacks.
 */

import type { InboundMessage, TurnContext } from "@koi/core";

import type {
  DetectCompletionsFn,
  DriftJudgeInput,
  GoalItemWithId,
  IsDriftingFn,
  OnCallbackErrorFn,
} from "./config.js";

/**
 * Compose an upstream `AbortSignal` with a timeout. Returned signal aborts
 * when either source fires. Returns a cleanup fn that clears the timer.
 */
export function composeTimeoutSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("callback timeout", "TimeoutError"));
  }, timeoutMs);

  const onUpstreamAbort = (): void => {
    controller.abort(upstream?.reason);
  };

  if (upstream !== undefined) {
    if (upstream.aborted) {
      controller.abort(upstream.reason);
    } else {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  const cleanup = (): void => {
    clearTimeout(timer);
    if (upstream !== undefined) {
      upstream.removeEventListener("abort", onUpstreamAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

/** Race a promise against the signal — settles on abort. */
async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      const reason: unknown = signal.reason;
      if (reason instanceof Error) {
        reject(reason);
      } else {
        reject(new Error("aborted"));
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Classify an abort error as timeout vs upstream cancellation. */
function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

interface CallbackHarnessOptions {
  readonly timeoutMs: number;
  readonly ctx: TurnContext;
  readonly onError?: OnCallbackErrorFn | undefined;
}

/**
 * Tagged result from a callback invocation.
 *
 * - `ok: true`: callback resolved successfully with value.
 * - `reason: "aborted"`: upstream run cancellation — caller should stop
 *   processing, NOT apply heuristic fallback or fire side effects.
 * - `reason: "timeout"` / `"error"`: callback failure — caller applies
 *   its fail-safe / heuristic policy.
 */
export type CallbackOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "aborted" | "timeout" | "error" };

/**
 * Invoke `isDrifting` callback with timeout + composed signal + error
 * hook. Returns a tagged outcome so callers can distinguish upstream
 * cancellation from timeout/error.
 */
export async function invokeIsDriftingCallback(
  callback: IsDriftingFn,
  input: DriftJudgeInput,
  opts: CallbackHarnessOptions,
): Promise<CallbackOutcome<boolean>> {
  // Pre-abort guard: if upstream is already cancelled, do NOT invoke the
  // user callback body (avoid external side effects after abort).
  if (opts.ctx.signal?.aborted === true) {
    return { ok: false, reason: "aborted" };
  }
  const { signal, cleanup } = composeTimeoutSignal(opts.ctx.signal, opts.timeoutMs);
  const callbackCtx: TurnContext = { ...opts.ctx, signal };
  try {
    const resultPromise = Promise.resolve(callback(input, callbackCtx));
    const value = await raceSignal(resultPromise, signal);
    return { ok: true, value };
  } catch (err: unknown) {
    return classifyCallbackError(err, "isDrifting", opts);
  } finally {
    cleanup();
  }
}

/**
 * Invoke `detectCompletions` callback with timeout + composed signal +
 * error hook. Returns a tagged outcome.
 */
export async function invokeDetectCompletionsCallback(
  callback: DetectCompletionsFn,
  responseTexts: readonly string[],
  items: readonly GoalItemWithId[],
  opts: CallbackHarnessOptions,
): Promise<CallbackOutcome<readonly string[]>> {
  // Pre-abort guard: if upstream is already cancelled, do NOT invoke the
  // user callback body (avoid external side effects after abort).
  if (opts.ctx.signal?.aborted === true) {
    return { ok: false, reason: "aborted" };
  }
  const { signal, cleanup } = composeTimeoutSignal(opts.ctx.signal, opts.timeoutMs);
  const callbackCtx: TurnContext = { ...opts.ctx, signal };
  try {
    const resultPromise = Promise.resolve(callback(responseTexts, items, callbackCtx));
    const value = await raceSignal(resultPromise, signal);
    return { ok: true, value };
  } catch (err: unknown) {
    return classifyCallbackError(err, "detectCompletions", opts);
  } finally {
    cleanup();
  }
}

/**
 * Classify a caught error into upstream-abort vs timeout vs error.
 * Upstream-abort does NOT fire the error hook — it is not a callback
 * failure, it is cooperative cancellation.
 */
function classifyCallbackError<T>(
  err: unknown,
  kind: "isDrifting" | "detectCompletions",
  opts: CallbackHarnessOptions,
): CallbackOutcome<T> {
  const timeout = isTimeoutAbort(err);
  const upstreamAborted = opts.ctx.signal?.aborted === true && !timeout;
  if (upstreamAborted) {
    return { ok: false, reason: "aborted" };
  }
  fireErrorHook(opts.onError, kind, err, opts.ctx);
  return { ok: false, reason: timeout ? "timeout" : "error" };
}

function fireErrorHook(
  onError: OnCallbackErrorFn | undefined,
  callback: "isDrifting" | "detectCompletions",
  err: unknown,
  ctx: TurnContext,
): void {
  if (onError === undefined) return;
  try {
    onError({
      callback,
      reason: isTimeoutAbort(err) ? "timeout" : "error",
      error: err,
      sessionId: ctx.session.sessionId,
      turnId: ctx.turnId,
    });
  } catch {
    // Observability must not fail the turn
  }
}

/**
 * Sanitize an inbound message list before exposing it to user callbacks.
 *
 * - Drops assistant/system/tool-authored messages (callbacks see only
 *   user-authored content — trust boundary).
 * - Drops synthetic `[Completion blocked] ...` stop-gate retry messages.
 * - Strips non-text content blocks (file/image/tool/custom) so file
 *   attachments, tool outputs, and hidden content cannot exfiltrate to
 *   external LLM judges.
 * - Deep-clones the result (fresh content arrays) so callback mutation
 *   cannot poison session-state references.
 */
export function sanitizeUserMessages(
  messages: readonly InboundMessage[],
): readonly InboundMessage[] {
  const result: InboundMessage[] = [];
  for (const m of messages) {
    if (isNonUserSender(m.senderId)) continue;
    if (isSyntheticRetry(m)) continue;
    const textBlocks: Array<{ readonly kind: "text"; readonly text: string }> = [];
    for (const block of m.content) {
      if (block.kind === "text") {
        textBlocks.push({ kind: "text", text: block.text });
      }
    }
    if (textBlocks.length === 0) continue;
    result.push({
      senderId: m.senderId,
      timestamp: m.timestamp,
      content: textBlocks,
    });
  }
  return result;
}

function isNonUserSender(senderId: string): boolean {
  if (senderId === "system" || senderId === "assistant" || senderId === "tool") return true;
  if (senderId.startsWith("system:")) return true;
  return false;
}

function isSyntheticRetry(m: InboundMessage): boolean {
  if (m.senderId !== "system") return false;
  for (const block of m.content) {
    if (block.kind === "text" && block.text.startsWith("[Completion blocked]")) {
      return true;
    }
  }
  return false;
}

// Legacy export kept for backward compatibility of any external users.
export function filterSyntheticRetryMessages(
  messages: readonly InboundMessage[],
): readonly InboundMessage[] {
  return sanitizeUserMessages(messages);
}
