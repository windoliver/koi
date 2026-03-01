/**
 * TTL-based expiry scheduler for ANS records.
 *
 * Manages per-record setTimeout timers. Each record gets its own timer
 * that fires the onExpired callback when TTL elapses.
 */

import type { ForgeScope } from "@koi/core";
import { compositeKey } from "./composite-key.js";

/** Callback invoked when a record expires. */
export type ExpiryCallback = (name: string, scope: ForgeScope) => void;

/** Expiry scheduler managing per-record TTL timers. */
export interface ExpiryScheduler {
  /** Schedule a timer for a record. Replaces any existing timer for the same key. */
  readonly schedule: (name: string, scope: ForgeScope, ttlMs: number) => void;
  /** Cancel the timer for a record. No-op if no timer exists. */
  readonly cancel: (name: string, scope: ForgeScope) => void;
  /** Clear all timers and release resources. */
  readonly dispose: () => void;
}

/**
 * Create an expiry scheduler that fires the given callback when records expire.
 *
 * @param onExpired - Called when a record's TTL elapses.
 */
export function createExpiryScheduler(onExpired: ExpiryCallback): ExpiryScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (name: string, scope: ForgeScope, ttlMs: number): void => {
    const key = compositeKey(scope, name);

    // Cancel existing timer for this key
    const existing = timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      timers.delete(key);
      onExpired(name, scope);
    }, ttlMs);

    // Unref timer so it doesn't keep the process alive
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    timers.set(key, timer);
  };

  const cancel = (name: string, scope: ForgeScope): void => {
    const key = compositeKey(scope, name);
    const existing = timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.delete(key);
    }
  };

  const dispose = (): void => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  return { schedule, cancel, dispose };
}
