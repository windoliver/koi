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
  // --- Always-on core layers ---
  // These are the middleware that ALL hosts run unconditionally,
  // regardless of which preset stacks are active. Everything else —
  // observability, checkpoint, memory extraction's upstream
  // semanticRetry, etc. — lives in preset stacks and plugs in via
  // `presetExtras`.

  /** Hook dispatch: runs user-defined command/http hooks on lifecycle events. */
  readonly hook: KoiMiddleware;
  /** Permission backend gating: default-mode rules or auto-allow pattern. */
  readonly permissions: KoiMiddleware;
  /** Secret exfiltration guard: scans tool inputs and model outputs for leaks. */
  readonly exfiltrationGuard: KoiMiddleware;

  // --- Optional layers ---

  /**
   * Model-router middleware (innermost model-call interceptor). When
   * set, routes each retry attempt through the provider failover
   * chain independently so retries benefit from fallback.
   */
  readonly modelRouter?: KoiMiddleware | undefined;
  /** Goal reminder middleware — injected when the host supplies objectives. */
  readonly goal?: KoiMiddleware | undefined;
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
 *   presetExtras[0..] (stacks contribute here) → hook →
 *   permissions → exfiltrationGuard → extraction → modelRouter? →
 *   goal? → systemPrompt? → sessionTranscript?
 *
 * Observability (event-trace, semantic-retry, hook-observer, OTel),
 * checkpoint, and rules-loader live in preset stacks and flow in
 * through `presetExtras` at the outermost layer so they wrap the
 * entire core chain below them.
 *
 * The outermost layer wraps every inner layer, so event-trace sees
 * the entire middleware stack and session-transcript sees the
 * final payload the model actually received.
 */
export function composeRuntimeMiddleware(
  input: MiddlewareCompositionInput,
): readonly KoiMiddleware[] {
  return [
    // Preset stacks contribute at the outermost layer so observability,
    // checkpoint, rules-loader etc. wrap the entire core chain below.
    ...(input.presetExtras ?? []),
    input.hook,
    input.permissions,
    input.exfiltrationGuard,
    ...(input.modelRouter !== undefined ? [input.modelRouter] : []),
    ...(input.goal !== undefined ? [input.goal] : []),
    ...(input.systemPrompt !== undefined ? [input.systemPrompt] : []),
    ...(input.sessionTranscript !== undefined ? [input.sessionTranscript] : []),
  ];
}
