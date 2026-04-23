import type {
  Agent,
  ComponentMetadata,
  ComponentSnapshot,
  DebugEvent,
  DebugObserver,
  DebugSessionId,
  DebugSnapshot,
  EngineEvent,
  InspectComponentOptions,
  KoiError,
  Result,
  SubsystemToken,
} from "@koi/core";
import { DEFAULT_INSPECT_LIMIT } from "@koi/core";
import type { DebugController } from "./debug-middleware.js";

export interface CreateDebugObserverConfig {
  readonly agent: Agent;
  readonly controller: DebugController;
  readonly debugSessionId: DebugSessionId;
  readonly sessionId?: string | undefined;
}

export function createDebugObserver(config: CreateDebugObserverConfig): DebugObserver {
  const { agent, controller, debugSessionId } = config;
  const snapshotSessionId = config.sessionId ?? (debugSessionId as string);
  const observerId = crypto.randomUUID();

  // let justified: mutable detach flag
  let detached = false;

  const listeners = new Set<(event: DebugEvent) => void>();
  const unsubMw = controller.onDebugEvent((event) => {
    for (const listener of listeners) {
      listener(event);
    }
  });

  function buildSnapshot(tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot {
    const components = agent.components();
    const metadata: ComponentMetadata[] = [];

    for (const [key, value] of components) {
      if (tokens !== undefined && !tokens.some((t) => (t as string) === key)) {
        continue;
      }
      metadata.push({
        token: key,
        typeHint: typeof value,
        approximateBytes: estimateSize(value),
        serializable: isCloneable(value),
      });
    }

    return {
      agentId: agent.pid.id,
      sessionId: snapshotSessionId,
      debugSessionId,
      processState: agent.state,
      turnIndex: controller.turnIndex(),
      components: metadata,
      breakpoints: controller.breakpoints(),
      eventBufferSize: controller.eventBuffer().size(),
      timestamp: new Date().toISOString(),
    };
  }

  return {
    id: observerId,
    agentId: agent.pid.id,

    inspect: (tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot => {
      if (detached || !controller.isActive() || agent.state === "terminated") {
        throw new Error("Observer is revoked: the debug session has been detached");
      }
      return buildSnapshot(tokens);
    },

    inspectComponent: (
      token: SubsystemToken<unknown>,
      options?: InspectComponentOptions,
    ): Result<ComponentSnapshot, KoiError> => {
      if (detached || !controller.isActive() || agent.state === "terminated") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Observer is revoked: the debug session has been detached",
            retryable: false,
          },
        };
      }
      const value = agent.component(token);
      if (value === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Component not found: ${token as string}`,
            retryable: false,
          },
        };
      }

      const limit = options?.limit ?? DEFAULT_INSPECT_LIMIT;
      const offset = options?.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `offset and limit must be non-negative integers, got offset=${String(offset)}, limit=${String(limit)}`,
            retryable: false,
          },
        };
      }
      const paginated = paginateData(value, offset, limit);

      let snapshot: unknown;
      try {
        snapshot = structuredClone(paginated.data);
      } catch {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Component ${token as string} is not cloneable; cannot expose a safe read-only snapshot`,
            retryable: false,
          },
        };
      }

      return {
        ok: true,
        value: {
          token: token as string,
          data: snapshot,
          totalItems: paginated.totalItems,
          offset,
          limit,
          hasMore: paginated.hasMore,
        },
      };
    },

    events: (limit?: number): readonly EngineEvent[] => {
      if (detached || !controller.isActive() || agent.state === "terminated") return [];
      return controller.eventBuffer().tail(limit);
    },

    onDebugEvent: (listener: (event: DebugEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    detach: (): void => {
      if (detached) return;
      detached = true;
      unsubMw();
      listeners.clear();
    },
  };
}

/** Cheap, bounded metadata size estimate — see debug-session.ts for rationale. */
function estimateSize(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length * 8;
  if (value instanceof Map || value instanceof Set) return value.size * 16;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length * 16;
  }
  return 0;
}

/** Cheap serializability heuristic — deep check deferred to inspectComponent. */
function isCloneable(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t === "function" || t === "symbol") return false;
  return t === "object";
}

interface PaginatedResult {
  readonly data: unknown;
  readonly totalItems?: number | undefined;
  readonly hasMore: boolean;
}

function paginateData(value: unknown, offset: number, limit: number): PaginatedResult {
  if (Array.isArray(value)) {
    return {
      data: value.slice(offset, offset + limit),
      totalItems: value.length,
      hasMore: offset + limit < value.length,
    };
  }

  if (value instanceof Map) {
    const entries = [...value.entries()];
    return {
      data: Object.fromEntries(entries.slice(offset, offset + limit)),
      totalItems: entries.length,
      hasMore: offset + limit < entries.length,
    };
  }

  return { data: value, hasMore: false };
}
