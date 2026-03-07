/**
 * Agent host — registry, lifecycle, and capacity management.
 *
 * Hosts N agent ECS entities in a single event loop. Enforces maxAgents
 * admission control and provides dispatch/terminate/query operations.
 */

import type {
  Agent,
  AgentGroupId,
  AgentId,
  AgentManifest,
  ComponentProvider,
  EngineAdapter,
  KoiError,
  ProcessId,
  ProcessState,
  Result,
  SubsystemToken,
} from "@koi/core";
import { isAttachResult, RETRYABLE_DEFAULTS } from "@koi/core";
import type { CapacityReport, NodeEventListener, ResourcesConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable agent record managed by the host.
 *  state/turnCount/lastActivityMs/exitCode are intentionally mutable — this is a
 *  closure-private record, never exposed. Mutated by dispatch/signal/terminate. */
interface ManagedAgent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;
  readonly engine: EngineAdapter;
  /** Providers attached during dispatch — stored for detach on termination. */
  readonly providers: readonly ComponentProvider[];
  state: ProcessState;
  turnCount: number;
  lastActivityMs: number;
  /** Numeric exit code set on termination. Undefined while running. */
  exitCode: number | undefined;
  readonly components: Map<string, unknown>;
}

export interface AgentHost {
  /** Dispatch (create) a new agent on this node. */
  readonly dispatch: (
    pid: ProcessId,
    manifest: AgentManifest,
    engine: EngineAdapter,
    providers: readonly ComponentProvider[],
  ) => Promise<Result<Agent, KoiError>>;
  /**
   * Terminate an agent by ID with an optional numeric exit code.
   * Default exit code: 1 (generic error / external termination).
   */
  readonly terminate: (agentId: AgentId | string, exitCode?: number) => Result<void, KoiError>;
  /** Get an agent by ID. */
  readonly get: (agentId: AgentId | string) => Agent | undefined;
  /** List all hosted agents. */
  readonly list: () => readonly Agent[];
  /** Iterate agents without allocating a snapshot array. */
  readonly agents: () => IterableIterator<Agent>;
  /** Return the least-recently-active agent (for eviction). */
  readonly leastActive: () => Agent | undefined;
  /** Current capacity report. */
  readonly capacity: () => CapacityReport;
  /** Register an event listener. */
  readonly onEvent: (listener: NodeEventListener) => () => void;
  /** Terminate all agents (used during shutdown). */
  readonly terminateAll: () => void;
  /**
   * Send a POSIX-style signal to a single agent.
   * stop → suspended at next turn boundary  (idempotent)
   * cont → running from suspended             (idempotent)
   * term → abort + gracePeriodMs + terminate  (exit code 130)
   * usr1/usr2 → emit event only, no state change
   */
  readonly signal: (
    agentId: AgentId | string,
    signal: string,
    gracePeriodMs?: number,
  ) => Promise<Result<void, KoiError>>;
  /**
   * Broadcast a signal to all agents belonging to a process group.
   * Uses Promise.allSettled() — one failure does not block others.
   * Rejects with "signalGroup timeout" if deadlineMs is exceeded.
   */
  readonly signalGroup: (
    groupId: AgentGroupId | string,
    signal: string,
    options?: { readonly deadlineMs?: number },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent snapshot (immutable view)
// ---------------------------------------------------------------------------

/**
 * Creates an immutable Agent snapshot from a ManagedAgent.
 * Captures state at creation time — the snapshot does not track later mutations.
 * Component lookups still reference the live components map (intentional: components
 * are structurally stable after dispatch, only state/turnCount change).
 */
function toAgentSnapshot(managed: ManagedAgent): Agent {
  const componentMap: ReadonlyMap<string, unknown> = managed.components;
  // Capture state at snapshot time — prevents stale reads
  const capturedState = managed.state;

  return {
    pid: managed.pid,
    manifest: managed.manifest,
    state: capturedState,
    // SubsystemToken<T> is a branded string — casts mirror L0's token() factory
    component<T>(token: SubsystemToken<T>): T | undefined {
      return managed.components.get(token as string) as T | undefined;
    },
    has(token: SubsystemToken<unknown>): boolean {
      return managed.components.has(token as string);
    },
    hasAll(...tokens: readonly SubsystemToken<unknown>[]): boolean {
      return tokens.every((t) => managed.components.has(t as string));
    },
    query<T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of managed.components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components(): ReadonlyMap<string, unknown> {
      return componentMap;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentHost(config: ResourcesConfig): AgentHost {
  const agents = new Map<string, ManagedAgent>();
  const eventListeners = new Set<NodeEventListener>();

  function emit(type: Parameters<NodeEventListener>[0]["type"], data?: unknown): void {
    const event = { type, timestamp: Date.now(), data };
    for (const listener of eventListeners) {
      listener(event);
    }
  }

  async function signalOne(
    agentId: string,
    sig: string,
    gracePeriodMs: number,
  ): Promise<Result<void, KoiError>> {
    const managed = agents.get(agentId);
    if (managed === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent not found: ${agentId}`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { agentId },
        },
      };
    }

    switch (sig) {
      case "stop": {
        if (managed.state === "suspended") break; // idempotent
        managed.state = "suspended";
        managed.lastActivityMs = Date.now();
        emit("agent_suspended", { agentId });
        break;
      }
      case "cont": {
        if (managed.state !== "suspended") break; // idempotent
        managed.state = "running";
        managed.lastActivityMs = Date.now();
        emit("agent_resumed", { agentId });
        break;
      }
      case "term": {
        // Abort engine adapter, wait grace period, then force-terminate
        void managed.engine.dispose?.().catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs));
        // Re-check: may have been cleaned up already during grace period
        if (agents.has(agentId)) {
          managed.state = "terminated";
          managed.exitCode = 130; // POSIX convention: 128 + signal index
          // Detach component providers — best-effort, fire-and-forget
          const detachSnapshot = toAgentSnapshot(managed);
          for (const provider of managed.providers) {
            void provider.detach?.(detachSnapshot)?.catch(() => {});
          }
          agents.delete(agentId);
          emit("agent_terminated", { agentId, exitCode: 130 });
        }
        break;
      }
      case "usr1":
      case "usr2": {
        // Application-defined: emit event only, no state change
        emit("agent_dispatched", { agentId, signal: sig });
        break;
      }
      default:
        break;
    }

    return { ok: true, value: undefined };
  }

  return {
    async dispatch(pid, manifest, engine, providers) {
      if (agents.size >= config.maxAgents) {
        return {
          ok: false,
          error: {
            code: "RATE_LIMIT",
            message: `Node at capacity: ${agents.size}/${config.maxAgents} agents`,
            retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
            context: { current: agents.size, max: config.maxAgents },
          },
        };
      }

      if (agents.has(pid.id)) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Agent already exists: ${pid.id}`,
            retryable: RETRYABLE_DEFAULTS.CONFLICT,
            context: { agentId: pid.id },
          },
        };
      }

      const managed: ManagedAgent = {
        pid,
        manifest,
        engine,
        providers,
        state: "created",
        turnCount: 0,
        lastActivityMs: Date.now(),
        exitCode: undefined,
        components: new Map(),
      };

      // Attach components from providers (async — providers may perform I/O).
      // On failure, rollback any already-attached providers then return error.
      const snapshot = toAgentSnapshot(managed);
      const attached: ComponentProvider[] = [];
      for (const provider of providers) {
        try {
          const result = await provider.attach(snapshot);
          attached.push(provider);
          const components = isAttachResult(result) ? result.components : result;
          for (const [key, value] of components) {
            managed.components.set(key, value);
          }
        } catch (e: unknown) {
          // Rollback: detach any providers that already attached successfully
          for (const prev of attached) {
            try {
              await prev.detach?.(snapshot);
            } catch (_detachErr: unknown) {
              // Best-effort cleanup — detach failure must not mask the original error
            }
          }
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: `Provider "${provider.name}" failed to attach: ${e instanceof Error ? e.message : String(e)}`,
              retryable: RETRYABLE_DEFAULTS.INTERNAL,
              context: { agentId: pid.id, provider: provider.name },
            },
          };
        }
      }

      managed.state = "running";
      agents.set(pid.id, managed);
      emit("agent_dispatched", { agentId: pid.id, name: pid.name });

      return { ok: true, value: toAgentSnapshot(managed) };
    },

    terminate(agentId, exitCode = 1) {
      const managed = agents.get(agentId);
      if (managed === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Agent not found: ${agentId}`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
            context: { agentId },
          },
        };
      }

      managed.state = "terminated";
      managed.exitCode = exitCode;
      agents.delete(agentId);

      // Detach component providers — best-effort, fire-and-forget
      const detachSnapshot = toAgentSnapshot(managed);
      for (const provider of managed.providers) {
        void provider.detach?.(detachSnapshot)?.catch(() => {});
      }

      // Dispose engine adapter if supported
      void managed.engine.dispose?.().catch(() => {
        // Best-effort cleanup — engine disposal is not critical
      });

      emit("agent_terminated", { agentId, exitCode });
      return { ok: true, value: undefined };
    },

    signal(agentId, sig, gracePeriodMs = 5_000) {
      return signalOne(agentId, sig, gracePeriodMs);
    },

    async signalGroup(groupId, sig, options) {
      const deadlineMs = options?.deadlineMs ?? 5_000;
      const matching: string[] = [];

      for (const [id, managed] of agents) {
        if (managed.pid.groupId === groupId && managed.state !== "terminated") {
          matching.push(id);
        }
      }

      if (matching.length === 0) return;

      const ops = matching.map((id) => signalOne(id, sig, 5_000));

      await Promise.race([
        Promise.allSettled(ops),
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error("signalGroup timeout")), deadlineMs),
        ),
      ]);
    },

    get(agentId) {
      const managed = agents.get(agentId);
      return managed !== undefined ? toAgentSnapshot(managed) : undefined;
    },

    list() {
      return [...agents.values()].map(toAgentSnapshot);
    },

    *agents() {
      for (const managed of agents.values()) {
        yield toAgentSnapshot(managed);
      }
    },

    leastActive() {
      let oldest: ManagedAgent | undefined;
      for (const managed of agents.values()) {
        if (oldest === undefined || managed.lastActivityMs < oldest.lastActivityMs) {
          oldest = managed;
        }
      }
      return oldest !== undefined ? toAgentSnapshot(oldest) : undefined;
    },

    capacity() {
      return {
        current: agents.size,
        max: config.maxAgents,
        available: Math.max(0, config.maxAgents - agents.size),
      };
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    terminateAll() {
      for (const [agentId, managed] of agents) {
        managed.state = "terminated";

        // Detach component providers — best-effort, fire-and-forget
        const detachSnapshot = toAgentSnapshot(managed);
        for (const provider of managed.providers) {
          void provider.detach?.(detachSnapshot)?.catch(() => {});
        }

        void managed.engine.dispose?.().catch(() => {});
        emit("agent_terminated", { agentId });
      }
      agents.clear();
    },
  };
}
