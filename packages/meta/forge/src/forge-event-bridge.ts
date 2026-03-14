/**
 * Forge event bridge — translates forge middleware callbacks into
 * ForgeDashboardEvent SSE events with microtask-batched delivery.
 *
 * Pure mapping layer: no side effects beyond calling onDashboardEvent.
 * Error handling: every callback is wrapped in try/catch to prevent
 * bridge failures from disrupting forge middleware execution.
 */

import type { BrickArtifact, ForgeDemandSignal } from "@koi/core";
import type { CrystallizationCandidate, CrystallizedToolDescriptor } from "@koi/crystallize";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { OptimizationResult } from "@koi/forge-optimizer";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeEventBridgeConfig {
  readonly onDashboardEvent: (events: readonly ForgeDashboardEvent[]) => void;
  readonly onBridgeError?: ((error: unknown) => void) | undefined;
  readonly clock?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Bridge handle
// ---------------------------------------------------------------------------

export interface ForgeEventBridge {
  readonly onCandidatesDetected: (candidates: readonly CrystallizationCandidate[]) => void;
  readonly onDemand: (signal: ForgeDemandSignal) => void;
  readonly onForged: (descriptor: CrystallizedToolDescriptor) => void;
  readonly onDemandForged: (signal: ForgeDemandSignal, brick: BrickArtifact) => void;
  readonly onPolicyPromotion: (brickId: string, result: OptimizationResult) => void;
  readonly onQuarantine: (brickId: string) => void;
  readonly onFitnessFlush: (brickId: string, successRate: number, sampleCount: number) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createForgeEventBridge(config: ForgeEventBridgeConfig): ForgeEventBridge {
  const clock = config.clock ?? Date.now;
  const pending: ForgeDashboardEvent[] = [];
  let flushScheduled = false;

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (pending.length === 0) return;
      const batch = [...pending];
      pending.length = 0;
      try {
        config.onDashboardEvent(batch);
      } catch (err: unknown) {
        config.onBridgeError?.(err);
      }
    });
  }

  function emit(event: ForgeDashboardEvent): void {
    pending.push(event);
    scheduleFlush();
  }

  function safe<A extends readonly unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      try {
        fn(...args);
      } catch (err: unknown) {
        config.onBridgeError?.(err);
      }
    };
  }

  return {
    onCandidatesDetected: safe((candidates: readonly CrystallizationCandidate[]) => {
      for (const c of candidates) {
        emit({
          kind: "forge",
          subKind: "crystallize_candidate",
          ngramKey: c.ngram.key,
          occurrences: c.occurrences,
          suggestedName: c.suggestedName,
          score: c.score ?? 0,
          timestamp: clock(),
        });
      }
    }),

    onDemand: safe((signal: ForgeDemandSignal) => {
      emit({
        kind: "forge",
        subKind: "demand_detected",
        signalId: signal.id,
        triggerKind: signal.trigger.kind,
        confidence: signal.confidence,
        suggestedBrickKind: signal.suggestedBrickKind,
        timestamp: clock(),
      });
    }),

    onForged: safe((descriptor: CrystallizedToolDescriptor) => {
      emit({
        kind: "forge",
        subKind: "brick_forged",
        brickId: descriptor.name,
        name: descriptor.name,
        origin: "crystallize",
        ngramKey: descriptor.provenance.ngramKey,
        occurrences: descriptor.provenance.occurrences,
        score: descriptor.provenance.score,
        timestamp: clock(),
      });
    }),

    onDemandForged: safe((signal: ForgeDemandSignal, brick: BrickArtifact) => {
      emit({
        kind: "forge",
        subKind: "brick_demand_forged",
        brickId: brick.id,
        name: brick.name,
        triggerId: signal.id,
        triggerKind: signal.trigger.kind,
        confidence: signal.confidence,
        timestamp: clock(),
      });
    }),

    onPolicyPromotion: safe((brickId: string, result: OptimizationResult) => {
      if (result.action === "deprecate") {
        emit({
          kind: "forge",
          subKind: "brick_deprecated",
          brickId,
          reason: result.reason,
          fitnessOriginal: result.fitnessOriginal,
          timestamp: clock(),
        });
      } else if (result.action === "promote_to_policy") {
        emit({
          kind: "forge",
          subKind: "brick_promoted",
          brickId,
          fitnessOriginal: result.fitnessOriginal,
          timestamp: clock(),
        });
      }
    }),

    onQuarantine: safe((brickId: string) => {
      emit({
        kind: "forge",
        subKind: "brick_quarantined",
        brickId,
        timestamp: clock(),
      });
    }),

    onFitnessFlush: safe((brickId: string, successRate: number, sampleCount: number) => {
      emit({
        kind: "forge",
        subKind: "fitness_flushed",
        brickId,
        successRate,
        sampleCount,
        timestamp: clock(),
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Monitor event bridge (Phase 7 — Option A)
// ---------------------------------------------------------------------------

/**
 * Anomaly signal shape — matches @koi/agent-monitor's AnomalySignal base fields.
 * Declared here to avoid importing from @koi/agent-monitor (which is not a dependency).
 */
export interface AnomalySignalLike {
  readonly kind: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly turnIndex: number;
  readonly [key: string]: unknown;
}

export interface MonitorEventBridgeConfig {
  readonly onDashboardEvent: (event: MonitorDashboardEvent) => void;
  readonly onBridgeError?: ((error: unknown) => void) | undefined;
  readonly clock?: (() => number) | undefined;
}

/**
 * Wraps an existing onAnomaly callback to also emit MonitorDashboardEvent.
 * Use at the BuiltinCallbacks wiring site:
 *
 * ```ts
 * const monitorBridge = createMonitorEventBridge({ onDashboardEvent: sink });
 * createDefaultRegistry({
 *   "agent-monitor": { onAnomaly: monitorBridge.wrapOnAnomaly(existingHandler) },
 * });
 * ```
 */
export function createMonitorEventBridge(config: MonitorEventBridgeConfig): {
  readonly wrapOnAnomaly: <T extends AnomalySignalLike>(
    existing?: ((signal: T) => void | Promise<void>) | undefined,
  ) => (signal: T) => void;
} {
  const clock = config.clock ?? Date.now;

  return {
    wrapOnAnomaly:
      <T extends AnomalySignalLike>(existing?: ((signal: T) => void | Promise<void>) | undefined) =>
      (signal: T): void => {
        // Forward to existing handler first
        if (existing !== undefined) {
          existing(signal);
        }

        // Emit dashboard event
        const { kind: _anomalyKind, agentId, sessionId, ...rest } = signal;
        try {
          config.onDashboardEvent({
            kind: "monitor",
            subKind: "anomaly_detected",
            anomalyKind: signal.kind,
            agentId,
            sessionId: sessionId as string,
            detail: rest as Readonly<Record<string, unknown>>,
            timestamp: clock(),
          });
        } catch (err: unknown) {
          config.onBridgeError?.(err);
        }
      },
  };
}
