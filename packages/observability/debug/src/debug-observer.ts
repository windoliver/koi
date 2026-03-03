/**
 * DebugObserver — read-only observer that shares the debug session's event buffer.
 *
 * Multiple observers can attach simultaneously.
 */

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CreateDebugObserverConfig {
  readonly agent: Agent;
  readonly controller: DebugController;
  readonly debugSessionId: DebugSessionId;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a read-only debug observer. */
export function createDebugObserver(config: CreateDebugObserverConfig): DebugObserver {
  const { agent, controller, debugSessionId } = config;
  const observerId = crypto.randomUUID();

  // let justified: mutable detach flag
  let detached = false;

  const listeners = new Set<(event: DebugEvent) => void>();
  const unsubMw = controller.onDebugEvent((event) => {
    for (const listener of listeners) {
      listener(event);
    }
  });

  return {
    id: observerId,
    agentId: agent.pid.id,

    inspect: (tokens?: readonly SubsystemToken<unknown>[]): DebugSnapshot => {
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
        sessionId: "",
        debugSessionId,
        processState: agent.state,
        turnIndex: controller.turnIndex(),
        components: metadata,
        breakpoints: controller.breakpoints(),
        eventBufferSize: controller.eventBuffer().size(),
        timestamp: new Date().toISOString(),
      };
    },

    inspectComponent: (
      token: SubsystemToken<unknown>,
      options?: InspectComponentOptions,
    ): Result<ComponentSnapshot, KoiError> => {
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

      return {
        ok: true,
        value: {
          token: token as string,
          data: value,
          offset,
          limit,
          hasMore: false,
        },
      };
    },

    events: (limit?: number): readonly EngineEvent[] => {
      return controller.eventBuffer().tail(limit);
    },

    onDebugEvent: (listener: (event: DebugEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    detach: () => {
      if (detached) return;
      detached = true;
      unsubMw();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
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
