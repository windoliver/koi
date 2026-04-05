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
 * Invoke `isDrifting` callback with timeout + composed signal + error
 * hook. On error/timeout returns `undefined` (caller applies fail-safe
 * policy). Success returns the boolean result.
 */
export async function invokeIsDriftingCallback(
  callback: IsDriftingFn,
  input: DriftJudgeInput,
  opts: CallbackHarnessOptions,
): Promise<boolean | undefined> {
  const { signal, cleanup } = composeTimeoutSignal(opts.ctx.signal, opts.timeoutMs);
  const callbackCtx: TurnContext = { ...opts.ctx, signal };
  try {
    const resultPromise = Promise.resolve(callback(input, callbackCtx));
    const result = await raceSignal(resultPromise, signal);
    return result;
  } catch (err: unknown) {
    fireErrorHook(opts.onError, "isDrifting", err, opts.ctx);
    return undefined;
  } finally {
    cleanup();
  }
}

/**
 * Invoke `detectCompletions` callback with timeout + composed signal +
 * error hook. On error/timeout returns `undefined` (caller falls back to
 * heuristic). Success returns the newly-completed IDs.
 */
export async function invokeDetectCompletionsCallback(
  callback: DetectCompletionsFn,
  responseTexts: readonly string[],
  items: readonly GoalItemWithId[],
  opts: CallbackHarnessOptions,
): Promise<readonly string[] | undefined> {
  const { signal, cleanup } = composeTimeoutSignal(opts.ctx.signal, opts.timeoutMs);
  const callbackCtx: TurnContext = { ...opts.ctx, signal };
  try {
    const resultPromise = Promise.resolve(callback(responseTexts, items, callbackCtx));
    const result = await raceSignal(resultPromise, signal);
    return result;
  } catch (err: unknown) {
    fireErrorHook(opts.onError, "detectCompletions", err, opts.ctx);
    return undefined;
  } finally {
    cleanup();
  }
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
 * Filter synthetic stop-gate retry system messages out of a message
 * buffer. The engine inserts `[Completion blocked] ...` system messages
 * on retry turns (`packages/kernel/engine/src/koi.ts:706-718`); these
 * should not reach the drift judge.
 */
export function filterSyntheticRetryMessages(
  messages: readonly InboundMessage[],
): readonly InboundMessage[] {
  return messages.filter((m) => {
    if (m.senderId !== "system") return true;
    for (const block of m.content) {
      if (block.kind === "text" && block.text.startsWith("[Completion blocked]")) {
        return false;
      }
    }
    return true;
  });
}
