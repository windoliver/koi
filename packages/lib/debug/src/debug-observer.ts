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
        serializable: isSerializable(value),
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
      if (detached || !controller.isActive()) {
        throw new Error("Observer is revoked: the debug session has been detached");
      }
      return buildSnapshot(tokens);
    },

    inspectComponent: (
      token: SubsystemToken<unknown>,
      options?: InspectComponentOptions,
    ): Result<ComponentSnapshot, KoiError> => {
      if (detached || !controller.isActive()) {
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
      const paginated = paginateData(value, offset, limit);

      let snapshot: unknown;
      try {
        snapshot = JSON.parse(JSON.stringify(paginated.data));
      } catch {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Component ${token as string} is not serializable; cannot expose a safe read-only snapshot`,
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
      if (detached || !controller.isActive()) return [];
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

function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
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
