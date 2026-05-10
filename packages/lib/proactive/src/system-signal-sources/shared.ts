import type { SystemSignal, SystemSignalSourceOptions } from "@koi/core";

export interface AsyncEmitter {
  readonly emit: (signal: SystemSignal) => void;
}

export function createAsyncEmitter(
  handler: (signal: SystemSignal) => void,
  options: SystemSignalSourceOptions | undefined,
  now: () => number = Date.now,
  isClosed: () => boolean = () => false,
): AsyncEmitter {
  let lastDeliveredAt = -Infinity;

  return {
    emit(signal) {
      if (isClosed()) return;
      queueMicrotask(() => {
        if (isClosed()) return;
        const minGap = options?.sampleRateMs;
        if (minGap !== undefined && now() - lastDeliveredAt < minGap) return;
        handler(signal);
        lastDeliveredAt = now();
      });
    },
  };
}

export interface SubscriptionController {
  readonly closed: boolean;
  readonly unsubscribe: () => void;
}

export function createSubscriptionController(onClose: () => void): SubscriptionController {
  let closed = false;

  return {
    get closed() {
      return closed;
    },
    unsubscribe() {
      if (closed) return;
      closed = true;
      onClose();
    },
  };
}

export function safeCall<TArgs extends readonly unknown[]>(
  fn: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  fn?.(...args);
}

export function matchesAnyPathFilter(
  path: string,
  filters: readonly string[] | undefined,
): boolean {
  if (filters === undefined || filters.length === 0) return true;

  return filters.some((filter) => {
    if (filter.endsWith("*")) return path.startsWith(filter.slice(0, -1));
    return path === filter;
  });
}
