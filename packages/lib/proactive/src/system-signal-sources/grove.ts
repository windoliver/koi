import type { SystemSignal, SystemSignalSource } from "@koi/core";
import { createAsyncEmitter, createSubscriptionController, safeCall } from "./shared.js";

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
  /** Override for the emittedAt timestamp source. Defaults to Date.now. */
  readonly now?: (() => number) | undefined;
}

export function shouldAcceptGroveFrontierEvent(
  metric: string | undefined,
  improvement: number | undefined,
  config: Pick<GroveSignalSourceConfig, "metrics" | "minImprovement">,
): boolean {
  if (metric === undefined) return false;
  if (improvement !== undefined && !Number.isFinite(improvement)) return false;
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

function parseGroveFrontierSignal(
  rawData: string,
  config: GroveSignalSourceConfig,
  now: () => number,
): SystemSignal | undefined {
  const payload = JSON.parse(rawData) as Record<string, unknown>;
  if (payload.type !== "frontier_changed") return undefined;

  const metric = typeof payload.metric === "string" ? payload.metric : undefined;
  const improvement = typeof payload.improvement === "number" ? payload.improvement : undefined;

  if (!shouldAcceptGroveFrontierEvent(metric, improvement, config)) return undefined;

  const upstreamEmittedAt =
    typeof payload.emittedAt === "number" && Number.isFinite(payload.emittedAt)
      ? payload.emittedAt
      : undefined;

  return {
    kind: "frontier",
    metric: metric as string,
    improvement,
    emittedAt: upstreamEmittedAt ?? now(),
  } satisfies SystemSignal;
}

export function createGroveSignalSource(config: GroveSignalSourceConfig): SystemSignalSource {
  return {
    name: "grove",
    watch(handler, options) {
      let closed = false;
      const isClosed = (): boolean => closed;
      const emitter = createAsyncEmitter(
        createClosedAwareGroveHandler(handler, isClosed),
        options,
        Date.now,
        isClosed,
      );
      const eventSource = config.eventSourceFactory?.(config.groveUrl);
      if (eventSource === undefined) return () => {};

      const now = config.now ?? Date.now;

      eventSource.onmessage = (event) => {
        if (closed) return;
        try {
          const signal = parseGroveFrontierSignal(event.data, config, now);
          if (signal !== undefined) emitter.emit(signal);
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
