export interface RetrySendOptions {
  readonly maxRetries?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly isTransientError?: ((error: Error) => boolean) | undefined;
  readonly sleep?: ((delayMs: number) => Promise<void> | void) | undefined;
  /**
   * Per-attempt deadline. If `send` does not settle within this many
   * milliseconds the attempt rejects with a timeout error and the retry
   * loop continues, preventing a hung transport from blocking the caller
   * forever. Default: no per-attempt timeout (matches prior behavior).
   */
  readonly attemptTimeoutMs?: number | undefined;
}

export interface RetrySendSuccessResult {
  readonly ok: true;
  readonly attempts: number;
}

export interface RetrySendFailureResult {
  readonly ok: false;
  readonly attempts: number;
  readonly exhausted: boolean;
  readonly transient: boolean;
  readonly error: Error;
}

export type RetrySendResult = RetrySendSuccessResult | RetrySendFailureResult;

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Unknown send failure");
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function sendWithRetry<T>(
  send: (message: T) => Promise<void>,
  message: T,
  options: RetrySendOptions = {},
): Promise<RetrySendResult> {
  const maxRetries = options.maxRetries ?? 3;
  const delayMs = options.delayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;

  const attemptTimeoutMs = options.attemptTimeoutMs;

  async function callOnce(): Promise<void> {
    if (attemptTimeoutMs === undefined || attemptTimeoutMs <= 0) {
      await send(message);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`send attempt timed out after ${attemptTimeoutMs}ms`)),
        attemptTimeoutMs,
      );
    });
    try {
      await Promise.race([send(message), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  let attempts = 0;
  while (attempts <= maxRetries) {
    attempts += 1;

    try {
      await callOnce();
      return { ok: true, attempts };
    } catch (error: unknown) {
      const normalizedError = toError(error);
      const transient = options.isTransientError?.(normalizedError) ?? false;

      if (!transient) {
        return {
          ok: false,
          attempts,
          exhausted: false,
          transient: false,
          error: normalizedError,
        };
      }

      if (attempts > maxRetries) {
        return {
          ok: false,
          attempts,
          exhausted: true,
          transient: true,
          error: normalizedError,
        };
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  return {
    ok: false,
    attempts,
    exhausted: true,
    transient: true,
    error: new Error("Unreachable retry state"),
  };
}
