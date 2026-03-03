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
  /** Agent that made the observation. */
  readonly agentId: string;
  /** Jaccard distance vs the brick's stated purpose (0-1). */
  readonly divergenceScore: number;
  readonly observedAt: number;
}
