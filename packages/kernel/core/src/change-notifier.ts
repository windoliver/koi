/**
 * Generic change notifier — pub/sub for mutation observation.
 *
 * Parameterized by event type so all store implementations can share
 * the same notification pattern without duplicating subscriber-cap,
 * snapshot-iteration, and idempotent-unsubscribe logic.
 *
 * Exception: pure interface definition, permitted in L0.
 */

/**
 * Generic change notifier interface.
 *
 * Sync implementations (in-memory event bus) return void from notify.
 * Async implementations (Nexus pub/sub, Redis) return Promise<void>.
 * Subscribers receive targeted change events for delta-based invalidation.
 */
export interface ChangeNotifier<E> {
  /** Emit a change event after a mutation. */
  readonly notify: (event: E) => void | Promise<void>;
  /** Subscribe to change events. Returns unsubscribe function. */
  readonly subscribe: (listener: (event: E) => void) => () => void;
}
