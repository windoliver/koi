/**
 * ConfigConsumer — contract for packages that want to re-bind when the config
 * changes at runtime.
 *
 * Contract is **best-effort, fire-and-forget**:
 * - Handlers are invoked AFTER the store has been updated. They cannot veto.
 * - Rejected promises are swallowed by the underlying ChangeNotifier;
 *   consumers that need retries or error surfacing must handle it themselves.
 * - Exceptions in one consumer do not block other consumers (enforced by
 *   createMemoryChangeNotifier's try/catch snapshot iteration).
 *
 * If a real use case emerges for consumer-side rejection (e.g. a model adapter
 * that needs to drain an in-flight stream before swapping), a follow-up PR
 * will add a separate ConfigValidator interface with an awaited pre-apply
 * phase. The current interface does not preclude that — it just doesn't
 * ship with it.
 */

import type { KoiConfig } from "@koi/core/config";

export interface ConfigChange {
  readonly prev: KoiConfig;
  readonly next: KoiConfig;
  /** Dot-paths that differ between prev and next (structural diff). */
  readonly changedPaths: readonly string[];
}

export interface ConfigConsumer {
  readonly onConfigChange: (change: ConfigChange) => void | Promise<void>;
}
