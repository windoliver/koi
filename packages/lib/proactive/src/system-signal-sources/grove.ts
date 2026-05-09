import type { SystemSignalSource } from "@koi/core";
import {
  createAsyncEmitter,
  createSubscriptionController,
  safeCall,
} from "./shared.js";

export interface GroveEventSourceLike {
  close: () => void;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface GroveSignalSourceConfig {
  readonly groveUrl: string;
  readonly metrics?: readonly string[] | undefined;
  readonly minImprovement?: number | undefined;
  readonly eventSourceFactory?: ((url: string) => GroveEventSourceLike) | undefined;
}

export function shouldAcceptGroveFrontierEvent(
  metric: string | undefined,
  improvement: number | undefined,
  config: Pick<GroveSignalSourceConfig, "metrics" | "minImprovement">,
): boolean {
  if (metric === undefined) return false;
  if (config.metrics !== undefined && !config.metrics.includes(metric)) return false;
  if (
    config.minImprovement !== undefined &&
    (improvement === undefined || improvement < config.minImprovement)
  ) {
    return false;
  }

  return true;
}

export function createClosedAwareGroveHandler<T>(
  handler: (value: T) => void,
  isClosed: () => boolean,
): (value: T) => void {
  return (value) => {
    if (isClosed()) return;
    handler(value);
  };
}

export function createGroveSignalSource(
  config: GroveSignalSourceConfig,
): SystemSignalSource {
  return {
    name: "grove",
    watch(handler, options) {
      let closed = false;
      const emitter = createAsyncEmitter(
        createClosedAwareGroveHandler(handler, () => closed),
        options,
      );
      const eventSource = config.eventSourceFactory?.(config.groveUrl);
      if (eventSource === undefined) return () => {};

      eventSource.onmessage = (event) => {
        if (closed) return;

        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>;
          if (payload.type !== "frontier_changed") return;

          const metric =
            typeof payload.metric === "string" ? payload.metric : undefined;
          const improvement =
            typeof payload.improvement === "number"
              ? payload.improvement
              : undefined;

          if (!shouldAcceptGroveFrontierEvent(metric, improvement, config)) {
            return;
          }

          // Grove frontier updates are not representable in the current SystemSignal contract.
          void emitter;
        } catch (error) {
          safeCall(options?.onError, error);
        }
      };

      eventSource.onerror = (error) => {
        if (closed) return;
        safeCall(options?.onError, error);
      };

      const subscription = createSubscriptionController(() => {
        closed = true;
        eventSource.close();
        safeCall(options?.onDisconnect);
      });

      return subscription.unsubscribe;
    },
  };
}
