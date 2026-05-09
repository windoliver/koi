import type {
  ProcessState,
  SystemSignal,
  SystemSignalSource,
  TransitionReason,
} from "@koi/core";
import {
  createAsyncEmitter,
  createSubscriptionController,
  matchesAnyPathFilter,
  safeCall,
} from "./shared.js";

export type NexusSubscribeFn = (
  channels: readonly string[] | undefined,
  listener: (event: unknown) => void,
) => () => void;

export interface NexusSignalSourceConfig {
  readonly nexusUrl?: string | undefined;
  readonly channels?: readonly string[] | undefined;
  readonly pathFilters?: readonly string[] | undefined;
  readonly subscribe?: NexusSubscribeFn | undefined;
}

export function createNexusSignalSource(
  config: NexusSignalSourceConfig,
): SystemSignalSource {
  return {
    name: "nexus",
    watch(handler, options) {
      const emitter = createAsyncEmitter(handler, options);
      const unsubscribeUpstream =
        config.subscribe?.(config.channels, (event) => {
          try {
            const record = event as Record<string, unknown>;
            if (
              record.channel === "vfs" &&
              typeof record.event === "string" &&
              typeof record.emittedAt === "number"
            ) {
              const path = typeof record.path === "string" ? record.path : undefined;
              if (path === undefined || !matchesAnyPathFilter(path, config.pathFilters)) {
                return;
              }

              if (record.event === "write" || record.event === "delete") {
                emitter.emit({
                  kind: "vfs",
                  event: record.event,
                  path,
                  zoneId:
                    typeof record.zoneId === "string" ? record.zoneId : undefined,
                  emittedAt: record.emittedAt,
                } satisfies SystemSignal);
              }

              if (
                record.event === "rename" &&
                typeof record.from === "string" &&
                typeof record.to === "string"
              ) {
                emitter.emit({
                  kind: "vfs",
                  event: "rename",
                  path: record.from,
                  from: record.from,
                  to: record.to,
                  zoneId:
                    typeof record.zoneId === "string" ? record.zoneId : undefined,
                  emittedAt: record.emittedAt,
                } satisfies SystemSignal);
              }

              return;
            }

            if (
              record.channel === "agent" &&
              record.event === "transition" &&
              typeof record.agentId === "string" &&
              typeof record.from === "string" &&
              typeof record.to === "string" &&
              typeof record.reason === "string" &&
              typeof record.generation === "number" &&
              typeof record.emittedAt === "number"
            ) {
              emitter.emit({
                kind: "agent_lifecycle",
                agentId: record.agentId,
                from: record.from as ProcessState,
                to: record.to as ProcessState,
                reason: record.reason as TransitionReason,
                generation: record.generation,
                emittedAt: record.emittedAt,
              } satisfies SystemSignal);
            }
          } catch (error) {
            safeCall(options?.onError, error);
          }
        }) ?? (() => {});

      const subscription = createSubscriptionController(() => {
        unsubscribeUpstream();
        safeCall(options?.onDisconnect);
      });

      return subscription.unsubscribe;
    },
  };
}
