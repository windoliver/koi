/**
 * DeliveryManager — retry lifecycle for pending outbound frames.
 *
 * Loads pending frames from the session store, checks TTL/max-retries,
 * attempts delivery via transport, and schedules retries with exponential
 * backoff when transport is unavailable.
 */

import type { PendingFrame } from "@koi/core";
import { agentId as toAgentId } from "@koi/core";
import type { NodeEvent, NodeFrame, NodeSessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DeliveryManagerConfig {
  /** Maximum delivery attempts before dead-lettering. Default: 5. */
  readonly maxRetries: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  readonly baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 30000. */
  readonly maxDelayMs: number;
  /** Backoff multiplier. Default: 2. */
  readonly multiplier: number;
  /** Jitter factor (0–1). Default: 0.1. */
  readonly jitter: number;
  /**
   * Maximum time in ms to spend replaying frames per call.
   * Remaining frames stay in the store for the next replay cycle.
   * 0 = no limit. Default: 60000 (60s).
   */
  readonly maxRecoveryMs: number;
}

export const DELIVERY_DEFAULTS: DeliveryManagerConfig = {
  maxRetries: 5, // ~63s total retry window (1+2+4+8+16+30...)
  baseDelayMs: 1_000, // matches reconnect backoff
  maxDelayMs: 30_000, // cap to avoid indefinite waits
  multiplier: 2,
  jitter: 0.1, // ±10% to prevent thundering herd
  maxRecoveryMs: 60_000, // 60s budget per replay call; remainder deferred
} as const;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DeliveryManager {
  /** Replay all pending frames for a session with retry/backoff. */
  readonly replayPendingFrames: (sessionId: string) => Promise<void>;
  /** Persist an outbound frame (write-ahead) and send if connected. */
  readonly enqueueSend: (frame: NodeFrame, sessionId: string) => Promise<void>;
  /** Cancel all pending retry timers and release resources. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DeliveryManagerDeps {
  readonly store: NodeSessionStore;
  /** Returns true when the transport is connected and can send. */
  readonly isConnected: () => boolean;
  /** Send a pending frame over the transport. */
  readonly sendFrame: (frame: PendingFrame) => void;
  /** Emit a node event. */
  readonly emit: (type: NodeEvent["type"], data?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

function calculateBackoffDelay(retryCount: number, config: DeliveryManagerConfig): number {
  const exponential = Math.min(
    config.baseDelayMs * config.multiplier ** retryCount,
    config.maxDelayMs,
  );
  const jitterRange = exponential * config.jitter;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(exponential + jitterOffset));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDeliveryManager(
  deps: DeliveryManagerDeps,
  config?: Partial<DeliveryManagerConfig>,
): DeliveryManager {
  const cfg: DeliveryManagerConfig = { ...DELIVERY_DEFAULTS, ...config };
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  // let: toggled once by dispose() to prevent timer callbacks from running
  let disposed = false;

  function scheduleRetry(sessionId: string, frame: PendingFrame): void {
    const delay = calculateBackoffDelay(frame.retryCount, cfg);
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (disposed) return;
      replaySingleFrame(sessionId, frame).catch((e: unknown) => {
        deps.emit("pending_frame_dead_letter", {
          frameId: frame.frameId,
          sessionId,
          agentId: frame.agentId,
          retryCount: frame.retryCount,
          error: e,
        });
      });
    }, delay);
    pendingTimers.add(timer);
  }

  async function replaySingleFrame(sessionId: string, frame: PendingFrame): Promise<void> {
    const now = Date.now();

    // TTL expired?
    if (frame.ttl !== undefined && frame.createdAt + frame.ttl < now) {
      deps.emit("pending_frame_expired", {
        frameId: frame.frameId,
        sessionId,
        agentId: frame.agentId,
      });
      await deps.store.removePendingFrame(frame.frameId);
      return;
    }

    // Max retries exceeded?
    if (frame.retryCount >= cfg.maxRetries) {
      deps.emit("pending_frame_dead_letter", {
        frameId: frame.frameId,
        sessionId,
        agentId: frame.agentId,
        retryCount: frame.retryCount,
      });
      await deps.store.removePendingFrame(frame.frameId);
      return;
    }

    // Transport connected? Send it.
    if (deps.isConnected()) {
      try {
        deps.sendFrame(frame);
        deps.emit("pending_frame_sent", {
          frameId: frame.frameId,
          sessionId,
          agentId: frame.agentId,
        });
        await deps.store.removePendingFrame(frame.frameId);
      } catch (e: unknown) {
        deps.emit("pending_frame_dead_letter", {
          frameId: frame.frameId,
          sessionId,
          agentId: frame.agentId,
          retryCount: frame.retryCount + 1,
          error: e instanceof Error ? e.message : String(e),
        });
        const updated: PendingFrame = { ...frame, retryCount: frame.retryCount + 1 };
        await deps.store.savePendingFrame(updated);
        scheduleRetry(sessionId, updated);
      }
      return;
    }

    // Transport not connected — increment retryCount and schedule retry
    const updated: PendingFrame = { ...frame, retryCount: frame.retryCount + 1 };
    await deps.store.savePendingFrame(updated);
    scheduleRetry(sessionId, updated);
  }

  async function replayPendingFrames(sessionId: string): Promise<void> {
    const loadResult = await deps.store.loadPendingFrames(sessionId);
    if (!loadResult.ok) return;

    const frames = loadResult.value;
    if (frames.length === 0) return;

    const startTime = Date.now();
    for (const frame of frames) {
      // Time budget: stop processing and defer remaining to next cycle
      if (cfg.maxRecoveryMs > 0 && Date.now() - startTime >= cfg.maxRecoveryMs) {
        break;
      }
      await replaySingleFrame(sessionId, frame);
    }
  }

  function dispose(): void {
    disposed = true;
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  }

  async function enqueueSend(frame: NodeFrame, sessionId: string): Promise<void> {
    const pendingFrame: PendingFrame = {
      frameId: `pf-${frame.correlationId}`,
      sessionId,
      agentId: toAgentId(frame.agentId),
      frameType: frame.type,
      payload: frame.payload,
      orderIndex: Date.now(),
      createdAt: Date.now(),
      ttl: frame.ttl,
      retryCount: 0,
    };

    // Write-ahead: persist before sending
    const saveResult = await deps.store.savePendingFrame(pendingFrame);
    if (!saveResult.ok) {
      // Fallback: degrade to direct send (current behavior) rather than silent loss
      deps.sendFrame(pendingFrame);
      return;
    }

    // If connected, attempt immediate delivery
    if (deps.isConnected()) {
      try {
        deps.sendFrame(pendingFrame);
        deps.emit("pending_frame_sent", {
          frameId: pendingFrame.frameId,
          sessionId,
          agentId: pendingFrame.agentId,
        });
        await deps.store.removePendingFrame(pendingFrame.frameId);
      } catch (e: unknown) {
        deps.emit("pending_frame_dead_letter", {
          frameId: pendingFrame.frameId,
          sessionId,
          agentId: pendingFrame.agentId,
          retryCount: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // If not connected, frame stays in store for replayPendingFrames on reconnect
  }

  return { replayPendingFrames, enqueueSend, dispose };
}
