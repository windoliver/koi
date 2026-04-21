/**
 * Bridges a live `Supervisor` into an `AgentRegistry` — the companion to
 * `attachRegistry` (which bridges to `BackgroundSessionRegistry`). When a
 * supervised child agent runs in a subprocess, the parent's reconciler can
 * only see it via AgentRegistry entries; this bridge translates OS-level
 * `WorkerEvent`s into `AgentRegistry` phase transitions so the reconciler's
 * level-triggered loop observes subprocess lifecycle like any in-process child.
 *
 * Mapping:
 *   - `started`   → transition to "running"       (reason: assembly_complete)
 *   - `exited`    → transition to "terminated"    (reason: completed on code=0, error otherwise)
 *   - `crashed`   → transition to "terminated"    (reason: error)
 *   - `heartbeat` → no-op (observability only)
 *
 * Ownership: the caller registers the `AgentRegistry` entry AND declares the
 * `workerId → agentId` mapping via `mapWorker()` BEFORE `supervisor.start()`.
 * Events for unmapped workerIds are ignored — this keeps the bridge usable
 * alongside other consumers of `watchAll()` that may spawn non-supervised
 * workers (operator-driven `koi bg` sessions).
 */

import type { AgentId, AgentRegistry, RegistryEntry, TransitionReason } from "@koi/core";
import type { Supervisor, WorkerEvent, WorkerId } from "@koi/core/daemon";
import type { KoiError } from "@koi/core/errors";

export interface AgentRegistryBridge {
  /**
   * Declare that subsequent `WorkerEvent`s for `workerId` should be mirrored
   * onto `agentId` in the registry. Idempotent; a second call with the same
   * workerId replaces the prior mapping (supports restart-under-new-agentId).
   */
  readonly mapWorker: (workerId: WorkerId, agentId: AgentId) => void;
  /** Forget a mapping. Events after this are ignored for that workerId. */
  readonly unmapWorker: (workerId: WorkerId) => void;
  /** Stop the bridge and release the watchAll iterator. */
  readonly close: () => Promise<void>;
  /** Resolves after the internal loop drains. */
  readonly done: Promise<void>;
  /** Last non-fatal error observed during event processing. */
  readonly lastError: () => KoiError | undefined;
}

export interface AttachAgentRegistryConfig {
  readonly supervisor: Supervisor;
  readonly agentRegistry: AgentRegistry;
  /**
   * Invoked on every transition failure. Defaults to no-op. The bridge never
   * throws — errors surface via the callback and `lastError()`.
   */
  readonly onError?: (error: KoiError, event: WorkerEvent) => void;
  /**
   * Maximum drain window on close(). Matches `attachRegistry`'s default so
   * shutdown semantics are symmetric across the two bridges.
   */
  readonly drainTimeoutMs?: number;
}

export function attachAgentRegistry(config: AttachAgentRegistryConfig): AgentRegistryBridge {
  const { supervisor, agentRegistry, onError } = config;
  const drainTimeoutMs = config.drainTimeoutMs ?? 2000;

  const mapping: Map<WorkerId, AgentId> = new Map();
  let lastErr: KoiError | undefined;
  let closing = false;
  let drainDeadline = 0;

  const transition = async (
    agentId: AgentId,
    target: "running" | "terminated",
    reason: TransitionReason,
    event: WorkerEvent,
  ): Promise<void> => {
    const entry = await agentRegistry.lookup(agentId);
    if (entry === undefined) {
      // Caller never registered the agent (or deregistered it already).
      // Surface as a non-fatal error — swallowing would hide real bugs
      // (typo in agentId, register/map race).
      const err: KoiError = {
        code: "NOT_FOUND",
        message: `agent-registry bridge: no agent ${agentId} to transition → ${target}`,
        retryable: false,
      };
      lastErr = err;
      if (onError !== undefined) onError(err, event);
      return;
    }
    // Skip no-op transitions: if the child is already terminated (e.g. the
    // reconciler deregistered it and re-registered under a new id), a
    // second `terminated` write is wasted work and would fail CAS anyway.
    if (entry.status.phase === target) return;
    const result = await agentRegistry.transition(agentId, target, entry.status.generation, reason);
    if (!result.ok) {
      lastErr = result.error;
      if (onError !== undefined) onError(result.error, event);
    }
  };

  const handle = async (event: WorkerEvent): Promise<void> => {
    const agentId = mapping.get(event.workerId);
    if (agentId === undefined) return;
    switch (event.kind) {
      case "started":
        await transition(agentId, "running", { kind: "assembly_complete" }, event);
        return;
      case "exited": {
        const reason: TransitionReason =
          event.code === 0 ? { kind: "completed" } : { kind: "error", cause: event.code };
        await transition(agentId, "terminated", reason, event);
        // One-shot: terminal state ends the mapping's usefulness. The
        // reconciler will re-register under a FRESH agentId on restart
        // (see createDaemonSpawnChildFn), so drop this one.
        mapping.delete(event.workerId);
        return;
      }
      case "crashed":
        await transition(agentId, "terminated", { kind: "error", cause: event.error }, event);
        mapping.delete(event.workerId);
        return;
      case "heartbeat":
        return;
    }
  };

  // watchAll race pattern mirrors registry-supervisor-bridge: the supervisor
  // parks on a waker, so we race next() against a `closed` sentinel and
  // switch to bounded-drain mode after close().
  const iterator = supervisor.watchAll()[Symbol.asyncIterator]();
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<"closed">((resolve) => {
    resolveClosed = () => resolve("closed");
  });

  let pendingNext: Promise<IteratorResult<WorkerEvent>> | undefined;
  const getNext = (): Promise<IteratorResult<WorkerEvent>> => {
    if (pendingNext === undefined) pendingNext = iterator.next();
    return pendingNext;
  };
  const consumeNext = (): void => {
    pendingNext = undefined;
  };

  const loop = async (): Promise<void> => {
    while (true) {
      if (closing) {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutP = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), remaining);
        });
        const race = await Promise.race([getNext(), timeoutP]);
        if (timer !== undefined) clearTimeout(timer);
        if (race === "deadline") return;
        consumeNext();
        if (race.done) return;
        await handle(race.value);
        continue;
      }
      const result = await Promise.race([getNext(), closed]);
      if (result === "closed") {
        closing = true;
        continue;
      }
      consumeNext();
      if (result.done) return;
      await handle(result.value);
    }
  };

  const done = loop().catch((e: unknown) => {
    lastErr = {
      code: "INTERNAL",
      message: `agent-registry bridge terminated: ${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    };
  });

  return {
    mapWorker: (workerId, agentId) => {
      mapping.set(workerId, agentId);
    },
    unmapWorker: (workerId) => {
      mapping.delete(workerId);
    },
    close: async (): Promise<void> => {
      drainDeadline = Date.now() + drainTimeoutMs;
      resolveClosed?.();
      const hardTimeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), drainTimeoutMs + 500),
      );
      const outcome = await Promise.race([done.then(() => "drained" as const), hardTimeout]);
      if (outcome === "timeout") {
        lastErr = {
          code: "TIMEOUT",
          message: `agent-registry bridge drain exceeded ${drainTimeoutMs}ms`,
          retryable: false,
        };
      }
      void iterator.return?.().catch(() => {});
    },
    done,
    lastError: () => lastErr,
  };
}

// Re-export the entry type so callers importing `RegistryEntry` from @koi/core
// don't need a second import path when they read back mirrored entries.
export type { RegistryEntry };
