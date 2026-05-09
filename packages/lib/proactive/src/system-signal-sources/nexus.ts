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

const VALID_PROCESS_STATES: ReadonlySet<ProcessState> = new Set([
  "created",
  "running",
  "waiting",
  "suspended",
  "idle",
  "terminated",
]);

const VALID_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> =
  Object.freeze({
    created: ["running", "terminated"] as const,
    running: ["waiting", "suspended", "idle", "terminated"] as const,
    waiting: ["running", "suspended", "terminated"] as const,
    suspended: ["running", "terminated"] as const,
    idle: ["running", "terminated"] as const,
    terminated: [] as const,
  });

function isProcessState(value: string): value is ProcessState {
  return VALID_PROCESS_STATES.has(value as ProcessState);
}

function isValidTransitionPair(from: ProcessState, to: ProcessState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function isTransitionReason(value: unknown): value is TransitionReason {
  if (typeof value !== "object" || value === null) return false;

  const reason = value as Record<string, unknown>;
  if (typeof reason.kind !== "string") return false;

  switch (reason.kind) {
    case "assembly_complete":
    case "awaiting_response":
    case "response_received":
    case "hitl_pause":
    case "budget_exceeded":
    case "governance_block":
    case "human_approval":
    case "budget_replenished":
    case "completed":
    case "iteration_limit":
    case "timeout":
    case "evicted":
    case "stale":
    case "signal_stop":
    case "signal_cont":
    case "task_completed_idle":
    case "inbox_wake":
      return true;
    case "error":
      return !("cause" in reason) || reason.cause !== undefined;
    case "restarted":
      return (
        typeof reason.attempt === "number" && typeof reason.strategy === "string"
      );
    case "escalated":
      return typeof reason.cause === "string";
    default:
      return false;
  }
}

function matchesRenamePathFilter(
  from: string,
  to: string,
  filters: readonly string[] | undefined,
): boolean {
  return (
    matchesAnyPathFilter(from, filters) || matchesAnyPathFilter(to, filters)
  );
}

export function createNexusSignalSource(
  config: NexusSignalSourceConfig,
): SystemSignalSource {
  return {
    name: "nexus",
    watch(handler, options) {
      let closed = false;
      const emitter = createAsyncEmitter((signal) => {
        if (closed) return;
        handler(signal);
      }, options);
      const unsubscribeUpstream =
        config.subscribe?.(config.channels, (event) => {
          if (closed) return;

          try {
            const record = event as Record<string, unknown>;
            if (
              record.channel === "vfs" &&
              typeof record.event === "string" &&
              typeof record.emittedAt === "number" &&
              Number.isFinite(record.emittedAt)
            ) {
              if (record.event === "write" || record.event === "delete") {
                const path =
                  typeof record.path === "string" ? record.path : undefined;
                if (
                  path === undefined ||
                  !matchesAnyPathFilter(path, config.pathFilters)
                ) {
                  return;
                }

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
                if (
                  !matchesRenamePathFilter(
                    record.from,
                    record.to,
                    config.pathFilters,
                  )
                ) {
                  return;
                }

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
              isProcessState(record.from) &&
              isProcessState(record.to) &&
              isValidTransitionPair(record.from, record.to) &&
              isTransitionReason(record.reason) &&
              typeof record.generation === "number" &&
              Number.isFinite(record.generation) &&
              typeof record.emittedAt === "number"
              && Number.isFinite(record.emittedAt)
            ) {
              emitter.emit({
                kind: "agent_lifecycle",
                agentId: record.agentId,
                from: record.from,
                to: record.to,
                reason: record.reason,
                generation: record.generation,
                emittedAt: record.emittedAt,
              } satisfies SystemSignal);
            }
          } catch (error) {
            safeCall(options?.onError, error);
          }
        }) ?? (() => {});

      const subscription = createSubscriptionController(() => {
        closed = true;
        unsubscribeUpstream();
        safeCall(options?.onDisconnect);
      });

      return subscription.unsubscribe;
    },
  };
}
