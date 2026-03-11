/**
 * Debounce utility — coalesces rapid calls into a single execution.
 *
 * Returns a debounced version of the function that delays invocation
 * until `delayMs` milliseconds have elapsed since the last call.
 */

/** Handle for a debounced function with cancel support. */
export interface DebouncedFn<TArgs extends readonly unknown[]> {
  /** Call the debounced function. Resets the timer on each call. */
  readonly call: (...args: TArgs) => void;
  /** Cancel any pending invocation. */
  readonly cancel: () => void;
  /** Invoke immediately if a call is pending, then cancel the timer. */
  readonly flush: () => void;
}

/** Create a debounced version of the given function. */
export function createDebounce<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): DebouncedFn<TArgs> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: TArgs | undefined;

  function cancel(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastArgs = undefined;
  }

  function flush(): void {
    if (timer !== undefined && lastArgs !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      const args = lastArgs;
      lastArgs = undefined;
      fn(...args);
    }
  }

  function call(...args: TArgs): void {
    lastArgs = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      const a = lastArgs;
      lastArgs = undefined;
      if (a !== undefined) {
        fn(...a);
      }
    }, delayMs);
  }

  return { call, cancel, flush };
}
