/**
 * Checkpoint manager — event-driven session persistence for crash recovery.
 *
 * Subscribes to agent host events and saves/removes session records
 * and engine state checkpoints to a pluggable `NodeSessionStore`.
 *
 * Checkpoint triggers:
 *   - `agent_dispatched` → save initial SessionRecord
 *   - `checkpointAgent(agentId)` → engine.saveState() → store.saveCheckpoint()
 *   - `agent_terminated` → removeSession (clears record + checkpoints)
 *
 * Recovery:
 *   - `recover()` loads all sessions + latest checkpoints from the store
 */

import type {
  AgentId,
  EngineAdapter,
  KoiError,
  RecoveryPlan,
  Result,
  SessionCheckpoint,
  SessionRecord,
} from "@koi/core";
import { internal, agentId as toAgentId } from "@koi/core";
import type { AgentHost } from "./agent/host.js";
import type { FrameCounters } from "./frame-counter.js";
import type { NodeSessionStore } from "./types.js";
import type { WriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CheckpointManager {
  /** Save an engine state checkpoint for the given agent. */
  readonly checkpointAgent: (
    agentId: AgentId | string,
    sessionId: string,
  ) => Promise<Result<void, KoiError>>;
  /** Look up the session ID for a given agent. */
  readonly getSessionId: (agentId: string) => string | undefined;
  /** Load recovery plan from the store. */
  readonly recover: () => Promise<Result<RecoveryPlan, KoiError>>;
  /** Flush any pending writes (no-op when write queue is absent). */
  readonly flush: () => Promise<void>;
  /** Stop listening to host events. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Optional dependencies for checkpoint manager. */
export interface CheckpointManagerDeps {
  readonly frameCounters?: FrameCounters;
  readonly writeQueue?: WriteQueue;
  /** Emit a node event. Used to surface fire-and-forget store errors. */
  readonly emit?: (type: string, data?: unknown) => void;
}

/**
 * Create a checkpoint manager wired to the agent host and session store.
 *
 * The manager subscribes to host events automatically. Call `dispose()` to
 * unsubscribe when the node shuts down.
 */
export function createCheckpointManager(
  store: NodeSessionStore,
  host: AgentHost,
  getEngine: (agentId: string) => EngineAdapter | undefined,
  deps?: CheckpointManagerDeps,
): CheckpointManager {
  // In-memory session records — avoids needing loadSession on NodeSessionStore
  const sessionRecords = new Map<string, SessionRecord>();

  // Generation counter per agent (CAS)
  const generations = new Map<string, number>();

  // Subscribe to host lifecycle events
  const unsubHost = host.onEvent((event) => {
    if (event.type === "agent_dispatched") {
      const data = event.data as { agentId: string; name: string } | undefined;
      if (data === undefined) return;

      const aid = toAgentId(data.agentId);
      const agent = host.get(aid);
      if (agent === undefined) return;

      // Generate a session ID and save the initial record
      const sessionId = `session-${data.agentId}-${String(Date.now())}`;
      generations.set(data.agentId, 0);

      const counters = deps?.frameCounters?.get(data.agentId);
      const record: SessionRecord = {
        sessionId,
        agentId: aid,
        manifestSnapshot: agent.manifest,
        seq: counters?.seq ?? 0,
        remoteSeq: counters?.remoteSeq ?? 0,
        connectedAt: Date.now(),
        lastCheckpointAt: Date.now(),
        metadata: {},
      };

      sessionRecords.set(data.agentId, record);
      Promise.resolve(store.saveSession(record))
        .then((r) => {
          if (!r.ok) {
            deps?.emit?.("agent_crashed", {
              agentId: data.agentId,
              error: r.error.message,
              operation: "saveSession",
            });
          }
        })
        .catch(() => {
          /* swallowed — best-effort persistence */
        });
    }

    if (event.type === "agent_terminated") {
      const data = event.data as { agentId: string } | undefined;
      if (data === undefined) return;

      const record = sessionRecords.get(data.agentId);
      if (record !== undefined) {
        Promise.resolve(store.removeSession(record.sessionId))
          .then((r) => {
            if (!r.ok) {
              deps?.emit?.("agent_crashed", {
                agentId: data.agentId,
                error: r.error.message,
                operation: "removeSession",
              });
            }
          })
          .catch(() => {
            /* swallowed — best-effort persistence */
          });
        sessionRecords.delete(data.agentId);
        generations.delete(data.agentId);
      }
    }
  });

  return {
    async checkpointAgent(
      aid: AgentId | string,
      sessionId: string,
    ): Promise<Result<void, KoiError>> {
      const agentIdStr = String(aid);
      const engine = getEngine(agentIdStr);
      if (engine === undefined) {
        return {
          ok: false,
          error: internal(`No engine found for agent: ${agentIdStr}`),
        };
      }

      if (engine.saveState === undefined) {
        return {
          ok: false,
          error: internal(`Engine does not support saveState: ${agentIdStr}`),
        };
      }

      try {
        const engineState = await engine.saveState();
        const agent = host.get(aid);
        const gen = (generations.get(agentIdStr) ?? 0) + 1;
        generations.set(agentIdStr, gen);

        // Update session record cursors from frame counters
        const counters = deps?.frameCounters?.get(agentIdStr);
        const existing = sessionRecords.get(agentIdStr);
        if (counters !== undefined && existing !== undefined) {
          const updated: SessionRecord = {
            ...existing,
            seq: counters.seq,
            remoteSeq: counters.remoteSeq,
            lastCheckpointAt: Date.now(),
          };
          sessionRecords.set(agentIdStr, updated);
          Promise.resolve(store.saveSession(updated))
            .then((r) => {
              if (!r.ok) {
                deps?.emit?.("agent_crashed", {
                  agentId: agentIdStr,
                  error: r.error.message,
                  operation: "saveSession",
                });
              }
            })
            .catch(() => {
              /* swallowed — best-effort persistence */
            });
        }

        const checkpoint: SessionCheckpoint = {
          id: `cp-${agentIdStr}-${String(gen)}`,
          agentId: toAgentId(agentIdStr),
          sessionId,
          engineState,
          processState: agent?.state ?? "running",
          generation: gen,
          metadata: {},
          createdAt: Date.now(),
        };

        // Use write queue for batched writes when available
        if (deps?.writeQueue !== undefined) {
          deps.writeQueue.enqueue(agentIdStr, checkpoint);
          return { ok: true, value: undefined };
        }

        return await store.saveCheckpoint(checkpoint);
      } catch (e: unknown) {
        return {
          ok: false,
          error: internal(`Failed to checkpoint agent: ${agentIdStr}`, e),
        };
      }
    },

    getSessionId(agentIdStr: string): string | undefined {
      return sessionRecords.get(agentIdStr)?.sessionId;
    },

    async recover(): Promise<Result<RecoveryPlan, KoiError>> {
      return await store.recover();
    },

    async flush(): Promise<void> {
      if (deps?.writeQueue !== undefined) {
        await deps.writeQueue.flush();
      }
    },

    dispose(): void {
      unsubHost();
    },
  };
}
