/**
 * In-memory store change notifier — brick-store-specific convenience wrapper.
 *
 * Delegates to the generic `createMemoryChangeNotifier<E>` for shared logic.
 * Kept for backward compatibility — existing callers import this function.
 */

import type { StoreChangeNotifier } from "@koi/core";
import { createMemoryChangeNotifier } from "./change-notifier.js";

/**
 * Creates an in-memory `StoreChangeNotifier` for brick store mutations.
 *
 * Convenience wrapper around `createMemoryChangeNotifier<StoreChangeEvent>()`.
 */
export function createMemoryStoreChangeNotifier(): StoreChangeNotifier {
  return createMemoryChangeNotifier();
}
