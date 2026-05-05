/**
 * Exaptation detection types — purpose drift signal system.
 *
 * Defines the signal and observation types for detecting when bricks
 * (tools, skills, agents) are used beyond their original purpose.
 * When multiple agents repurpose a tool, that's a signal to generalize
 * the interface or forge a new specialized brick.
 */

// ---------------------------------------------------------------------------
// Exaptation kind — discriminated union of detection signal types
// ---------------------------------------------------------------------------

/** The kind of exaptation detected. */
export type ExaptationKind = "purpose_drift" | "interface_pressure" | "convergent_need";

// ---------------------------------------------------------------------------
// Signal — emitted when purpose drift detected (fat, self-contained)
// ---------------------------------------------------------------------------

/** Signal emitted by the exaptation detector when purpose drift is detected. */
export interface ExaptationSignal {
  readonly id: string;
  readonly kind: "exaptation";
  readonly exaptationKind: ExaptationKind;
  readonly brickId: string;
  readonly brickName: string;
  /** Confidence score (0-1) that exaptation is genuine. */
  readonly confidence: number;
  /** The brick's original stated description. */
  readonly statedPurpose: string;
  /** Top-N divergent usage contexts observed (bounded). */
  readonly observedContexts: readonly string[];
  /** Jaccard distance between stated purpose and observed usage (0-1). */
  readonly divergenceScore: number;
  /** Number of distinct agents showing purpose drift. */
  readonly agentCount: number;
  readonly emittedAt: number;
}

// ---------------------------------------------------------------------------
// Usage observation — raw observation stored in ring buffer
// ---------------------------------------------------------------------------

/** Raw usage observation recording how a brick was used vs its stated purpose. */
export interface UsagePurposeObservation {
  /** Truncated model response text preceding the tool call. */
  readonly contextText: string;
  /**
   * Tenant / account / realm namespace. Required, not optional — the
   * exaptation detector keys both replay dedup and cohort attribution on
   * `(scope, agentId, ...)`, so providing scope is what guarantees runtime
   * tenant isolation. Single-tenant deployments may use a constant value
   * (e.g. `"default"`); the field exists to force every emitter to make a
   * conscious choice rather than rely on `agentId` formatting conventions.
   *
   * Whitespace-only values are treated as missing and the observation is
   * dropped. There is no implicit "global" scope — that is exactly the
   * silent-merge failure mode this field exists to prevent.
   */
  readonly scope: string;
  /** Agent that made the observation, identified within `scope`. */
  readonly agentId: string;
  /** Jaccard distance vs the brick's stated purpose (0-1). */
  readonly divergenceScore: number;
  readonly observedAt: number;
  /**
   * Optional **per-observation idempotency key**. Must be a *deterministic*
   * function of stable per-observation identity — NOT a request-level
   * correlation ID, NOT an upstream causal event ID shared by multiple
   * agents handling the same fan-out, NOT an account-level identifier, and
   * NOT a freshly-generated nonce/UUID at emission time (random values mint
   * a new key on every retry, defeating replay dedup).
   *
   * Required properties:
   *
   *   - **Idempotent under retry.** If the same observation is re-emitted
   *     (e.g. at-least-once delivery, transport replay), the function MUST
   *     produce the same `eventId`. Derive it from inputs that don't change
   *     across retries: e.g. `sha256(agentId + ":" + toolCallId)` where
   *     `toolCallId` is a stable upstream identifier of the originating
   *     tool invocation.
   *   - **Distinct per observation.** Different tool calls within one
   *     request, multiple agents recording the same upstream event, and
   *     observations from different tenants must produce DIFFERENT keys.
   *
   * Empty / whitespace-only / missing values are treated as "no key" and
   * disable replay protection for the window. When every observation in a
   * window carries a non-empty `eventId`, the exaptation detector marks the
   * window `replayProtected: true` and allows action-bearing suggestions
   * (`reclassify` / `new-artifact`). Otherwise such suggestions are
   * refused. Unlike a free-form key function, this field is a data-shape
   * contract the detector validates at runtime.
   */
  readonly eventId?: string;
}
