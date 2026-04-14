/**
 * Runtime middleware composer.
 *
 * Ported from v1's `archive/v1/packages/meta/cli/src/compose-middleware.ts`
 * pattern: a standalone, reusable function that takes a tagged input
 * record and returns the canonical ordered middleware list. Both the
 * shared `createKoiRuntime` factory and any future host-specific factory
 * can call it with different inputs and get a consistent, reviewable
 * composition.
 *
 * Why a tagged record instead of a positional argument list:
 *   - Optional slots (modelRouter, goal, otel) stay `undefined`-friendly
 *     without `null`-sentinel gymnastics at the call site.
 *   - Adding a new slot doesn't silently shift existing arguments.
 *   - The field names document the canonical middleware layer vocabulary.
 *
 * The ordering here is the single source of truth. Do not splice
 * middleware into this list from outside — callers that want to add
 * host-specific middleware pass them via `presetExtras`, which is
 * appended at a stable position between the core chain and the
 * system-prompt / session-transcript innermost layer.
 */

import type { KoiMiddleware } from "@koi/core";

export interface MiddlewareCompositionInput {
  // --- Always-on layers (outermost → innermost) ---

  /** Observability: records model/tool I/O as ATIF trajectory steps. */
  readonly eventTrace: KoiMiddleware;
  /** Hook dispatch: runs user-defined command/http hooks on lifecycle events. */
  readonly hook: KoiMiddleware;
  /** Trace tap for the hook registry — records hook executions as ATIF steps. */
  readonly hookObserver: KoiMiddleware;
  /** Hierarchical rule injection: CLAUDE.md / AGENTS.md / .koi/context.md. */
  readonly rules: KoiMiddleware;
  /** Permission backend gating: default-mode rules or auto-allow pattern. */
  readonly permissions: KoiMiddleware;
  /** Secret exfiltration guard: scans tool inputs and model outputs for leaks. */
  readonly exfiltrationGuard: KoiMiddleware;
  /** Learning extraction: harvests structured takeaways from spawn tool results. */
  readonly extraction: KoiMiddleware;
  /** Semantic retry broker: retries model calls on transient errors. */
  readonly semanticRetry: KoiMiddleware;
  /** Checkpoint middleware: captures end-of-turn snapshots for /rewind. */
  readonly checkpoint: KoiMiddleware;

  // --- Optional layers ---

  /**
   * Model-router middleware (innermost model-call interceptor). When
   * set, routes each retry attempt through the provider failover
   * chain independently so retries benefit from fallback.
   */
  readonly modelRouter?: KoiMiddleware | undefined;
  /** Goal reminder middleware — injected when the host supplies objectives. */
  readonly goal?: KoiMiddleware | undefined;
  /** OpenTelemetry span emission — opt-in via KOI_OTEL_ENABLED or config.otel. */
  readonly otel?: KoiMiddleware | undefined;
  /**
   * Preset / plugin middleware contributed by stack activation. Appended
   * after the checkpoint layer so presets can observe the core stack
   * without interleaving with it. Order within the preset list is
   * caller-controlled (presets are expected to be order-independent).
   */
  readonly presetExtras?: readonly KoiMiddleware[] | undefined;
  /** System prompt injection — innermost so children can inherit it cleanly. */
  readonly systemPrompt?: KoiMiddleware | undefined;
  /**
   * Session transcript persistence — innermost so it records the final
   * tool/model exchanges after all other middleware has processed them.
   * Innermost placement means the JSONL file captures the exact payload
   * that reached the model, not the raw pre-middleware input.
   */
  readonly sessionTranscript?: KoiMiddleware | undefined;
}

/**
 * Compose the canonical middleware list in its production order.
 *
 * Order (outermost → innermost):
 *   eventTrace → hook → hookObserver → rules → permissions →
 *   exfiltrationGuard → extraction → semanticRetry → modelRouter? →
 *   goal? → otel? → checkpoint → presetExtras... → systemPrompt? →
 *   sessionTranscript?
 *
 * The outermost layer wraps every inner layer, so event-trace sees
 * the entire middleware stack and session-transcript sees the
 * final payload the model actually received.
 */
export function composeRuntimeMiddleware(
  input: MiddlewareCompositionInput,
): readonly KoiMiddleware[] {
  return [
    input.eventTrace,
    input.hook,
    input.hookObserver,
    input.rules,
    input.permissions,
    input.exfiltrationGuard,
    input.extraction,
    input.semanticRetry,
    ...(input.modelRouter !== undefined ? [input.modelRouter] : []),
    ...(input.goal !== undefined ? [input.goal] : []),
    ...(input.otel !== undefined ? [input.otel] : []),
    input.checkpoint,
    ...(input.presetExtras ?? []),
    ...(input.systemPrompt !== undefined ? [input.systemPrompt] : []),
    ...(input.sessionTranscript !== undefined ? [input.sessionTranscript] : []),
  ];
}
