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
  /**
   * Zone B: ordered, user-controlled middleware resolved from
   * `manifest.middleware`. Composed **inside** the security core
   * layers — hook, permissions, and exfiltration-guard always wrap
   * zone B from the outside so repo-authored manifests cannot
   * observe or persist raw request/response data before the
   * security layers have a chance to gate or redact it.
   *
   * Order within zone B is authoritative: it reflects the declared
   * order in the manifest, with `enabled: false` entries already
   * dropped. Core security layer names are rejected by the manifest
   * loader, so zone B can never reorder or replace them.
   */
  readonly manifestMiddleware?: readonly KoiMiddleware[] | undefined;
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
 * Order (outermost → innermost), with the three-zone model:
 *   [zone A]  presetExtras[0..]        — code-owned stacks (trusted)
 *   [zone C-top]
 *             hook                     — required
 *             permissions              — required (terminal-capable)
 *             exfiltrationGuard        — required (terminal-capable)
 *   [zone B]  manifestMiddleware[0..]  — user-controlled, runs INSIDE
 *                                         the security guard so it
 *                                         only sees already-gated and
 *                                         already-redacted traffic
 *   [zone C-bottom]
 *             modelRouter?
 *             goal?
 *             systemPrompt?
 *             sessionTranscript?
 *
 * Zone A sits outermost because it is code-owned (observability,
 * checkpoint, rules-loader) and is trusted to see raw traffic for
 * tracing purposes. Users cannot add to zone A via manifest.
 *
 * The critical security invariant: `hook`, `permissions`, and
 * `exfiltration-guard` MUST wrap zone B from the outside. Zone B is
 * repo-authored content, so any middleware declared there runs only
 * after the guard has gated the tool call and redacted any secrets
 * from the model request/response. This prevents an attacker who
 * can commit to `koi.yaml` from adding a middleware that logs raw
 * prompts or tool inputs before the guard runs.
 *
 * Zone C-bottom (modelRouter/goal/systemPrompt/sessionTranscript)
 * sits innermost because those layers need to be the last thing
 * touching the model payload: modelRouter routes the final call,
 * systemPrompt injects the final instructions, sessionTranscript
 * records the final post-middleware state.
 */
export function composeRuntimeMiddleware(
  input: MiddlewareCompositionInput,
): readonly KoiMiddleware[] {
  return [
    // Zone A — code-owned preset stacks wrap the entire chain.
    ...(input.presetExtras ?? []),
    // Zone C-top — required security layers wrap zone B from the
    // outside. Order preserved from the pre-zone-B design.
    input.hook,
    input.permissions,
    input.exfiltrationGuard,
    // Zone B — manifest-declared middleware, in declared order.
    // Runs INSIDE the security guard so repo-authored content
    // cannot observe or persist raw request/response data.
    ...(input.manifestMiddleware ?? []),
    // Zone C-bottom — optional innermost layers.
    ...(input.modelRouter !== undefined ? [input.modelRouter] : []),
    ...(input.goal !== undefined ? [input.goal] : []),
    ...(input.systemPrompt !== undefined ? [input.systemPrompt] : []),
    ...(input.sessionTranscript !== undefined ? [input.sessionTranscript] : []),
  ];
}

/**
 * Build the middleware list that spawned child agents inherit from
 * the parent runtime. Children always see the security guard plus
 * the parent's systemPrompt.
 *
 * Zone B (manifest-declared middleware) is INTENTIONALLY NOT
 * inherited. The parent's zone B instances carry mutable per-session
 * state: `@koi/middleware-audit` for example holds a shared queue
 * and a hash-chained signing handle. Passing those instances to a
 * child would interleave events from two runtimes through one
 * queue, corrupting audit ordering and the hash chain. The correct
 * long-term fix is to store the manifest entries + registry in the
 * spawn context and re-resolve fresh instances per child runtime;
 * that requires changes to `createSpawnToolProvider` in the engine
 * layer and is tracked as a follow-up.
 *
 * For this release the CLI logs a warning at runtime assembly when
 * zone B is non-empty AND the spawn stack is active, so operators
 * know their manifest policy does not apply to delegated work.
 *
 * Order mirrors the parent chain structure minus zone B:
 *   permissions → exfiltration-guard → hook → systemPrompt?
 *
 * Exports / lifecycle / optional innermost (modelRouter, goal,
 * sessionTranscript) are NOT inherited — they are per-runtime state
 * that does not make sense to share with a child agent.
 *
 * Exported so it can be unit-tested independently of the full
 * runtime factory; `runtime-factory.ts` is the only production
 * caller.
 */
export function buildInheritedMiddlewareForChildren(input: {
  readonly permissions: KoiMiddleware;
  readonly exfiltrationGuard: KoiMiddleware;
  readonly hook: KoiMiddleware;
  readonly systemPrompt?: KoiMiddleware | undefined;
}): readonly KoiMiddleware[] {
  return [
    input.permissions,
    input.exfiltrationGuard,
    input.hook,
    ...(input.systemPrompt !== undefined ? [input.systemPrompt] : []),
  ];
}
