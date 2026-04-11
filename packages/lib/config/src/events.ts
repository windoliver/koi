/**
 * Config reload event bus — discriminated union carrying the lifecycle of
 * each reload attempt.
 *
 * Event ordering for a successful reload:
 *   attempted -> (store.set happens) -> applied -> changed
 *
 * For a rejected reload:
 *   attempted -> rejected
 *
 * `applied` and `changed` carry the same payload today. The split is
 * intentional: telemetry sinks subscribe to `attempted`/`applied`/`rejected`
 * for observability, while feature consumers subscribe to `changed` via
 * `ConfigManager.registerConsumer`.
 */

import type { ChangeNotifier, KoiError } from "@koi/core";
import type { KoiConfig } from "@koi/core/config";
import { createMemoryChangeNotifier } from "@koi/validation";

export type ConfigRejectReason = "load" | "validation" | "restart-required";

export type ConfigReloadEvent =
  | {
      readonly kind: "attempted";
      readonly filePath: string;
    }
  | {
      readonly kind: "applied";
      readonly filePath: string;
      readonly prev: KoiConfig;
      readonly next: KoiConfig;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly kind: "rejected";
      readonly filePath: string;
      readonly reason: ConfigRejectReason;
      readonly error: KoiError;
      readonly restartRequiredPaths?: readonly string[];
    }
  | {
      readonly kind: "changed";
      readonly filePath: string;
      readonly prev: KoiConfig;
      readonly next: KoiConfig;
      readonly changedPaths: readonly string[];
    };

/**
 * Creates a typed event bus over the generic ChangeNotifier primitive.
 * Each ConfigManager owns one bus instance.
 */
export function createConfigEventBus(): ChangeNotifier<ConfigReloadEvent> {
  return createMemoryChangeNotifier<ConfigReloadEvent>();
}
