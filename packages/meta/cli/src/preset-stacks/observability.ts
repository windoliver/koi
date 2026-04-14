/**
 * Observability preset stack — trajectory recording, semantic retry,
 * hook observation, and OpenTelemetry.
 *
 * This stack owns every piece of "what happened and when" infrastructure:
 *
 *   - Trajectory store: in-memory ATIF document store backing `/trajectory`
 *     view, decision-ledger lookups, and rewind audit trails. Capped at
 *     `MAX_TRAJECTORY_STEPS` to match the view cap.
 *   - Event-trace middleware: records each model/tool I/O as an ATIF step.
 *   - Semantic retry: retries model calls on transient errors; the
 *     signal broker is shared between the reader (event-trace) and
 *     writer (semantic-retry middleware).
 *   - Hook observer: a synchronous tap the hook registry calls after
 *     every hook dispatch, recording hook executions as ATIF steps.
 *     Contributed via `hookExtras.onExecuted` so the factory's main
 *     hook middleware wires it automatically.
 *   - OpenTelemetry: optional span emission — enabled via config.otel.
 *     Threaded into event-trace as `onStep` so every ATIF step also
 *     produces an OTel span without double-wrapping.
 *
 * Exports (well-known keys on `StackContribution.exports`):
 *   - `trajectoryStore`   — for wrapMiddlewareWithTrace + factory
 *                           `getTrajectorySteps` / `appendTrajectoryStep`
 *   - `otelHandle`        — for the factory to thread through spawn
 *                           child adapters (future)
 *   - `trajectoryDocId`   — stable document id so the factory's trace
 *                           wrapper writes under the same doc
 *
 * Lifecycle:
 *   - `onResetSession` — prunes the trajectory document so the new
 *     session starts with an empty /trajectory view.
 */

import { createEventTraceMiddleware, createInMemoryAtifDocumentStore } from "@koi/event-trace";
import type { OtelMiddlewareConfig } from "@koi/middleware-otel";
import { createOtelMiddleware } from "@koi/middleware-otel";
import {
  createRetrySignalBroker,
  createSemanticRetryMiddleware,
} from "@koi/middleware-semantic-retry";
import { createHookObserver } from "@koi/runtime";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

/** Maximum trajectory steps retained in the in-memory store. */
export const MAX_TRAJECTORY_STEPS = 200;

/** Document ID used for session trajectory storage. */
const TRAJECTORY_DOC_ID = "koi-session";

/**
 * Key under `StackActivationContext.host` where hosts pass their
 * `OtelMiddlewareConfig | true | false | undefined` setting. When
 * `true`, defaults are used; an object is passed verbatim.
 */
export const OTEL_CONFIG_HOST_KEY = "otelConfig";

/** Export keys — hosts / other stacks read these off `exports`. */
export const OBSERVABILITY_EXPORTS = {
  trajectoryStore: "trajectoryStore",
  otelHandle: "otelHandle",
  trajectoryDocId: "trajectoryDocId",
} as const;

type OtelConfigSetting = OtelMiddlewareConfig | true | false | undefined;

export const observabilityStack: PresetStack = {
  id: "observability",
  description: "Trajectory store + event-trace + semantic-retry + hook observer + optional OTel",
  activate: (ctx): StackContribution => {
    const trajectoryStore = createInMemoryAtifDocumentStore({
      agentName: ctx.hostId,
      agentVersion: "0.1.0",
      maxSteps: MAX_TRAJECTORY_STEPS,
    });

    // Semantic retry broker — created before event-trace so event-trace
    // can read retry signals and include them in trajectory metadata.
    const retryBroker = createRetrySignalBroker();

    // Optional OTel handle — wired before event-trace so event-trace
    // can fan each step out to OTel via the `onStep` tap.
    const rawOtelSetting = ctx.host?.[OTEL_CONFIG_HOST_KEY] as OtelConfigSetting;
    const otelConfig: OtelMiddlewareConfig | undefined =
      rawOtelSetting === true
        ? {}
        : rawOtelSetting !== undefined && rawOtelSetting !== false
          ? rawOtelSetting
          : undefined;
    const otelHandle = otelConfig !== undefined ? createOtelMiddleware(otelConfig) : undefined;

    const { middleware: eventTraceMw } = createEventTraceMiddleware({
      store: trajectoryStore,
      docId: TRAJECTORY_DOC_ID,
      agentName: ctx.hostId,
      agentVersion: "0.1.0",
      signalReader: retryBroker,
      ...(otelHandle !== undefined ? { onStep: otelHandle.onStep } : {}),
    });

    const { middleware: semanticRetryMw } = createSemanticRetryMiddleware({
      signalWriter: retryBroker,
    });

    // Hook observer: tap + middleware pair. The tap is contributed via
    // `hookExtras.onExecuted` so the factory-built hook middleware fires
    // it; the middleware itself is appended to the trace stack to
    // produce a dedicated span for the observer layer.
    const { onExecuted: hookObserverTap, middleware: hookObserverMw } = createHookObserver({
      store: trajectoryStore,
      docId: TRAJECTORY_DOC_ID,
    });

    return {
      middleware: [
        eventTraceMw,
        semanticRetryMw,
        hookObserverMw,
        ...(otelHandle !== undefined ? [otelHandle.middleware] : []),
      ],
      providers: [],
      hookExtras: {
        onExecuted: hookObserverTap,
      },
      exports: {
        [OBSERVABILITY_EXPORTS.trajectoryStore]: trajectoryStore,
        [OBSERVABILITY_EXPORTS.trajectoryDocId]: TRAJECTORY_DOC_ID,
        ...(otelHandle !== undefined ? { [OBSERVABILITY_EXPORTS.otelHandle]: otelHandle } : {}),
      },
      onResetSession: async () => {
        // Prune the trajectory document so the new session's
        // /trajectory view starts empty. Best-effort: a failing
        // prune must not block the reset pipeline. Uses the
        // future-prune trick (cutoff beyond now) to drop everything.
        try {
          await trajectoryStore.prune(Date.now() + 86_400_000);
        } catch {
          /* trajectory prune is best-effort on reset */
        }
      },
    };
  },
};
