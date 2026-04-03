/**
 * Generic failure detection contract.
 *
 * Satisfied by semantic-retry's FailureAnalyzer.classify and
 * agent-monitor's check*() detectors.
 */

export interface FailureDetector<TInput, TOutput> {
  /**
   * Inspect `input` and return a detection result, or null if no anomaly.
   * May be sync (threshold check) or async (ML scorer).
   */
  readonly detect: (input: TInput) => TOutput | null | Promise<TOutput | null>;
}
